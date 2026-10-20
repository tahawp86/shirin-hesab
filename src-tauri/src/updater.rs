// شیرین حساب — موتور آپدیت (مشابه IAS-CMS)
// چک از GitHub Releases، دانلود ZIP، اعتبارسنجی مانیفست، و اعمال درجا
// با اجرای مجدد همین exe در مد ‎`--apply-update`‎ (بکاپ + rollback).

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

const REPO: &str = "tahawp86/shirin-hesab";
const ASSET_PREFIX: &str = "ShirinHesab-Update-v";
const ASSET_SUFFIX: &str = ".zip";
const APP_ID: &str = "ShirinHesab";
const USER_AGENT: &str = "ShirinHesab-UpdateChecker";
/// رویداد پیشرفت دانلود برای فرانت — payload: درصد (عدد ۰ تا ۱۰۰)
pub const PROGRESS_EVENT: &str = "update-progress";

// ---------- نسخه‌ها ----------

/// کلید مقایسه‌ی نسخه: (major, minor, patch, stable) — stable از beta هم‌شماره جدیدتر است
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct VerKey(u32, u32, u32, u8);

fn parse_version(raw: &str) -> Option<VerKey> {
    let s = raw.trim().trim_start_matches('v');
    if s.is_empty() {
        return None;
    }
    let (core, stable) = match s.split_once('-') {
        Some((c, _)) => (c, 0u8),
        None => (s, 1u8),
    };
    let mut nums = [0u32; 3];
    for (i, part) in core.split('.').enumerate() {
        if i >= 3 {
            break;
        }
        nums[i] = part.parse().ok()?;
    }
    Some(VerKey(nums[0], nums[1], nums[2], stable))
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

fn exe_name() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "ShirinHesab.exe".to_string())
}

/// نسخه‌ی فعلی: اولین توکن ‎`version.txt`‎ کنار exe؛ اگر نبود نسخه‌ی کامپایل‌شده
pub fn current_version() -> String {
    if let Some(dir) = exe_dir() {
        if let Ok(content) = std::fs::read_to_string(dir.join("version.txt")) {
            if let Some(tok) = content.split_whitespace().next() {
                if !tok.is_empty() {
                    return tok.trim().to_string();
                }
            }
        }
    }
    env!("CARGO_PKG_VERSION").to_string()
}

// ---------- چک آپدیت ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub version: String,
    pub download_url: String,
    pub notes: String,
    pub published_at: String,
}

/// هر خطا = None (سکوت کامل)
fn check_update_blocking() -> Option<UpdateInfo> {
    let current = parse_version(&current_version())?;
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(12))
        .build();
    let resp = agent
        .get(&format!("https://api.github.com/repos/{REPO}/releases"))
        .set("User-Agent", USER_AGENT)
        .set("Accept", "application/vnd.github+json")
        .call()
        .ok()?;
    let body = resp.into_string().ok()?;
    let releases: serde_json::Value = serde_json::from_str(&body).ok()?;
    for rel in releases.as_array()? {
        if rel.get("draft").and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }
        let assets = match rel.get("assets").and_then(|a| a.as_array()) {
            Some(a) => a,
            None => continue,
        };
        for asset in assets {
            let name = asset.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if !(name.starts_with(ASSET_PREFIX) && name.ends_with(ASSET_SUFFIX)) {
                continue;
            }
            // اولین ریلیزی که asset آپدیت دارد برنده است؛ نسخه از نام asset (وگرنه از تگ)
            let from_name = &name[ASSET_PREFIX.len()..name.len() - ASSET_SUFFIX.len()];
            let version = if parse_version(from_name).is_some() {
                from_name.to_string()
            } else {
                rel.get("tag_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim_start_matches('v')
                    .to_string()
            };
            let new_key = parse_version(&version)?;
            if new_key <= current {
                return None;
            }
            let download_url = asset
                .get("browser_download_url")
                .and_then(|v| v.as_str())?
                .to_string();
            let notes: String = rel
                .get("body")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .chars()
                .take(2000)
                .collect();
            let published_at = rel
                .get("published_at")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            return Some(UpdateInfo {
                version,
                download_url,
                notes,
                published_at,
            });
        }
    }
    None
}

#[tauri::command]
pub async fn check_update() -> Option<UpdateInfo> {
    tauri::async_runtime::spawn_blocking(check_update_blocking)
        .await
        .ok()
        .flatten()
}

// ---------- بارگذاری دستی فایل آپدیت ----------

/// دیالوگ انتخاب فایل آپدیت (ZIP) برای بارگذاری دستی
#[tauri::command]
pub fn open_update_file_dialog(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::{DialogExt, FilePath};
    let picked = app
        .dialog()
        .file()
        .add_filter("بسته‌ی آپدیت", &["zip"])
        .blocking_pick_file();
    Ok(match picked {
        Some(FilePath::Path(p)) => Some(p.to_string_lossy().into_owned()),
        _ => None,
    })
}

/// اعمال آپدیت از فایل محلی (بارگذاری دستی): اعتبارسنجی بسته + استخراج + اجرای موتور.
/// موفقیت = برنامه بسته و موتور آپدیت اجرا می‌شود (مثل مسیر دانلود).
#[tauri::command]
pub fn apply_local_update(app: AppHandle, path: String) -> Result<(), String> {
    let zip_path = PathBuf::from(&path);
    if !zip_path.is_file() {
        return Err("فایل آپدیت پیدا نشد".to_string());
    }
    validate_update_zip(&zip_path)?;
    let dir = exe_dir().ok_or("مسیر نصب پیدا نشد")?;
    extract_update(&zip_path, &dir.join("pending_update"))?;
    launch_engine(&app)?;
    Ok(())
}

// ---------- دانلود و اعمال ----------

/// وضعیت دانلود آپدیت (برای کنسل از فرانت)
#[derive(Default)]
pub struct UpdateDlState {
    pub cancel: Arc<AtomicBool>,
}

#[tauri::command]
pub fn cancel_update_download(state: State<'_, UpdateDlState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

// ---------- مانیفست آپدیت ----------

#[derive(Debug, Clone)]
struct ManifestFile {
    path: String,
    sha256: String,
}

#[derive(Debug, Clone)]
struct Manifest {
    version: String,
    files: Vec<ManifestFile>,
    removed: Vec<String>,
}

fn parse_manifest(v: &serde_json::Value) -> Manifest {
    let version = v
        .get("version")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let mut files = Vec::new();
    if let Some(arr) = v.get("files").and_then(|x| x.as_array()) {
        for it in arr {
            if let Some(s) = it.as_str() {
                files.push(ManifestFile {
                    path: s.to_string(),
                    sha256: String::new(),
                });
            } else if let Some(o) = it.as_object() {
                let path = o
                    .get("path")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let sha256 = o
                    .get("sha256")
                    .or_else(|| o.get("hash"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                if !path.is_empty() {
                    files.push(ManifestFile { path, sha256 });
                }
            }
        }
    }
    let removed = v
        .get("removed")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    Manifest {
        version,
        files,
        removed,
    }
}

/// اعتبارسنجی بسته‌ی آپدیت دانلودشده؛ در صورت صحت، مانیفست را برمی‌گرداند
fn validate_update_zip(zip_path: &Path) -> Result<Manifest, String> {
    let f = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut ar =
        zip::ZipArchive::new(f).map_err(|e| format!("بسته‌ی آپدیت سالم نیست: {e}"))?;
    let mut info_str = String::new();
    {
        let mut entry = ar
            .by_name("update_info.json")
            .map_err(|_| "فایل update_info.json در بسته‌ی آپدیت نیست".to_string())?;
        entry
            .read_to_string(&mut info_str)
            .map_err(|e| e.to_string())?;
    }
    let v: serde_json::Value =
        serde_json::from_str(&info_str).map_err(|e| format!("update_info.json نامعتبر است: {e}"))?;
    if v.get("app").and_then(|x| x.as_str()) != Some(APP_ID) {
        return Err("بسته‌ی آپدیت متعلق به این برنامه نیست".to_string());
    }
    let m = parse_manifest(&v);
    if m.version.trim().is_empty() {
        return Err("نسخه‌ی بسته‌ی آپدیت خالی است".to_string());
    }
    // جهت نسخه: پایین‌تر رد می‌شود (گذار beta به stable هم‌شماره با مقایسه‌ی تاپل مجاز است)
    let current = parse_version(&current_version()).ok_or("نسخه‌ی فعلی نامعتبر است")?;
    let new_key = parse_version(&m.version).ok_or("نسخه‌ی بسته‌ی آپدیت نامعتبر است")?;
    if new_key <= current {
        return Err("نسخه‌ی بسته‌ی آپدیت جدیدتر از نسخه‌ی فعلی نیست".to_string());
    }
    // همه‌ی فایل‌های مانیفست باید به‌صورت files/<path> داخل ZIP باشند
    let mut names = std::collections::HashSet::new();
    for i in 0..ar.len() {
        let e = ar.by_index(i).map_err(|e| e.to_string())?;
        names.insert(e.name().to_string());
    }
    for mf in &m.files {
        let expect = format!("files/{}", mf.path);
        if !names.contains(&expect) {
            return Err(format!("فایل {expect} در بسته‌ی آپدیت نیست"));
        }
    }
    Ok(m)
}

/// استخراج امن (ضد path traversal) به پوشه‌ی مقصد؛ مقصد قبلی اول کامل پاک می‌شود
fn extract_update(zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
    if dest_dir.exists() {
        std::fs::remove_dir_all(dest_dir).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    let f = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut ar = zip::ZipArchive::new(f).map_err(|e| e.to_string())?;
    for i in 0..ar.len() {
        let mut entry = ar.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        // رد مسیرهای خطرناک: ‎..‎ و مطلق و درایو
        let rel = Path::new(&name);
        let mut safe = !name.is_empty();
        for c in rel.components() {
            match c {
                std::path::Component::Normal(_) | std::path::Component::CurDir => {}
                _ => safe = false,
            }
        }
        if !safe {
            continue;
        }
        let dest = dest_dir.join(rel);
        if name.ends_with('/') {
            std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// دانلود چانکی با رویداد پیشرفت؛ Ok(false) یعنی کاربر کنسل کرده (‎.part‎ پاک می‌شود)
fn download_file(
    app: &AppHandle,
    url: &str,
    part: &Path,
    cancel: &AtomicBool,
) -> Result<bool, String> {
    use std::io::Write;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(30))
        .build();
    let resp = agent
        .get(url)
        .set("User-Agent", USER_AGENT)
        .call()
        .map_err(|e| format!("خطا در دانلود آپدیت: {e}"))?;
    let total: u64 = resp
        .header("Content-Length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut file = std::fs::File::create(part).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut done: u64 = 0;
    let mut last_pct: i64 = -1;
    loop {
        if cancel.load(Ordering::SeqCst) {
            drop(file);
            let _ = std::fs::remove_file(part);
            return Ok(false);
        }
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("خطا در دانلود آپدیت: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if total > 0 {
            let pct = (done * 100 / total) as i64;
            if pct != last_pct {
                last_pct = pct;
                let _ = app.emit(PROGRESS_EVENT, pct);
            }
        }
    }
    if total > 0 {
        let _ = app.emit(PROGRESS_EVENT, 100i64);
    }
    Ok(true)
}

fn log_tail(path: &Path, max: usize) -> String {
    match std::fs::read(path) {
        Ok(bytes) => {
            let start = bytes.len().saturating_sub(max);
            String::from_utf8_lossy(&bytes[start..]).into_owned()
        }
        Err(_) => String::new(),
    }
}

fn log_marker_since(path: &Path, before: u64, marker: &str) -> bool {
    if let Ok(bytes) = std::fs::read(path) {
        if (bytes.len() as u64) > before {
            let s = String::from_utf8_lossy(&bytes[before as usize..]);
            return s.contains(marker);
        }
    }
    false
}

/// اجرای موتور آپدیت (همین exe با ‎--apply-update‎) و دست‌دادن با update.log؛
/// اگر موتور زنده بود برنامه کامل بسته می‌شود و این تابع برنمی‌گردد
fn launch_engine(app: &AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe_dir().ok_or("مسیر نصب پیدا نشد")?;
    let pending = dir.join("pending_update");
    let log_path = dir.join("update.log");
    let log_size_before = std::fs::metadata(&log_path).map(|m| m.len()).unwrap_or(0);
    let mut cmd = std::process::Command::new(&exe);
    cmd.arg("--apply-update")
        .arg(&dir)
        .arg(&pending)
        .arg(std::process::id().to_string())
        .arg(exe_name())
        .current_dir(&dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        cmd.creation_flags(0x0000_0008 | 0x0000_0200);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("اجرای موتور آپدیت ناموفق بود: {e}"))?;
    // حداکثر ۳ ثانیه منتظر خط «updater started» در update.log
    let start = Instant::now();
    let mut alive = false;
    while start.elapsed() < Duration::from_secs(3) {
        if log_marker_since(&log_path, log_size_before, "updater started") {
            alive = true;
            break;
        }
        if let Ok(Some(_)) = child.try_wait() {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    if !alive {
        let tail = log_tail(&log_path, 1500);
        return Err(format!("موتور آپدیت شروع به کار نکرد.\n{tail}"));
    }
    app.exit(0);
    std::process::exit(0);
}

enum DlOutcome {
    Cancelled,
}

fn run_download_and_launch(
    app: AppHandle,
    version: String,
    url: String,
    cancel: Arc<AtomicBool>,
) -> Result<DlOutcome, String> {
    let part = std::env::temp_dir().join(format!("{ASSET_PREFIX}{version}.zip.part"));
    let zip_path = std::env::temp_dir().join(format!("{ASSET_PREFIX}{version}.zip"));
    if !download_file(&app, &url, &part, &cancel)? {
        return Ok(DlOutcome::Cancelled);
    }
    std::fs::rename(&part, &zip_path).map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), String> {
        validate_update_zip(&zip_path)?;
        let dir = exe_dir().ok_or("مسیر نصب پیدا نشد")?;
        extract_update(&zip_path, &dir.join("pending_update"))?;
        Ok(())
    })();
    let _ = std::fs::remove_file(&zip_path);
    result?;
    launch_engine(&app)?;
    Ok(DlOutcome::Cancelled) // عملاً unreachable: launch_engine موفق یعنی خروج از برنامه
}

/// دانلود و اعمال آپدیت. بدون آرگومان هم کار می‌کند (خودش چک می‌کند).
/// موفقیت = برنامه بسته و موتور آپدیت اجرا می‌شود؛ کنسل = Ok بی‌سروصدا.
#[tauri::command(rename_all = "camelCase")]
pub async fn download_and_apply_update(
    app: AppHandle,
    state: State<'_, UpdateDlState>,
    version: Option<String>,
    download_url: Option<String>,
) -> Result<(), String> {
    let (version, url) = match (version, download_url) {
        (Some(v), Some(u)) if !v.is_empty() && !u.is_empty() => (v, u),
        _ => {
            let info = tauri::async_runtime::spawn_blocking(check_update_blocking)
                .await
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "آپدیت جدیدی موجود نیست".to_string())?;
            (info.version, info.download_url)
        }
    };
    state.cancel.store(false, Ordering::SeqCst);
    let cancel = state.cancel.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        run_download_and_launch(app, version, url, cancel)
    })
    .await
    .map_err(|e| e.to_string())?;
    match outcome {
        Ok(_) => Ok(()),
        Err(e) => Err(e),
    }
}

// ---------- مد ‎--apply-update‎ (موتور نصب) ----------

struct EngineLog {
    path: PathBuf,
}

impl EngineLog {
    fn line(&self, msg: &str) {
        use std::io::Write;
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
        {
            let _ = writeln!(f, "[{ts}] {msg}");
        }
    }
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess};
    unsafe {
        // PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        let h = OpenProcess(0x1000, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(h, &mut code);
        let _ = CloseHandle(h);
        ok != 0 && code == 259 // STILL_ACTIVE
    }
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

#[cfg(not(any(windows, unix)))]
fn pid_alive(_pid: u32) -> bool {
    false
}

#[cfg(windows)]
fn message_box(text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW;
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let cap: Vec<u16> = APP_ID.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        // MB_ICONERROR = 0x10
        MessageBoxW(std::ptr::null_mut(), wide.as_ptr(), cap.as_ptr(), 0x10);
    }
}

#[cfg(not(windows))]
fn message_box(_text: &str) {}

fn old_path(p: &Path) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(".old");
    PathBuf::from(s)
}

/// کپی روی مقصد؛ اگر مقصد قفل بود اول به ‎.old‎ تغییرنام می‌خورد
fn copy_replace(src: &Path, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    match std::fs::copy(src, dest) {
        Ok(_) => Ok(()),
        Err(_) => {
            let old = old_path(dest);
            let _ = std::fs::remove_file(&old);
            if dest.exists() {
                std::fs::rename(dest, &old).map_err(|e| e.to_string())?;
            }
            std::fs::copy(src, dest).map_err(|e| e.to_string())?;
            Ok(())
        }
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// مسیرهای مانیفست باید نسبی و ساده باشند (ضد traversal)
fn ensure_safe_rel(rel: &str) -> Result<(), String> {
    for c in Path::new(rel).components() {
        match c {
            std::path::Component::Normal(_) => {}
            _ => return Err(format!("مسیر نامعتبر در مانیفست: {rel}")),
        }
    }
    Ok(())
}

fn write_state(install: &Path, status: &str, error: Option<&str>) {
    let mut obj = serde_json::json!({ "status": status });
    if let Some(e) = error {
        obj["error"] = serde_json::Value::String(e.to_string());
    }
    let _ = std::fs::write(install.join("update_state.json"), obj.to_string());
}

/// برگرداندن کامل از بکاپ: فایل‌های جایگزین‌شده برمی‌گردند، فایل‌های تازه حذف
/// می‌شوند، فایل‌های removed برمی‌گردند و version.txt مثل قبل می‌شود
fn rollback(install: &Path, manifest: &Manifest, backup_dir: &Path, log: &EngineLog) {
    for mf in &manifest.files {
        let dest = install.join(&mf.path);
        let bak = backup_dir.join(&mf.path);
        if bak.exists() {
            let _ = copy_replace(&bak, &dest);
        } else if dest.exists() && std::fs::remove_file(&dest).is_err() {
            let _ = std::fs::rename(&dest, old_path(&dest));
        }
    }
    for rel in &manifest.removed {
        let dest = install.join(rel);
        let bak = backup_dir.join(rel);
        if bak.exists() {
            let _ = copy_replace(&bak, &dest);
        }
    }
    let bak_vt = backup_dir.join("version.txt");
    if bak_vt.exists() {
        let _ = std::fs::copy(&bak_vt, install.join("version.txt"));
    }
    log.line("rollback done");
}

/// نقطه‌ی ورود مد موتور — از main قبل از هر چیز صدا زده می‌شود و برنمی‌گردد
pub fn run_apply_update(args: &[String]) -> ! {
    let code = engine_main(args);
    std::process::exit(code);
}

fn engine_fail(install: &Path, log: &EngineLog, status: &str, msg: &str) -> i32 {
    log.line(&format!("FAILED ({status}): {msg}"));
    write_state(install, status, Some(msg));
    message_box(msg);
    1
}

fn engine_main(args: &[String]) -> i32 {
    if args.len() < 4 {
        return 2;
    }
    let install = PathBuf::from(&args[0]);
    let pending = PathBuf::from(&args[1]);
    let parent_pid: u32 = args[2].parse().unwrap_or(0);
    let exe_fn = args[3].clone();
    let log = EngineLog {
        path: install.join("update.log"),
    };
    log.line("updater started");

    // حداکثر ۱۲۰ ثانیه منتظر خروج فرایند والد
    let start = Instant::now();
    let mut parent_gone = parent_pid == 0 || !pid_alive(parent_pid);
    while !parent_gone && start.elapsed() < Duration::from_secs(120) {
        std::thread::sleep(Duration::from_millis(500));
        parent_gone = !pid_alive(parent_pid);
    }
    if !parent_gone {
        return engine_fail(
            &install,
            &log,
            "failed",
            "برنامه‌ی اصلی بسته نشد؛ آپدیت لغو شد.",
        );
    }
    log.line("parent exited");

    // خواندن مانیفست
    let info_path = pending.join("update_info.json");
    let info_str = match std::fs::read_to_string(&info_path) {
        Ok(s) => s,
        Err(e) => {
            return engine_fail(
                &install,
                &log,
                "failed",
                &format!("خواندن update_info.json ناموفق بود: {e}"),
            )
        }
    };
    let parsed: serde_json::Value = match serde_json::from_str(&info_str) {
        Ok(v) => v,
        Err(e) => {
            return engine_fail(
                &install,
                &log,
                "failed",
                &format!("update_info.json نامعتبر است: {e}"),
            )
        }
    };
    if parsed.get("app").and_then(|x| x.as_str()) != Some(APP_ID) {
        return engine_fail(&install, &log, "failed", "بسته‌ی آپدیت متعلق به این برنامه نیست.");
    }
    let manifest = parse_manifest(&parsed);
    let new_version = manifest.version.trim().to_string();
    if new_version.is_empty() {
        return engine_fail(&install, &log, "failed", "نسخه‌ی آپدیت خالی است.");
    }
    let prev_version = std::fs::read_to_string(install.join("version.txt"))
        .ok()
        .and_then(|c| c.split_whitespace().next().map(|s| s.to_string()))
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
    log.line(&format!("applying update {prev_version} -> {new_version}"));

    let backup_dir = install.join("backup").join(format!("v{prev_version}"));
    // بکاپ version.txt برای rollback
    let vt_path = install.join("version.txt");
    if vt_path.exists() {
        let _ = std::fs::create_dir_all(&backup_dir);
        let _ = std::fs::copy(&vt_path, backup_dir.join("version.txt"));
    }

    // بکاپ + جایگزینی + حذف removed + راستی‌آزمایی SHA-256
    let apply_result = (|| -> Result<(), String> {
        let src_root = pending.join("files");
        for mf in &manifest.files {
            ensure_safe_rel(&mf.path)?;
            let dest = install.join(&mf.path);
            if dest.exists() {
                let bak = backup_dir.join(&mf.path);
                if let Some(p) = bak.parent() {
                    std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
                }
                std::fs::copy(&dest, &bak).map_err(|e| e.to_string())?;
            }
            copy_replace(&src_root.join(&mf.path), &dest)?;
            log.line(&format!("replaced {}", mf.path));
        }
        for rel in &manifest.removed {
            ensure_safe_rel(rel)?;
            let dest = install.join(rel);
            if dest.exists() {
                let bak = backup_dir.join(rel);
                if let Some(p) = bak.parent() {
                    std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
                }
                let _ = std::fs::copy(&dest, &bak);
                if std::fs::remove_file(&dest).is_err() {
                    let _ = std::fs::rename(&dest, old_path(&dest));
                }
                log.line(&format!("removed {rel}"));
            }
        }
        for mf in &manifest.files {
            if mf.sha256.is_empty() {
                continue;
            }
            let actual = sha256_file(&install.join(&mf.path))?;
            if !actual.eq_ignore_ascii_case(&mf.sha256) {
                return Err(format!("چک‌سام فایل {} مطابقت ندارد", mf.path));
            }
        }
        log.line("sha256 verified");
        Ok(())
    })();
    if let Err(e) = apply_result {
        rollback(&install, &manifest, &backup_dir, &log);
        return engine_fail(&install, &log, "rolled_back", &format!("آپدیت برگردانده شد: {e}"));
    }

    // version.txt جدید + read-back verify
    let vt_ok = std::fs::write(&vt_path, format!("{new_version}\n")).is_ok()
        && std::fs::read_to_string(&vt_path)
            .map(|c| c.split_whitespace().next() == Some(new_version.as_str()))
            .unwrap_or(false);
    if !vt_ok {
        rollback(&install, &manifest, &backup_dir, &log);
        return engine_fail(
            &install,
            &log,
            "rolled_back",
            "نوشتن version.txt ناموفق بود؛ آپدیت برگردانده شد.",
        );
    }

    // کپی مانیفست به ریشه‌ی نصب + حذف pending + فایل‌های state
    let _ = std::fs::copy(&info_path, install.join("manifest.json"));
    let _ = std::fs::remove_dir_all(&pending);
    let applied = serde_json::json!({
        "prev_version": prev_version,
        "new_version": new_version,
    });
    let _ = std::fs::write(install.join("update_applied.json"), applied.to_string());
    write_state(&install, "ok", None);
    log.line("update applied ok");

    // اجرای مجدد برنامه و چک زنده‌بودن بعد از ۲ ثانیه
    let exe_path = install.join(&exe_fn);
    let mut cmd = std::process::Command::new(&exe_path);
    cmd.current_dir(&install);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0000_0008 | 0x0000_0200);
    }
    let relaunched = match cmd.spawn() {
        Ok(mut child) => {
            std::thread::sleep(Duration::from_secs(2));
            matches!(child.try_wait(), Ok(None))
        }
        Err(_) => false,
    };
    if relaunched {
        log.line("app relaunched");
    } else {
        log.line("relaunch failed");
        message_box("آپدیت با موفقیت نصب شد؛ لطفاً برنامه را دستی اجرا کنید.");
    }
    0
}

// ---------- گزارش آپدیت در استارت ----------

/// متن چنج‌لاگ بین دو نسخه از روی هدرهای ‎## X.Y.Z (تاریخ)‎ — سقف ۶۰۰۰ کاراکتر
pub fn changelog_between(content: &str, prev: &str, new: &str) -> String {
    let prev_key = parse_version(prev);
    let new_key = parse_version(new);
    let mut sections: Vec<(String, String)> = Vec::new();
    let mut cur_ver: Option<String> = None;
    let mut cur_text = String::new();
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            if let Some(v) = cur_ver.take() {
                sections.push((v, std::mem::take(&mut cur_text)));
            }
            cur_ver = Some(rest.split_whitespace().next().unwrap_or("").to_string());
            cur_text = String::new();
            cur_text.push_str(line);
            cur_text.push('\n');
        } else if cur_ver.is_some() {
            cur_text.push_str(line);
            cur_text.push('\n');
        }
    }
    if let Some(v) = cur_ver.take() {
        sections.push((v, cur_text));
    }
    let mut out = String::new();
    for (v, text) in &sections {
        if let (Some(vk), Some(pk), Some(nk)) = (parse_version(v), prev_key, new_key) {
            if vk > pk && vk <= nk {
                out.push_str(text);
                out.push('\n');
            }
        }
    }
    out.trim().chars().take(6000).collect()
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

// ---------- پاک‌سازی فایل‌های ‎.old‎ در استارت عادی ----------

pub fn cleanup_old_files() {
    if let Some(dir) = exe_dir() {
        cleanup_old_in(&dir);
    }
}

fn cleanup_old_in(dir: &Path) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let p = entry.path();
            if p.is_dir() {
                cleanup_old_in(&p);
            } else if p
                .file_name()
                .map(|n| n.to_string_lossy().ends_with(".old"))
                .unwrap_or(false)
            {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
}
