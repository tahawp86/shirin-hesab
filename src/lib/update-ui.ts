// شیرین حساب — رابط کاربری موتور به‌روزرسانی جدید (اختصاصی)
// سه حالت (تنظیم update_mode):
//   auto   — چک خودکار (۱۵ ثانیه بعد از استارت + هر ۶ ساعت)، دانلود بی‌صدا در پس‌زمینه،
//            پیشرفت روی دکمه‌ی هدر؛ وقتی آماده شد: «🔄 آپدیت آماده‌ی نصب است» + toast نصب.
//   notify — مثل فلو قبلی: اطلاع با دکمه‌ی هدر + toast، دیالوگ تأیید، دانلود با پیشرفت و
//            انصراف (دانلود قابل ادامه است؛ کنسل فایل ناتمام را نگه می‌دارد).
//   off    — نه چک و نه دانلود خودکار؛ فقط دکمه‌های دستی در تنظیمات.
// بک‌اند: EAgent1 — کامندها از api.ts (قرارداد checkUpdate2/downloadUpdate2/applyUpdate2).
import { listen } from "@tauri-apps/api/event";
import { api, type UpdateInfo2 } from "./api";

type UpdateMode = "auto" | "notify" | "off";
type DownloadState = "idle" | "downloading" | "ready";

const MODE_KEY = "update_mode";
const DEFAULT_MODE: UpdateMode = "notify";
const AUTO_FIRST_DELAY_MS = 15_000; // حالت auto: اولین چک ۱۵ ثانیه بعد از استارت
const AUTO_INTERVAL_MS = 6 * 60 * 60 * 1000; // حالت auto: هر ۶ ساعت
const NOTIFY_FIRST_DELAY_MS = 10_000; // حالت notify: مثل فلو قبلی
const NOTIFY_INTERVAL_MS = 60 * 60 * 1000;

let initialized = false;
let checking = false;
let mode: UpdateMode = DEFAULT_MODE;
let pendingUpdate: UpdateInfo2 | null = null;
let downloadState: DownloadState = "idle";
let downloadContext: "auto" | "manual" = "manual";
let progress = { percent: 0, downloaded: 0, total: 0 };
let cancelRequested = false;
let sessionToastVersion: string | null = null;
let toastEl: HTMLElement | null = null;
let dialogEl: HTMLElement | null = null;

// ---------- ابزارهای کوچک ----------

function esc(s: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return s.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function firstLine(s: string): string {
  return (s ?? "").split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
}

function truncate(s: string, max: number): string {
  const t = (s ?? "").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function faNum(n: number): string {
  return n.toLocaleString("fa-IR");
}

function faPercent(p: number): string {
  const clamped = Math.max(0, Math.min(100, Math.round(p)));
  return faNum(clamped) + "٪";
}

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${faNum(bytes)} بایت`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString("fa-IR", { maximumFractionDigits: 1 })} کیلوبایت`;
  return `${(bytes / (1024 * 1024)).toLocaleString("fa-IR", { maximumFractionDigits: 1 })} مگابایت`;
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function ensureStyles(): void {
  if (document.getElementById("upd-style")) return;
  const st = document.createElement("style");
  st.id = "upd-style";
  st.textContent = `
    .upd-nav-btn {
      border: 1px solid var(--accent); background: var(--accent); color: #fff;
      padding: 8px 18px; border-radius: 10px; cursor: pointer; font-size: 15px; font-family: inherit;
      white-space: nowrap; line-height: 1.5;
      transition: background-color 0.15s ease;
    }
    .upd-nav-btn:hover { background: var(--accent-dark); }
    .upd-nav-btn:active { background: var(--accent-dark); }
    .upd-nav-btn:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
    .upd-overlay {
      position: fixed; inset: 0; z-index: 300; background: rgba(0, 0, 0, 0.4);
      display: flex; align-items: center; justify-content: center;
    }
    .upd-dialog {
      background: var(--card); color: var(--text); border-radius: 14px; padding: 20px;
      width: min(540px, 94vw); max-height: 86vh; overflow: auto;
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
    }
    .upd-dialog h3 { margin: 0 0 12px; font-size: 18px; }
    .upd-dialog p { margin: 0 0 10px; line-height: 1.9; }
    .upd-notes {
      white-space: pre-wrap; word-break: break-word; direction: rtl; text-align: right;
      background: #faf3e7; border: 1px solid #f0e4d2; border-radius: 10px;
      padding: 10px 12px; margin: 0 0 12px; max-height: 260px; overflow: auto;
      font-size: 14px; line-height: 1.9;
    }
    .upd-actions { display: flex; gap: 8px; justify-content: flex-start; margin-top: 6px; flex-wrap: wrap; }
    .upd-error { color: var(--danger); }
    .upd-mandatory { color: var(--danger); font-weight: 700; }
    .upd-toast {
      position: fixed; bottom: 18px; inset-inline-start: 18px; z-index: 290;
      background: var(--card); color: var(--text); border-radius: 14px; padding: 14px 16px;
      width: min(430px, 92vw); box-shadow: 0 8px 30px rgba(0, 0, 0, 0.22);
      border: 1px solid #f0e4d2;
    }
    .upd-toast .upd-toast-title { font-weight: 700; margin-bottom: 6px; }
    .upd-toast .upd-toast-note { color: var(--muted); font-size: 13px; margin-bottom: 10px; line-height: 1.8; }
    .upd-progress-track {
      background: #f0e4d2; border-radius: 999px; height: 14px; overflow: hidden; margin: 10px 0 6px;
    }
    .upd-progress-fill {
      background: var(--accent); height: 100%; width: 0%; border-radius: 999px;
      transition: width 0.25s ease;
    }
    .upd-progress-text { color: var(--muted); font-size: 13px; margin-bottom: 10px; }
    .upd-mode-group { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
    .upd-mode-group label { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; font-size: 14px; line-height: 1.8; }
    .upd-mode-group .upd-mode-desc { color: var(--muted); font-size: 12px; }
  `;
  document.head.appendChild(st);
}

// ---------- دیالوگ عمومی ----------

function closeDialog(): void {
  dialogEl?.remove();
  dialogEl = null;
}

function openDialog(html: string, dismissible = true): HTMLElement {
  closeDialog();
  const overlay = document.createElement("div");
  overlay.className = "upd-overlay";
  overlay.innerHTML = `<div class="upd-dialog">${html}</div>`;
  if (dismissible) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeDialog();
    });
  }
  document.body.appendChild(overlay);
  dialogEl = overlay;
  return overlay;
}

function showErrorDialog(title: string, detail: string): void {
  const overlay = openDialog(`
    <h3>⚠️ ${esc(title)}</h3>
    <div class="upd-notes">${esc(detail)}</div>
    <div class="upd-actions">
      <button class="btn" id="upd-err-close">بستن</button>
    </div>`);
  overlay.querySelector("#upd-err-close")!.addEventListener("click", closeDialog);
}

// ---------- گزارش نتیجه‌ی آپدیت قبلی (اولین کار در استارت — مثل قبل) ----------

async function showUpdateReport(): Promise<void> {
  let report: Awaited<ReturnType<typeof api.getUpdateReport>>;
  try {
    report = await api.getUpdateReport();
  } catch {
    return;
  }
  if (!report) return;

  if (report.status === "ok") {
    const overlay = openDialog(`
      <h3>به‌روزرسانی انجام شد</h3>
      <p>🎉 برنامه با موفقیت به نسخه‌ی ${esc(report.new_version)} به‌روزرسانی شد.</p>
      <p style="font-weight: 700;">تغییرات این نسخه‌ها:</p>
      <div class="upd-notes">${esc(report.changelog)}</div>
      <div class="upd-actions">
        <button class="btn" id="upd-report-ok">باشه</button>
      </div>`);
    overlay.querySelector("#upd-report-ok")!.addEventListener("click", closeDialog);
  } else {
    const lead =
      report.status === "rolled_back"
        ? "به‌روزرسانی انجام نشد و برنامه به نسخه‌ی قبلی برگشت."
        : "به‌روزرسانی برنامه با خطا مواجه شد.";
    const overlay = openDialog(`
      <h3>⚠️ به‌روزرسانی ناموفق بود</h3>
      <p>${lead}</p>
      ${report.detail ? `<div class="upd-notes">${esc(report.detail)}</div>` : ""}
      <div class="upd-actions">
        <button class="btn" id="upd-report-ok">باشه</button>
      </div>`);
    overlay.querySelector("#upd-report-ok")!.addEventListener("click", closeDialog);
  }
}

// ---------- حالت آپدیت (تنظیم update_mode) ----------

async function getMode(): Promise<UpdateMode> {
  try {
    const v = await api.getSetting(MODE_KEY);
    if (v === "auto" || v === "notify" || v === "off") return v;
  } catch {
    // بک‌اند آماده نیست — پیش‌فرض
  }
  return DEFAULT_MODE;
}

// ---------- دکمه‌ی هدر ----------

function headerButton(): HTMLElement | null {
  return document.getElementById("update-btn");
}

function renderHeaderButton(): void {
  const btn = headerButton();
  if (!btn) return;
  if (downloadState === "downloading") {
    const p = Math.max(0, Math.min(100, progress.percent));
    btn.style.display = "";
    btn.textContent = `⬇️ در حال دانلود آپدیت… ${faPercent(p)}`;
    btn.style.background = `linear-gradient(to left, var(--accent-dark) ${p}%, var(--accent) ${p}%)`;
    return;
  }
  btn.style.background = "";
  if (downloadState === "ready" && pendingUpdate) {
    btn.style.display = "";
    btn.textContent = "🔄 آپدیت آماده‌ی نصب است";
    return;
  }
  if (pendingUpdate) {
    btn.style.display = "";
    btn.textContent = "⬆️ آپدیت جدید!";
    return;
  }
  btn.style.display = "none";
}

function onHeaderButtonClick(): void {
  if (!pendingUpdate) return;
  if (downloadState === "downloading") {
    openProgressDialog();
  } else if (downloadState === "ready") {
    openInstallConfirm(pendingUpdate);
  } else {
    openDownloadConfirm(pendingUpdate);
  }
}

// ---------- toastها ----------

function hideToast(): void {
  toastEl?.remove();
  toastEl = null;
}

function showToast(title: string, note: string, installLabel: string, onInstall: () => void): void {
  hideToast();
  const el = document.createElement("div");
  el.className = "upd-toast";
  el.innerHTML = `
    <div class="upd-toast-title">${esc(title)}</div>
    ${note ? `<div class="upd-toast-note">${esc(note)}</div>` : ""}
    <div class="upd-actions">
      <button class="btn" id="upd-toast-install">${esc(installLabel)}</button>
      <button class="btn ghost" id="upd-toast-close">✖</button>
    </div>`;
  document.body.appendChild(el);
  toastEl = el;
  el.querySelector("#upd-toast-install")!.addEventListener("click", () => {
    hideToast();
    onInstall();
  });
  el.querySelector("#upd-toast-close")!.addEventListener("click", hideToast);
}

function showAvailableToast(info: UpdateInfo2): void {
  showToast(
    `⬆️ آپدیت جدید منتشر شد! (v${info.version})`,
    firstLine(info.notes_fa),
    "⬆️ دانلود و نصب",
    () => openDownloadConfirm(info)
  );
}

function showReadyToast(info: UpdateInfo2): void {
  showToast(
    `🔄 آپدیت آماده‌ی نصب است! (v${info.version})`,
    firstLine(info.notes_fa),
    "نصب و راه‌اندازی مجدد",
    () => openInstallConfirm(info)
  );
}

// ---------- دیالوگ‌های تأیید ----------

// تأیید دانلود (حالت notify و بررسی دستی): بعد از تأیید، دانلود با پیشرفت شروع
// و بلافاصله بعد از اتمام دانلود، نصب اعمال می‌شود.
function openDownloadConfirm(info: UpdateInfo2): void {
  pendingUpdate = info;
  const overlay = openDialog(
    `
    <h3>⬆️ آپدیت جدید</h3>
    <p>آپدیت جدید v${esc(info.version)} منتشر شده است.</p>
    ${info.mandatory ? `<p class="upd-mandatory">این به‌روزرسانی اجباری است و باید نصب شود.</p>` : ""}
    ${info.notes_fa ? `<div class="upd-notes">${esc(truncate(info.notes_fa, 500))}</div>` : ""}
    <p>فایل آپدیت دانلود و بلافاصله نصب می‌شود؛ برنامه بسته و دوباره باز می‌شود. ادامه می‌دهید؟</p>
    <div class="upd-actions">
      <button class="btn" id="upd-dl-yes">⬆️ دانلود و نصب</button>
      ${info.mandatory ? "" : `<button class="btn ghost" id="upd-dl-no">بعداً</button>`}
    </div>`,
    !info.mandatory
  );
  overlay.querySelector("#upd-dl-yes")!.addEventListener("click", () => {
    closeDialog();
    openProgressDialog();
    void startDownload("manual");
  });
  if (!info.mandatory) {
    overlay.querySelector("#upd-dl-no")!.addEventListener("click", closeDialog);
  }
}

// تأیید نصب (حالت auto بعد از دانلود کامل، یا کلیک روی دکمه‌ی «آماده‌ی نصب»)
function openInstallConfirm(info: UpdateInfo2): void {
  pendingUpdate = info;
  const overlay = openDialog(
    `
    <h3>🔄 آپدیت آماده‌ی نصب است</h3>
    <p>آپدیت v${esc(info.version)} دانلود و راستی‌آزمایی شده و آماده‌ی نصب است.</p>
    ${info.mandatory ? `<p class="upd-mandatory">این به‌روزرسانی اجباری است و باید نصب شود.</p>` : ""}
    ${info.notes_fa ? `<div class="upd-notes">${esc(truncate(info.notes_fa, 500))}</div>` : ""}
    <p>با نصب آپدیت، برنامه بسته و دوباره باز می‌شود. ادامه می‌دهید؟</p>
    <div class="upd-actions">
      <button class="btn" id="upd-in-yes">نصب و راه‌اندازی مجدد</button>
      ${info.mandatory ? "" : `<button class="btn ghost" id="upd-in-no">بعداً</button>`}
    </div>`,
    !info.mandatory
  );
  overlay.querySelector("#upd-in-yes")!.addEventListener("click", () => {
    void applyUpdate();
  });
  if (!info.mandatory) {
    overlay.querySelector("#upd-in-no")!.addEventListener("click", closeDialog);
  }
}

// ---------- دیالوگ پیشرفت دانلود ----------

function updateProgressDialog(): void {
  if (!dialogEl) return;
  const fill = dialogEl.querySelector<HTMLElement>("#upd2-fill");
  const ptext = dialogEl.querySelector<HTMLElement>("#upd2-ptext");
  if (!fill || !ptext) return;
  const p = Math.max(0, Math.min(100, progress.percent));
  fill.style.width = `${p}%`;
  const size =
    progress.total > 0
      ? ` — ${formatSize(progress.downloaded)} از ${formatSize(progress.total)}`
      : "";
  ptext.textContent = `${faPercent(p)}${size}`;
}

function openProgressDialog(): void {
  const overlay = openDialog(`
    <h3>⬇️ در حال دانلود آپدیت…</h3>
    <div class="upd-progress-track"><div class="upd-progress-fill" id="upd2-fill"></div></div>
    <div class="upd-progress-text" id="upd2-ptext">${faPercent(progress.percent)}</div>
    <p style="color: var(--muted); font-size: 13px;">دانلود قابل ادامه است؛ اگر انصراف بدهید، دفعه‌ی بعد از همین‌جا ادامه پیدا می‌کند. بستن این پنجره دانلود پس‌زمینه را متوقف نمی‌کند.</p>
    <div class="upd-actions">
      <button class="btn ghost" id="upd2-hide">بستن پنجره</button>
      <button class="btn danger" id="upd2-cancel">انصراف از دانلود</button>
    </div>`);
  updateProgressDialog();
  overlay.querySelector("#upd2-hide")!.addEventListener("click", closeDialog);
  overlay.querySelector("#upd2-cancel")!.addEventListener("click", () => {
    void cancelDownload();
  });
}

// ---------- موتور دانلود / نصب (سمت رابط) ----------

async function startDownload(context: "auto" | "manual"): Promise<void> {
  if (!pendingUpdate || downloadState === "downloading") return;
  downloadState = "downloading";
  downloadContext = context;
  cancelRequested = false;
  progress = { percent: 0, downloaded: 0, total: 0 };
  renderHeaderButton();
  updateProgressDialog();
  try {
    await api.downloadUpdate2();
    // دانلود کامل و راستی‌آزمایی شد
    downloadState = "ready";
    renderHeaderButton();
    if (downloadContext === "auto") {
      closeDialog();
      if (pendingUpdate) showReadyToast(pendingUpdate);
    } else {
      // حالت notify / دستی: بلافاصله نصب
      await applyUpdate();
    }
  } catch (e) {
    downloadState = "idle";
    renderHeaderButton();
    if (cancelRequested) {
      closeDialog(); // انصراف کاربر — بی‌صدا؛ فایل ناتمام برای ادامه‌ی بعدی می‌ماند
      return;
    }
    if (downloadContext === "auto") {
      closeDialog(); // دانلود پس‌زمینه بی‌صداست؛ دکمه‌ی هدر برای تلاش دستی می‌ماند
      return;
    }
    showErrorDialog("خطا در دانلود آپدیت", errMsg(e));
  }
}

async function cancelDownload(): Promise<void> {
  cancelRequested = true;
  try {
    await api.cancelUpdateDownload2();
  } catch {
    // بی‌صدا
  }
  if (downloadState === "downloading") downloadState = "idle";
  renderHeaderButton();
  closeDialog();
}

async function applyUpdate(): Promise<void> {
  const overlay = openDialog(
    `
    <h3>🔄 در حال نصب آپدیت…</h3>
    <p>برنامه تا چند لحظه‌ی دیگر بسته و دوباره باز می‌شود…</p>`,
    false
  );
  try {
    await api.applyUpdate2();
    const p = overlay.querySelector("p");
    if (p) p.textContent = "نصب کامل شد؛ برنامه در حال راه‌اندازی مجدد است…";
  } catch (e) {
    showErrorDialog("خطا در نصب آپدیت", errMsg(e));
  }
}

// ---------- منطق بررسی آپدیت ----------

async function runCheck(manual: boolean): Promise<UpdateInfo2 | null> {
  if (checking) return pendingUpdate;
  checking = true;
  try {
    const info = await api.checkUpdate2();
    if (info) {
      pendingUpdate = info;
      if (manual) {
        renderHeaderButton();
        if (downloadState === "ready") openInstallConfirm(info);
        else if (downloadState === "idle") openDownloadConfirm(info);
      } else if (downloadState === "idle") {
        if (mode === "auto") {
          void startDownload("auto"); // دانلود بی‌صدا در پس‌زمینه
        } else {
          renderHeaderButton();
          if (sessionToastVersion !== info.version) {
            sessionToastVersion = info.version;
            showAvailableToast(info);
          }
        }
      } else {
        renderHeaderButton();
      }
    } else {
      if (downloadState === "idle") {
        pendingUpdate = null;
        hideToast();
      }
      renderHeaderButton();
    }
    return info;
  } finally {
    checking = false;
  }
}

async function scheduledCheck(): Promise<void> {
  mode = await getMode();
  if (mode === "off") return;
  try {
    await runCheck(false);
  } catch {
    // چک خودکار بی‌صداست
  }
}

function scheduleChecks(): void {
  const firstDelay = mode === "auto" ? AUTO_FIRST_DELAY_MS : NOTIFY_FIRST_DELAY_MS;
  window.setTimeout(function tick() {
    void (async () => {
      await scheduledCheck();
      const interval = mode === "auto" ? AUTO_INTERVAL_MS : NOTIFY_INTERVAL_MS;
      window.setTimeout(tick, interval);
    })();
  }, firstDelay);
}

// بررسی دستی برای صفحه‌ی تنظیمات: پیام «در حال بررسی…» و نتیجه در statusEl نوشته می‌شود.
export async function manualCheckUpdate(statusEl?: HTMLElement): Promise<void> {
  const setStatus = (t: string) => {
    if (statusEl) statusEl.textContent = t;
  };
  setStatus("در حال بررسی…");
  try {
    const info = await runCheck(true);
    if (info) setStatus(`آپدیت جدید v${info.version} موجود است.`);
    else setStatus("✅ برنامه به‌روز است.");
  } catch (e) {
    setStatus("خطا در بررسی آپدیت: " + errMsg(e));
  }
}

// ---------- بارگذاری دستی فایل آپدیت (از موتور جدید) ----------

async function pickAndLoadUpdateFile(statusEl?: HTMLElement): Promise<void> {
  const setStatus = (t: string) => {
    if (statusEl) statusEl.textContent = t;
  };
  let path: string | null = null;
  try {
    path = await api.openUpdateFileDialog();
  } catch (e) {
    setStatus("خطا در باز کردن فایل: " + errMsg(e));
    return;
  }
  if (!path) return; // کاربر انصراف داد

  const overlay = openDialog(`
    <h3>📦 بارگذاری دستی فایل آپدیت</h3>
    <p>فایل انتخاب‌شده: <b>${esc(fileNameOf(path))}</b></p>
    <p>با بارگذاری این فایل، آپدیت اعمال می‌شود و برنامه بسته و دوباره باز می‌شود. ادامه می‌دهید؟</p>
    <div class="upd-actions">
      <button class="btn" id="upd-file-yes">بارگذاری و نصب</button>
      <button class="btn ghost" id="upd-file-no">انصراف</button>
    </div>`);
  overlay.querySelector("#upd-file-no")!.addEventListener("click", closeDialog);
  overlay.querySelector("#upd-file-yes")!.addEventListener("click", () => {
    void (async () => {
      closeDialog();
      setStatus("در حال اعمال فایل آپدیت…");
      try {
        await api.applyLocalUpdate(path!);
        setStatus("آپدیت در حال اعمال است؛ برنامه راه‌اندازی مجدد می‌شود…");
      } catch (e) {
        setStatus("");
        showErrorDialog("خطا در بارگذاری فایل آپدیت", errMsg(e));
      }
    })();
  });
}

// ---------- بخش «به‌روزرسانی» برای صفحه‌ی تنظیمات (هماهنگ با EAgent5) ----------

export function renderUpdateSettings(container: HTMLElement): void {
  container.innerHTML = `
    <div class="card">
      <h2>به‌روزرسانی</h2>
      <div class="upd-mode-group" id="upd-mode-group">
        <label>
          <input type="radio" name="upd-mode" value="auto" />
          <span>خودکار <span class="upd-mode-desc">— آپدیت بی‌صدا در پس‌زمینه دانلود می‌شود و وقتی آماده شد، برای نصب خبر می‌دهد.</span></span>
        </label>
        <label>
          <input type="radio" name="upd-mode" value="notify" />
          <span>اطلاع‌رسانی <span class="upd-mode-desc">— فقط خبر می‌دهد؛ دانلود و نصب با تأیید شما انجام می‌شود.</span></span>
        </label>
        <label>
          <input type="radio" name="upd-mode" value="off" />
          <span>خاموش <span class="upd-mode-desc">— بدون بررسی خودکار؛ فقط بررسی دستی از همین‌جا.</span></span>
        </label>
      </div>
      <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
        <button class="btn" id="upd-check-now">بررسی الآن</button>
        <button class="btn ghost" id="upd-load-file">بارگذاری دستی فایل آپدیت</button>
        <span id="upd-check-status" style="color: var(--muted); font-size: 13px;"></span>
      </div>
    </div>`;

  const status = container.querySelector<HTMLElement>("#upd-check-status")!;
  const checkBtn = container.querySelector<HTMLButtonElement>("#upd-check-now")!;
  const fileBtn = container.querySelector<HTMLButtonElement>("#upd-load-file")!;
  const radios = container.querySelectorAll<HTMLInputElement>('input[name="upd-mode"]');

  void (async () => {
    mode = await getMode();
    radios.forEach((r) => {
      r.checked = r.value === mode;
    });
  })();

  radios.forEach((r) => {
    r.addEventListener("change", () => {
      if (!r.checked) return;
      const v = r.value as UpdateMode;
      void (async () => {
        try {
          await api.setSetting(MODE_KEY, v);
          mode = v;
          status.textContent = "حالت آپدیت ذخیره شد.";
        } catch (e) {
          status.textContent = "خطا در ذخیره‌ی تنظیم: " + errMsg(e);
        }
      })();
    });
  });

  checkBtn.addEventListener("click", () => {
    checkBtn.disabled = true;
    void manualCheckUpdate(status).finally(() => {
      checkBtn.disabled = false;
    });
  });

  fileBtn.addEventListener("click", () => {
    void pickAndLoadUpdateFile(status);
  });
}

// ---------- راه‌اندازی (از main.ts صدا زده می‌شود) ----------

export async function initUpdateUI(): Promise<void> {
  if (initialized) return;
  initialized = true;
  ensureStyles();

  headerButton()?.addEventListener("click", onHeaderButtonClick);

  // شنونده‌ی سراسری پیشرفت دانلود موتور جدید
  try {
    await listen<{ percent: number; downloaded: number; total: number }>(
      "update-progress2",
      (e) => {
        progress = {
          percent: typeof e.payload?.percent === "number" ? e.payload.percent : 0,
          downloaded: typeof e.payload?.downloaded === "number" ? e.payload.downloaded : 0,
          total: typeof e.payload?.total === "number" ? e.payload.total : 0,
        };
        renderHeaderButton();
        updateProgressDialog();
      }
    );
  } catch {
    // رویداد در دسترس نبود — دانلود بدون درصد هم کار می‌کند
  }

  mode = await getMode();

  // ۱) اول از همه: گزارش نتیجه‌ی آپدیت قبلی
  await showUpdateReport();
  renderHeaderButton();

  // ۲) زمان‌بند چک خودکار — داخل هر اجرا، حالت از تنظیم خوانده می‌شود و off یعنی رد شدن
  scheduleChecks();
}
