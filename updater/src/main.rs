//! ShirinHesabUpdater — باینری کمکی نصب آپدیت شیرین‌حساب.
//!
//! فقط std + serde_json. اپ اصلی بسته را در pending_update استیج می‌کند، این
//! هلپر را detached اجرا می‌کند و خودش خارج می‌شود. هلپر:
//! انتظار خروج والد → بکاپ → جایگزینی فایل‌ها (با ترفند .old برای فایل قفل)
//! → حذف removed → راستی‌آزمایی SHA-256 (پیاده‌سازی دستی همین فایل)
//! → خطا = rollback کامل → version.txt جدید → update_state/applied
//! → اجرای مجدد اپ. همه‌چیز در update.log کنار محل نصب.
//!
//! اجرا: ShirinHesabUpdater.exe --install <install_dir> <pending_dir> <parent_pid> <exe_name>

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// ---------- SHA-256 (FIPS 180-4) — چون فقط std مجاز است، دستی ----------

const SHA_K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

pub struct Sha256 {
    h: [u32; 8],
    buf: [u8; 64],
    buf_len: usize,
    total_len: u64,
}

impl Sha256 {
    pub fn new() -> Self {
        Sha256 {
            h: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
                0x5be0cd19,
            ],
            buf: [0u8; 64],
            buf_len: 0,
            total_len: 0,
        }
    }

    pub fn update(&mut self, mut data: &[u8]) {
        self.total_len = self.total_len.wrapping_add(data.len() as u64);
        if self.buf_len > 0 {
            let take = (64 - self.buf_len).min(data.len());
            self.buf[self.buf_len..self.buf_len + take].copy_from_slice(&data[..take]);
            self.buf_len += take;
            data = &data[take..];
            if self.buf_len == 64 {
                let block = self.buf;
                self.compress(&block);
                self.buf_len = 0;
            }
        }
        while data.len() >= 64 {
            let (block, rest) = data.split_at(64);
            let mut b = [0u8; 64];
            b.copy_from_slice(block);
            self.compress(&b);
            data = rest;
        }
        if !data.is_empty() {
            self.buf[..data.len()].copy_from_slice(data);
            self.buf_len = data.len();
        }
    }

    fn compress(&mut self, block: &[u8; 64]) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                block[i * 4],
                block[i * 4 + 1],
                block[i * 4 + 2],
                block[i * 4 + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h) = (
            self.h[0], self.h[1], self.h[2], self.h[3], self.h[4], self.h[5], self.h[6], self.h[7],
        );
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(SHA_K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        self.h[0] = self.h[0].wrapping_add(a);
        self.h[1] = self.h[1].wrapping_add(b);
        self.h[2] = self.h[2].wrapping_add(c);
        self.h[3] = self.h[3].wrapping_add(d);
        self.h[4] = self.h[4].wrapping_add(e);
        self.h[5] = self.h[5].wrapping_add(f);
        self.h[6] = self.h[6].wrapping_add(g);
        self.h[7] = self.h[7].wrapping_add(h);
    }

    pub fn finalize(mut self) -> [u8; 32] {
        let bit_len = self.total_len.wrapping_mul(8);
        self.update(&[0x80]);
        while self.buf_len != 56 {
            self.update(&[0]);
        }
        self.buf[56..64].copy_from_slice(&bit_len.to_be_bytes());
        let block = self.buf;
        self.compress(&block);
        let mut out = [0u8; 32];
        for i in 0..8 {
            out[i * 4..i * 4 + 4].copy_from_slice(&self.h[i].to_be_bytes());
        }
        out
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex(&h.finalize())
}

fn sha256_file(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Some(hex(&hasher.finalize()))
}

// ---------- پلتفرم: زنده‌بودن پروسه و MessageBox (بدون کرِیت خارجی) ----------

#[cfg(windows)]
mod platform {
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit_handle: i32, process_id: u32) -> isize;
        fn GetExitCodeProcess(process: isize, exit_code: *mut u32) -> i32;
        fn CloseHandle(object: isize) -> i32;
    }
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(hwnd: isize, text: *const u16, caption: *const u16, flags: u32) -> i32;
    }

    pub fn process_alive(pid: u32) -> bool {
        if pid == 0 {
            return false;
        }
        unsafe {
            // PROCESS_QUERY_LIMITED_INFORMATION = 0x1000 ، STILL_ACTIVE = 259
            let h = OpenProcess(0x1000, 0, pid);
            if h == 0 {
                return false;
            }
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(h, &mut code);
            CloseHandle(h);
            ok != 0 && code == 259
        }
    }

    /// flags: ‏0x10 = خطا، 0x40 = اطلاع
    pub fn message_box(text: &str, caption: &str, flags: u32) {
        let t: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let c: Vec<u16> = caption.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            MessageBoxW(0, t.as_ptr(), c.as_ptr(), flags);
        }
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn process_alive(pid: u32) -> bool {
        pid != 0 && std::path::Path::new(&format!("/proc/{pid}")).exists()
    }
    pub fn message_box(_text: &str, _caption: &str, _flags: u32) {}
}

// ---------- لاگ و وضعیت ----------

struct Logger {
    path: PathBuf,
}

impl Logger {
    fn log(&self, msg: &str) {
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
            let _ = f.write_all(format!("[{ts}] {msg}\n").as_bytes());
        }
    }
}

fn write_state(install: &Path, status: &str, error: Option<&str>) {
    let mut obj = serde_json::Map::new();
    obj.insert("status".to_string(), status.into());
    if let Some(e) = error {
        obj.insert("error".to_string(), e.into());
    }
    let _ = std::fs::write(
        install.join("update_state.json"),
        serde_json::Value::Object(obj).to_string(),
    );
}

// ---------- عملیات فایل ----------

fn old_path(p: &Path) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(".old");
    PathBuf::from(s)
}

/// کپی روی مقصد — اگر قفل بود، مقصد اول به ‎.old‎ می‌رود و بعد کپی می‌شود
fn replace_file(src: &Path, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if std::fs::copy(src, dest).is_ok() {
        return Ok(());
    }
    let old = old_path(dest);
    if old.exists() {
        let _ = std::fs::remove_file(&old);
    }
    if dest.exists() {
        std::fs::rename(dest, &old)
            .map_err(|e| format!("جابه‌جایی فایل قفل‌شده «{}» ناموفق بود: {e}", dest.display()))?;
    }
    std::fs::copy(src, dest)
        .map_err(|e| format!("کپی فایل «{}» ناموفق بود: {e}", dest.display()))?;
    Ok(())
}

fn backup_copy(dest: &Path, backup_dir: &Path, rel: &str) -> Result<(), String> {
    let target = backup_dir.join(rel);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::copy(dest, &target)
        .map_err(|e| format!("بکاپ فایل «{rel}» ناموفق بود: {e}"))?;
    Ok(())
}

/// برگرداندن همه‌ی فایل‌های بکاپ‌شده و حذف فایل‌های تازه‌ساخته‌شده
fn rollback(install: &Path, backup_dir: &Path, backed_up: &[String], created: &[String], log: &Logger) {
    for rel in backed_up {
        let from = backup_dir.join(rel);
        let to = install.join(rel);
        if let Some(parent) = to.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::copy(&from, &to).is_err() {
            let old = old_path(&to);
            if old.exists() {
                let _ = std::fs::remove_file(&old);
            }
            if to.exists() {
                let _ = std::fs::rename(&to, &old);
            }
            let _ = std::fs::copy(&from, &to);
        }
        log.log(&format!("rollback: restored {rel}"));
    }
    for rel in created {
        let to = install.join(rel);
        if std::fs::remove_file(&to).is_err() && to.exists() {
            let old = old_path(&to);
            if old.exists() {
                let _ = std::fs::remove_file(&old);
            }
            let _ = std::fs::rename(&to, &old);
        }
        log.log(&format!("rollback: removed new {rel}"));
    }
}

// ---------- اجرای اصلی ----------

fn fail_early(install: &Path, log: &Logger, msg: &str) -> i32 {
    log.log(&format!("failed: {msg}"));
    write_state(install, "failed", Some(msg));
    platform::message_box(msg, "شیرین‌حساب — به‌روز‌رسان", 0x10);
    1
}

fn run(install: &Path, pending: &Path, parent_pid: u32, exe_name: &str) -> i32 {
    let log = Logger {
        path: install.join("update.log"),
    };
    log.log("updater started");

    // انتظار خروج برنامه‌ی اصلی (تا ۱۲۰ ثانیه)
    if parent_pid != 0 && parent_pid != std::process::id() {
        let start = std::time::Instant::now();
        while platform::process_alive(parent_pid) {
            if start.elapsed() > Duration::from_secs(120) {
                return fail_early(
                    install,
                    &log,
                    "برنامه‌ی اصلی در مهلت مقرر بسته نشد؛ آپدیت لغو شد.",
                );
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }
    log.log("parent exited");

    // خواندن مانیفست بسته‌ی استیج‌شده
    let info_raw = match std::fs::read_to_string(pending.join("update_info.json")) {
        Ok(s) => s,
        Err(e) => {
            return fail_early(
                install,
                &log,
                &format!("فایل update_info.json در بسته‌ی آماده پیدا نشد: {e}"),
            )
        }
    };
    let info: serde_json::Value = match serde_json::from_str(&info_raw) {
        Ok(v) => v,
        Err(e) => {
            return fail_early(
                install,
                &log,
                &format!("مانیفست بسته‌ی آپدیت خراب است: {e}"),
            )
        }
    };
    let new_version = info
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if new_version.is_empty() {
        return fail_early(install, &log, "نسخه‌ی مقصد در مانیفست بسته نیست.");
    }
    let prev_version = std::fs::read_to_string(install.join("version.txt"))
        .ok()
        .and_then(|t| t.split_whitespace().next().map(|s| s.to_string()))
        .filter(|s| !s.is_empty())
        .or_else(|| {
            info.get("prev_version")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "0.0.0".to_string());
    let files: Vec<(String, String)> = info
        .get("files")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|f| {
                    let p = f.get("path")?.as_str()?.to_string();
                    let s = f
                        .get("sha256")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    Some((p, s))
                })
                .collect()
        })
        .unwrap_or_default();
    let removed: Vec<String> = info
        .get("removed")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    log.log(&format!(
        "applying update {prev_version} -> {new_version}: {} files, {} removed",
        files.len(),
        removed.len()
    ));

    let backup_dir = install.join("backup").join(format!("v{prev_version}"));
    let mut backed_up: Vec<String> = Vec::new();
    let mut created: Vec<String> = Vec::new();

    // از version.txt هم بکاپ بگیر تا رول‌بک کامل باشد
    let version_path = install.join("version.txt");
    if version_path.exists() {
        if let Err(e) = backup_copy(&version_path, &backup_dir, "version.txt") {
            return fail_early(install, &log, &e);
        }
        backed_up.push("version.txt".to_string());
    }

    let apply_result: Result<(), String> = (|| {
        // جایگزینی فایل‌ها از روی pending (فایل‌ها بدون پیشوند کنار update_info.json هستند)
        for (rel, _) in &files {
            let src = pending.join(rel);
            let dest = install.join(rel);
            if !src.exists() {
                return Err(format!("فایل «{rel}» در بسته‌ی آماده نیست."));
            }
            if dest.exists() {
                backup_copy(&dest, &backup_dir, rel)?;
                backed_up.push(rel.clone());
            } else {
                created.push(rel.clone());
            }
            replace_file(&src, &dest)?;
            log.log(&format!("replaced {rel}"));
        }
        // حذف فایل‌های removed (با بکاپ قبلی)
        for rel in &removed {
            let dest = install.join(rel);
            if dest.exists() {
                backup_copy(&dest, &backup_dir, rel)?;
                backed_up.push(rel.clone());
                if std::fs::remove_file(&dest).is_err() {
                    let old = old_path(&dest);
                    if old.exists() {
                        let _ = std::fs::remove_file(&old);
                    }
                    std::fs::rename(&dest, &old)
                        .map_err(|e| format!("حذف فایل «{rel}» ناموفق بود: {e}"))?;
                }
                log.log(&format!("removed {rel}"));
            }
        }
        // راستی‌آزمایی SHA-256 فایل‌های نصب‌شده
        for (rel, sha) in &files {
            if sha.is_empty() {
                continue;
            }
            let actual = sha256_file(&install.join(rel))
                .ok_or_else(|| format!("خواندن فایل نصب‌شده «{rel}» ناموفق بود."))?;
            if !actual.eq_ignore_ascii_case(sha) {
                return Err(format!(
                    "راستی‌آزمایی فایل «{rel}» ناموفق بود (هش ناهماهنگ)."
                ));
            }
        }
        // version.txt جدید + خواندن مجدد برای اطمینان
        std::fs::write(&version_path, &new_version)
            .map_err(|e| format!("نوشتن version.txt ناموفق بود: {e}"))?;
        let read_back = std::fs::read_to_string(&version_path)
            .map_err(|e| format!("خواندن version.txt ناموفق بود: {e}"))?;
        if read_back.split_whitespace().next().unwrap_or("") != new_version {
            return Err("راستی‌آزمایی version.txt ناموفق بود.".to_string());
        }
        log.log(&format!("version.txt -> {new_version}"));
        Ok(())
    })();

    if let Err(msg) = apply_result {
        log.log(&format!("error: {msg} — rolling back"));
        rollback(install, &backup_dir, &backed_up, &created, &log);
        write_state(install, "rolled_back", Some(&msg));
        platform::message_box(
            &format!("آپدیت ناموفق بود و همه‌چیز به حالت قبل برگشت.\n{msg}"),
            "شیرین‌حساب — به‌روز‌رسان",
            0x10,
        );
        return 1;
    }

    // مانیفست نصب‌شده + گزارش مصرفی اپ
    let _ = std::fs::copy(
        pending.join("update_info.json"),
        install.join("manifest.json"),
    );
    let applied = serde_json::json!({
        "prev_version": prev_version,
        "new_version": new_version,
    });
    let _ = std::fs::write(
        install.join("update_applied.json"),
        applied.to_string(),
    );
    write_state(install, "ok", None);
    let _ = std::fs::remove_dir_all(pending);
    log.log("update applied ok; relaunching app");

    // اجرای مجدد برنامه‌ی اصلی و چک زنده‌بودن
    match std::process::Command::new(install.join(exe_name))
        .current_dir(install)
        .spawn()
    {
        Ok(mut child) => {
            std::thread::sleep(Duration::from_secs(2));
            match child.try_wait() {
                Ok(None) => log.log("app relaunched and alive"),
                _ => {
                    log.log("app relaunched but exited immediately");
                    platform::message_box(
                        "آپدیت با موفقیت انجام شد ولی برنامه خودکار باز نشد؛ لطفاً دستی اجرایش کنید.",
                        "شیرین‌حساب — به‌روز‌رسان",
                        0x40,
                    );
                }
            }
        }
        Err(e) => {
            log.log(&format!("relaunch failed: {e}"));
            platform::message_box(
                "آپدیت با موفقیت انجام شد ولی برنامه خودکار باز نشد؛ لطفاً دستی اجرایش کنید.",
                "شیرین‌حساب — به‌روز‌رسان",
                0x40,
            );
        }
    }
    0
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 6 || args[1] != "--install" {
        std::process::exit(2);
    }
    let install = PathBuf::from(&args[2]);
    let pending = PathBuf::from(&args[3]);
    let parent_pid: u32 = args[4].parse().unwrap_or(0);
    let exe_name = args[5].clone();
    std::process::exit(run(&install, &pending, parent_pid, &exe_name));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_known_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let million_a = vec![b'a'; 1_000_000];
        assert_eq!(
            sha256_hex(&million_a),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }

    #[test]
    fn sha256_chunked_equals_whole() {
        let data: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
        let whole = sha256_hex(&data);
        let mut h = Sha256::new();
        for chunk in data.chunks(7777) {
            h.update(chunk);
        }
        assert_eq!(hex(&h.finalize()), whole);
    }
}
