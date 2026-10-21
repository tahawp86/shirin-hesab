//! موتور آپدیت v2 شیرین‌حساب — فید ثابت + دانلود قابل ادامه (Range) +
//! نصب با باینری کمکی جدا (ShirinHesabUpdater.exe).
//!
//! جریان: check_update2 (خواندن فید) → download_update2 (دانلود پس‌زمینه با
//! رویداد پیشرفت، قابل کنسل و ادامه، راستی‌آزمایی sha256 بسته و تک‌فایل‌ها)
//! → apply_update2 (استیج در pending_update + اجرای هلپر + خروج کامل اپ).
//! گزارش آپدیت قبلی از update_state.json/update_applied.json خوانده می‌شود.

use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};

pub const PROGRESS_EVENT: &str = "update-progress2";

/// بار رویداد پیشرفت دانلود (قرارداد فرانت v2)
#[derive(Debug, Clone, Serialize)]
struct UpdateProgress {
    percent: i64,
    downloaded: u64,
    total: u64,
}
const FEED_URL: &str =
    "https://github.com/tahawp86/shirin-hesab/releases/download/update-feed/update-feed.json";
const APP_ID: &str = "ShirinHesab";

// ---------- مقایسه‌ی نسخه (semver + پشتیبانی beta) ----------

/// "1.2.3-beta" → (1, 2, 3, false) — نسخه‌ی پایدار از هم‌شماره‌ی بتا بزرگ‌تر است
fn parse_version(v: &str) -> (u64, u64, u64, bool) {
    let v = v.trim().trim_start_matches('v');
    let (core, stable) = match v.split_once('-') {
        Some((c, _)) => (c, false),
        None => (v, true),
    };
    let mut it = core.split('.').map(|p| {
        p.chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse::<u64>()
            .unwrap_or(0)
    });
    (
        it.next().unwrap_or(0),
        it.next().unwrap_or(0),
        it.next().unwrap_or(0),
        stable,
    )
}

fn version_gt(a: &str, b: &str) -> bool {
    parse_version(a) > parse_version(b)
}

/// نسخه‌ی فعلی از version.txt کنار exe؛ نبودش یعنی نسخه‌ی کامپایل‌شده
pub fn current_version() -> String {
    if let Some(dir) = exe_dir() {
        if let Ok(text) = std::fs::read_to_string(dir.join("version.txt")) {
            if let Some(tok) = text.split_whitespace().next() {
                if !tok.is_empty() {
                    return tok.trim_start_matches('v').to_string();
                }
            }
        }
    }
    env!("CARGO_PKG_VERSION").to_string()
}

pub fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(|p| p.to_path_buf())
}

fn sha256_file(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).ok()?;
    Some(format!("{:x}", hasher.finalize()))
}

// ---------- فید آپدیت ----------

#[derive(Debug, Clone)]
struct FeedPackage {
    url: String,
    size: u64,
    sha256: String,
}

#[derive(Debug, Clone)]
struct Feed {
    version: String,
    published_at: String,
    notes_fa: String,
    mandatory: bool,
    min_version: String,
    full: Option<FeedPackage>,
    delta: Option<(String, FeedPackage)>, // (from, package)
    files: Vec<(String, String)>,          // (path, sha256)
}

fn parse_feed_package(o: &serde_json::Value) -> Option<FeedPackage> {
    Some(FeedPackage {
        url: o.get("url")?.as_str()?.to_string(),
        size: o
            .get("size")
            .and_then(|s| s.as_u64().or_else(|| s.as_f64().map(|f| f as u64)))
            .unwrap_or(0),
        sha256: o.get("sha256")?.as_str()?.to_string(),
    })
}

/// خواندن فید ثابت آپدیت — هر خطایی یعنی «آپدیتی نیست» (سکوت)
fn fetch_feed() -> Option<Feed> {
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
    let url = format!("{FEED_URL}?t={ts}");
    let resp = ureq::get(&url)
        .set("User-Agent", "ShirinHesab-Updater")
        .timeout(Duration::from_secs(12))
        .call()
        .ok()?;
    let text = resp.into_string().ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    if v.get("app")?.as_str()? != APP_ID {
        return None;
    }
    if v.get("channel").and_then(|c| c.as_str()).unwrap_or("stable") != "stable" {
        return None;
    }
    let packages = v.get("packages");
    let full = packages
        .and_then(|p| p.get("full"))
        .and_then(parse_feed_package);
    let delta = packages.and_then(|p| p.get("delta")).and_then(|d| {
        let from = d.get("from")?.as_str()?.to_string();
        parse_feed_package(d).map(|pkg| (from, pkg))
    });
    let mut files = Vec::new();
    if let Some(arr) = v.get("files").and_then(|f| f.as_array()) {
        for f in arr {
            if let (Some(p), Some(s)) = (
                f.get("path").and_then(|x| x.as_str()),
                f.get("sha256").and_then(|x| x.as_str()),
            ) {
                files.push((p.to_string(), s.to_string()));
            }
        }
    }
    Some(Feed {
        version: v.get("version")?.as_str()?.to_string(),
        published_at: v
            .get("published_at")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        notes_fa: v
            .get("notes_fa")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        mandatory: v
            .get("mandatory")
            .and_then(|x| x.as_bool())
            .unwrap_or(false),
        min_version: v
            .get("min_version")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        full,
        delta,
        files,
    })
}

/// انتخاب بسته: نسخه‌ی فعلی دقیقاً delta.from باشد → delta، وگرنه full
fn pick_package<'a>(feed: &'a Feed, current: &str) -> Option<(&'static str, &'a FeedPackage)> {
    if let Some((from, pkg)) = &feed.delta {
        if from == current {
            return Some(("delta", pkg));
        }
    }
    feed.full.as_ref().map(|p| ("full", p))
}

// ---------- وضعیت موتور ----------

#[derive(Debug, Clone)]
struct ReadyPackage {
    zip_path: PathBuf,
}

#[derive(Default)]
pub struct UpdateV2State {
    feed: Mutex<Option<Feed>>,
    ready: Mutex<Option<ReadyPackage>>,
    cancel: AtomicBool,
    downloading: AtomicBool,
}

/// اطلاعات نسخه‌ی جدید برای فرانت (خروجی check_update2)
#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo2 {
    pub version: String,
    pub notes_fa: String,
    pub published_at: String,
    pub mandatory: bool,
    pub min_version: String,
    pub package_kind: String, // "delta" | "full"
    pub size: u64,
}

// ---------- کامندها ----------

/// خواندن فید و مقایسه با نسخه‌ی فعلی — آپدیتی نباشد یا خطا باشد: None
#[tauri::command]
pub fn check_update2(state: State<'_, UpdateV2State>) -> Option<UpdateInfo2> {
    let feed = fetch_feed()?;
    let current = current_version();
    let info = if version_gt(&feed.version, &current) {
        pick_package(&feed, &current).map(|(kind, pkg)| UpdateInfo2 {
            version: feed.version.clone(),
            notes_fa: feed.notes_fa.clone(),
            published_at: feed.published_at.clone(),
            mandatory: feed.mandatory,
            min_version: feed.min_version.clone(),
            package_kind: kind.to_string(),
            size: pkg.size,
        })
    } else {
        None
    };
    *state.feed.lock().unwrap() = Some(feed);
    info
}

/// کنسل دانلود جاری — فایل .part می‌ماند تا دانلود بعدی از همان‌جا ادامه پیدا کند
#[tauri::command]
pub fn cancel_update_download2(state: State<'_, UpdateV2State>) {
    state.cancel.store(true, Ordering::SeqCst);
}

enum DlOutcome {
    Done,
    Cancelled,
}

/// دانلود یک فایل با قابلیت ادامه (Range) — پیشرفت روی رویداد update-progress
fn download_file(
    app: &AppHandle,
    url: &str,
    part_path: &Path,
    expected_size: u64,
    cancel: &AtomicBool,
) -> Result<DlOutcome, String> {
    let mut have: u64 = std::fs::metadata(part_path).map(|m| m.len()).unwrap_or(0);
    if expected_size > 0 {
        if have == expected_size {
            return Ok(DlOutcome::Done);
        }
        if have > expected_size {
            let _ = std::fs::remove_file(part_path);
            have = 0;
        }
    } else if have > 0 {
        // بدون سایز مرجع، ادامه‌دادن قابل اعتماد نیست
        let _ = std::fs::remove_file(part_path);
        have = 0;
    }
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(30))
        .build();
    // درخواست (با Range وقتی ادامه داریم) — 416 یعنی part کامل/نامعتبر است: از اول
    let resp = loop {
        let mut req = agent.get(url).set("User-Agent", "ShirinHesab-Updater");
        if have > 0 {
            req = req.set("Range", &format!("bytes={have}-"));
        }
        match req.call() {
            Ok(r) => break r,
            Err(ureq::Error::Status(416, _)) if have > 0 => {
                let _ = std::fs::remove_file(part_path);
                have = 0;
                continue;
            }
            Err(ureq::Error::Status(code, _)) => {
                return Err(format!("دانلود آپدیت ناموفق بود (خطای سرور {code})."))
            }
            Err(e) => return Err(format!("دانلود آپدیت ناموفق بود: {e}")),
        }
    };
    let status = resp.status();
    let mut file = if have > 0 && status == 206 {
        std::fs::OpenOptions::new()
            .append(true)
            .open(part_path)
            .map_err(|e| format!("باز کردن فایل موقت دانلود ناموفق بود: {e}"))?
    } else {
        // سرور Range را نادیده گرفت → از اول بنویس
        have = 0;
        std::fs::File::create(part_path)
            .map_err(|e| format!("ساخت فایل موقت دانلود ناموفق بود: {e}"))?
    };
    let total: u64 = if expected_size > 0 {
        expected_size
    } else {
        have + resp
            .header("content-length")
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0)
    };
    let mut reader = resp.into_reader();
    let mut buf = [0u8; 64 * 1024];
    let mut done_bytes = have;
    let mut last_pct: i64 = -1;
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = file.flush();
            return Ok(DlOutcome::Cancelled);
        }
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("دانلود آپدیت قطع شد: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("نوشتن فایل دانلود ناموفق بود: {e}"))?;
        done_bytes += n as u64;
        if total > 0 {
            let pct = ((done_bytes * 100) / total).min(100) as i64;
            if pct != last_pct {
                last_pct = pct;
                let _ = app.emit(
                    PROGRESS_EVENT,
                    UpdateProgress {
                        percent: pct,
                        downloaded: done_bytes,
                        total,
                    },
                );
            }
        }
    }
    file.flush()
        .map_err(|e| format!("ذخیره‌ی فایل دانلود ناموفق بود: {e}"))?;
    if expected_size > 0 && done_bytes < expected_size {
        return Err(
            "دانلود آپدیت ناتمام ماند؛ دوباره تلاش کنید تا از همان‌جا ادامه پیدا کند."
                .to_string(),
        );
    }
    Ok(DlOutcome::Done)
}

/// اعتبارسنجی ZIP: مانیفست (app + نسخه = نسخه‌ی فید) + تطبیق هش تک‌فایل‌ها با فید
fn validate_package(zip_path: &Path, feed: &Feed) -> Result<(), String> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("باز کردن بسته‌ی آپدیت ناموفق بود: {e}"))?;
    let mut ar = zip::ZipArchive::new(file)
        .map_err(|_| "بسته‌ی آپدیت خراب است (فایل ZIP خوانا نیست).".to_string())?;
    let manifest: serde_json::Value = {
        let mut entry = ar.by_name("update_info.json").map_err(|_| {
            "بسته‌ی آپدیت ناقص است: فایل update_info.json را ندارد.".to_string()
        })?;
        let mut s = String::new();
        entry
            .read_to_string(&mut s)
            .map_err(|e| format!("خواندن مانیفست بسته ناموفق بود: {e}"))?;
        serde_json::from_str(&s)
            .map_err(|_| "مانیفست داخل بسته‌ی آپدیت خراب است.".to_string())?
    };
    if manifest.get("app").and_then(|v| v.as_str()) != Some(APP_ID) {
        return Err("این بسته برای «شیرین‌حساب» نیست.".to_string());
    }
    if manifest.get("version").and_then(|v| v.as_str()) != Some(feed.version.as_str()) {
        return Err("نسخه‌ی داخل بسته با فید آپدیت هماهنگ نیست.".to_string());
    }
    for (path, sha) in &feed.files {
        let entry_name = format!("files/{path}");
        let mut entry = ar
            .by_name(&entry_name)
            .map_err(|_| format!("فایل «{path}» در بسته‌ی آپدیت نیست."))?;
        if !sha.is_empty() {
            let mut hasher = Sha256::new();
            let mut buf = [0u8; 64 * 1024];
            loop {
                let n = entry
                    .read(&mut buf)
                    .map_err(|e| format!("خواندن فایل «{path}» از بسته ناموفق بود: {e}"))?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
            }
            let h = format!("{:x}", hasher.finalize());
            if !h.eq_ignore_ascii_case(sha) {
                return Err(format!(
                    "هش فایل «{path}» با فید هماهنگ نیست؛ بسته خراب است."
                ));
            }
        }
    }
    Ok(())
}

/// دانلود پس‌زمینه‌ی بسته (قابل کنسل/ادامه) + راستی‌آزمایی کامل؛ آماده شد → ready
#[tauri::command]
pub fn download_update2(
    app: AppHandle,
    state: State<'_, UpdateV2State>,
) -> Result<(), String> {
    let feed = match state.feed.lock().unwrap().clone() {
        Some(f) => f,
        None => {
            let f = fetch_feed().ok_or_else(|| {
                "خواندن فید آپدیت ناموفق بود؛ اتصال اینترنت را بررسی کنید.".to_string()
            })?;
            *state.feed.lock().unwrap() = Some(f.clone());
            f
        }
    };
    let current = current_version();
    if !version_gt(&feed.version, &current) {
        return Err("نسخه‌ی جدیدی برای دانلود وجود ندارد.".to_string());
    }
    let (_, pkg) = pick_package(&feed, &current)
        .ok_or_else(|| "بسته‌ی آپدیت در فید تعریف نشده است.".to_string())?;
    let pkg = pkg.clone();
    if state.downloading.swap(true, Ordering::SeqCst) {
        return Err("دانلود آپدیت در حال انجام است.".to_string());
    }
    state.cancel.store(false, Ordering::SeqCst);
    let result = download_and_validate(&app, &state, &feed, &pkg);
    state.downloading.store(false, Ordering::SeqCst);
    match result {
        Ok(Some(zip_path)) => {
            *state.ready.lock().unwrap() = Some(ReadyPackage { zip_path });
            Ok(())
        }
        Ok(None) => Ok(()), // لغو شد — ساکت
        Err(e) => Err(e),
    }
}

/// دانلود + راستی‌آزمایی هش کل بسته با فید (خراب بود: یک بار از اول) + اعتبارسنجی ZIP
fn download_and_validate(
    app: &AppHandle,
    state: &UpdateV2State,
    feed: &Feed,
    pkg: &FeedPackage,
) -> Result<Option<PathBuf>, String> {
    let dir = std::env::temp_dir();
    let final_path = dir.join(format!("ShirinHesab-Update-v{}.zip", feed.version));
    let part_path = dir.join(format!("ShirinHesab-Update-v{}.zip.part", feed.version));
    for attempt in 1..=2 {
        match download_file(app, &pkg.url, &part_path, pkg.size, &state.cancel)? {
            DlOutcome::Cancelled => return Ok(None),
            DlOutcome::Done => {}
        }
        if final_path.exists() {
            let _ = std::fs::remove_file(&final_path);
        }
        std::fs::rename(&part_path, &final_path)
            .map_err(|e| format!("ذخیره‌ی بسته‌ی آپدیت ناموفق بود: {e}"))?;
        let hash = sha256_file(&final_path)
            .ok_or_else(|| "خواندن بسته‌ی دانلودشده ناموفق بود.".to_string())?;
        if pkg.sha256.is_empty() || hash.eq_ignore_ascii_case(&pkg.sha256) {
            break;
        }
        let _ = std::fs::remove_file(&final_path);
        if attempt == 2 {
            return Err(
                "بسته‌ی آپدیت دانلود شد ولی راستی‌آزمایی آن ناموفق بود (هش ناهماهنگ)؛ دوباره تلاش کنید."
                    .to_string(),
            );
        }
        // تلاش دوم از اول است: part با rename مصرف شده و فایل نهایی خراب هم پاک شد
    }
    validate_package(&final_path, feed)?;
    let final_len = std::fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0);
    let _ = app.emit(
        PROGRESS_EVENT,
        UpdateProgress {
            percent: 100,
            downloaded: final_len,
            total: final_len,
        },
    );
    Ok(Some(final_path))
}

// ---------- استیج و نصب با هلپر ----------

/// استخراج امن بسته به pending_update: ‏update_info.json در ریشه و files/ بدون پیشوند
fn extract_package(zip_path: &Path, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        std::fs::remove_dir_all(dest)
            .map_err(|e| format!("پاک‌کردن پوشه‌ی موقت آپدیت ناموفق بود: {e}"))?;
    }
    std::fs::create_dir_all(dest)
        .map_err(|e| format!("ساخت پوشه‌ی موقت آپدیت ناموفق بود: {e}"))?;
    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("باز کردن بسته‌ی آپدیت ناموفق بود: {e}"))?;
    let mut ar = zip::ZipArchive::new(file)
        .map_err(|_| "بسته‌ی آپدیت خراب است (فایل ZIP خوانا نیست).".to_string())?;
    for i in 0..ar.len() {
        let mut entry = ar
            .by_index(i)
            .map_err(|e| format!("خواندن بسته‌ی آپدیت ناموفق بود: {e}"))?;
        let name = entry.name().replace('\\', "/");
        if name.ends_with('/') {
            continue;
        }
        let rel: &str = if name == "update_info.json" {
            "update_info.json"
        } else if let Some(r) = name.strip_prefix("files/") {
            r
        } else {
            continue;
        };
        if rel.is_empty() {
            continue;
        }
        let rel_path = Path::new(rel);
        if rel_path
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
        {
            return Err("مسیر نامعتبر داخل بسته‌ی آپدیت.".to_string());
        }
        let out_path = dest.join(rel_path);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("ساخت پوشه‌ی مقصد آپدیت ناموفق بود: {e}"))?;
        }
        let mut out = std::fs::File::create(&out_path)
            .map_err(|e| format!("استخراج فایل آپدیت ناموفق بود: {e}"))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("استخراج فایل آپدیت ناموفق بود: {e}"))?;
    }
    Ok(())
}

#[cfg(windows)]
fn spawn_detached(
    cmd: &mut std::process::Command,
) -> std::io::Result<std::process::Child> {
    use std::os::windows::process::CommandExt;
    // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    cmd.creation_flags(0x0000_0008 | 0x0000_0200).spawn()
}

#[cfg(not(windows))]
fn spawn_detached(
    cmd: &mut std::process::Command,
) -> std::io::Result<std::process::Child> {
    cmd.spawn()
}

/// اجرای هلپر و دست‌دادن روی update.log — موفق که شد، اپ کامل خارج می‌شود
fn launch_helper(
    app: &AppHandle,
    install_dir: &Path,
    pending: &Path,
    helper: &Path,
) -> Result<(), String> {
    let exe_name = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "ShirinHesab.exe".to_string());
    let log_path = install_dir.join("update.log");
    let log_len_before = std::fs::metadata(&log_path).map(|m| m.len()).unwrap_or(0);
    let mut cmd = std::process::Command::new(helper);
    cmd.arg("--install")
        .arg(install_dir)
        .arg(pending)
        .arg(std::process::id().to_string())
        .arg(&exe_name)
        .current_dir(install_dir);
    let mut child =
        spawn_detached(&mut cmd).map_err(|e| format!("اجرای به‌روز‌رسان ناموفق بود: {e}"))?;
    // هلپر اولین کارش نوشتن «updater started» در لاگ است
    for _ in 0..30 {
        std::thread::sleep(Duration::from_millis(100));
        if let Ok(Some(_)) = child.try_wait() {
            break; // هلپر مُرد
        }
        if let Ok(bytes) = std::fs::read(&log_path) {
            if (bytes.len() as u64) > log_len_before {
                let new_part = &bytes[log_len_before as usize..];
                if String::from_utf8_lossy(new_part).contains("updater started") {
                    app.exit(0);
                    std::process::exit(0);
                }
            }
        }
    }
    let tail = std::fs::read(&log_path)
        .map(|b| {
            let s = String::from_utf8_lossy(&b).into_owned();
            let total = s.chars().count();
            s.chars()
                .skip(total.saturating_sub(1500))
                .collect::<String>()
        })
        .unwrap_or_default();
    Err(format!(
        "به‌روز‌رسان شروع به کار نکرد. انتهای گزارش:\n{tail}"
    ))
}

/// استیج بسته در pending_update + اجرای هلپر + خروج کامل اپ (مشترک: دانلودی و دستی)
fn stage_and_launch(app: &AppHandle, zip_path: &Path) -> Result<(), String> {
    let install_dir = exe_dir().ok_or_else(|| "مسیر نصب برنامه پیدا نشد.".to_string())?;
    let helper = install_dir.join("ShirinHesabUpdater.exe");
    if !helper.exists() {
        return Err(
            "فایل به‌روز‌رسان (ShirinHesabUpdater.exe) کنار برنامه نیست؛ نصب آپدیت ممکن نیست."
                .to_string(),
        );
    }
    let pending = install_dir.join("pending_update");
    extract_package(zip_path, &pending)?;
    launch_helper(app, &install_dir, &pending, &helper)
}

/// نصب بسته‌ی آماده‌ی دانلودشده
#[tauri::command]
pub fn apply_update2(app: AppHandle, state: State<'_, UpdateV2State>) -> Result<(), String> {
    let ready = state
        .ready
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "هنوز بسته‌ی آپدیتی دانلود و آماده نشده است.".to_string())?;
    stage_and_launch(&app, &ready.zip_path)
}

/// اعتبارسنجی بسته‌ی دستی (بدون فید): مانیفست + جهت نسخه + وجود و هش فایل‌ها
fn validate_local_package(zip_path: &Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("باز کردن فایل آپدیت ناموفق بود: {e}"))?;
    let mut ar = zip::ZipArchive::new(file)
        .map_err(|_| "فایل انتخاب‌شده بسته‌ی آپدیت معتبر نیست (ZIP خوانا نیست).".to_string())?;
    let manifest: serde_json::Value = {
        let mut entry = ar.by_name("update_info.json").map_err(|_| {
            "این فایل بسته‌ی آپدیت نیست: update_info.json ندارد.".to_string()
        })?;
        let mut s = String::new();
        entry
            .read_to_string(&mut s)
            .map_err(|e| format!("خواندن مانیفست بسته ناموفق بود: {e}"))?;
        serde_json::from_str(&s)
            .map_err(|_| "مانیفست داخل بسته‌ی آپدیت خراب است.".to_string())?
    };
    if manifest.get("app").and_then(|v| v.as_str()) != Some(APP_ID) {
        return Err("این بسته برای «شیرین‌حساب» نیست.".to_string());
    }
    let version = manifest
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if version.is_empty() {
        return Err("نسخه‌ی مقصد در مانیفست بسته نیست.".to_string());
    }
    if !version_gt(version, &current_version()) {
        return Err("نسخه‌ی این فایل از نسخه‌ی فعلی برنامه جدیدتر نیست.".to_string());
    }
    let files = manifest
        .get("files")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    for f in &files {
        let path = f.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let sha = f.get("sha256").and_then(|v| v.as_str()).unwrap_or("");
        if path.is_empty() {
            return Err("مانیفست بسته‌ی آپدیت ناقص است.".to_string());
        }
        let mut entry = ar
            .by_name(&format!("files/{path}"))
            .map_err(|_| format!("فایل «{path}» در بسته‌ی آپدیت نیست."))?;
        if !sha.is_empty() {
            let mut hasher = Sha256::new();
            let mut buf = [0u8; 64 * 1024];
            loop {
                let n = entry
                    .read(&mut buf)
                    .map_err(|e| format!("خواندن فایل «{path}» از بسته ناموفق بود: {e}"))?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
            }
            if !format!("{:x}", hasher.finalize()).eq_ignore_ascii_case(sha) {
                return Err(format!("هش فایل «{path}» ناهماهنگ است؛ بسته خراب است."));
            }
        }
    }
    Ok(())
}

/// دیالوگ انتخاب فایل آپدیت دستی — مسیر یا None (انصراف)
#[tauri::command]
pub fn open_update_file_dialog(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::{DialogExt, FilePath};
    match app
        .dialog()
        .file()
        .add_filter("بسته‌ی آپدیت", &["zip"])
        .blocking_pick_file()
    {
        Some(FilePath::Path(p)) => Some(p.to_string_lossy().into_owned()),
        _ => None,
    }
}

/// نصب آپدیت از فایل دستی: اعتبارسنجی + استیج + هلپر
#[tauri::command]
pub fn apply_local_update(app: AppHandle, path: String) -> Result<(), String> {
    validate_local_package(Path::new(&path))?;
    stage_and_launch(&app, Path::new(&path))
}

// ---------- گزارش آپدیت در استارت ----------

/// متن چنج‌لاگ بین دو نسخه از روی هدرهای ‎## X.Y.Z (تاریخ)‎ — سقف ۶۰۰۰ کاراکتر
fn changelog_between(content: &str, prev: &str, new: &str) -> String {
    let prev_t = parse_version(prev);
    let new_t = parse_version(new);
    let mut out = String::new();
    let mut include = false;
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            let ver = rest
                .split(|c: char| c.is_whitespace() || c == '(')
                .next()
                .unwrap_or("");
            let t = parse_version(ver);
            include = t > prev_t && t <= new_t;
            if include {
                out.push_str(line);
                out.push('\n');
            }
            continue;
        }
        if include {
            out.push_str(line);
            out.push('\n');
        }
    }
    let out = out.trim().to_string();
    if out.chars().count() > 6000 {
        out.chars().take(6000).collect()
    } else {
        out
    }
}

/// گزارش یک‌بارمصرف آپدیت قبلی: state و applied خوانده و پاک می‌شوند.
/// شکل خروجی دقیقاً قرارداد فرانت است:
/// موفق: {status:"ok", prev_version, new_version, changelog}
/// ناموفق: {status:"failed"|"rolled_back", detail}
#[tauri::command]
pub fn get_update_report() -> Option<serde_json::Value> {
    let dir = exe_dir()?;
    let state_path = dir.join("update_state.json");
    let applied_path = dir.join("update_applied.json");
    let state_raw = std::fs::read_to_string(&state_path).ok();
    let applied_raw = std::fs::read_to_string(&applied_path).ok();
    let _ = std::fs::remove_file(&state_path);
    let _ = std::fs::remove_file(&applied_path);
    let state: serde_json::Value = serde_json::from_str(state_raw.as_deref()?).ok()?;
    let status = state
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if status.is_empty() {
        return None;
    }
    if status == "ok" {
        let (mut prev, mut newv) = (String::new(), String::new());
        if let Some(ar) = applied_raw {
            if let Ok(av) = serde_json::from_str::<serde_json::Value>(&ar) {
                prev = av
                    .get("prev_version")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                newv = av
                    .get("new_version")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
            }
        }
        let changelog = std::fs::read_to_string(dir.join("CHANGELOG_FA.md"))
            .map(|content| changelog_between(&content, &prev, &newv))
            .unwrap_or_default();
        return Some(serde_json::json!({
            "status": "ok",
            "prev_version": prev,
            "new_version": newv,
            "changelog": changelog,
        }));
    }
    let detail = state
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Some(serde_json::json!({
        "status": status,
        "detail": detail,
    }))
}

// ---------- پاک‌سازی ‎.old‎ در استارت ----------

fn cleanup_old_in(dir: &Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                cleanup_old_in(&path);
            } else if path
                .extension()
                .map(|e| e == "old")
                .unwrap_or(false)
            {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

/// حذف فایل‌های ‎.old‎ باقی‌مانده از آپدیت قبلی (در استارت عادی برنامه)
pub fn cleanup_old_files() {
    if let Some(dir) = exe_dir() {
        cleanup_old_in(&dir);
    }
}
