// شیرین حساب — رابط کاربری موتور به‌روزرسانی (فلو مشابه IAS-CMS)
// بک‌اند: EAgent1 — کامندها از api.ts صدا زده می‌شوند (قرارداد ثابت).
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, type UpdateInfo } from "./api";

const AUTO_CHECK_KEY = "auto_update_check";
const NOTIFIED_KEY = "update_notified_version";
const FIRST_CHECK_DELAY_MS = 10_000; // اولین چک: ۱۰ ثانیه بعد از بالا آمدن
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // چک‌های بعدی: هر ۱ ساعت

let initialized = false;
let checking = false;
let pendingUpdate: UpdateInfo | null = null;
let sessionNotifiedVersion: string | null = null; // نسخه‌ای که در این اجرا toast آن نشان داده شده
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

function faPercent(p: number): string {
  const clamped = Math.max(0, Math.min(100, Math.round(p)));
  return clamped.toLocaleString("fa-IR") + "٪";
}

function ensureStyles(): void {
  if (document.getElementById("upd-style")) return;
  const st = document.createElement("style");
  st.id = "upd-style";
  st.textContent = `
    .upd-nav-btn {
      border: 1px solid var(--accent); background: var(--accent); color: #fff;
      padding: 8px 18px; border-radius: 10px; cursor: pointer; font-size: 15px; font-family: inherit;
    }
    .upd-nav-btn:hover { background: var(--accent-dark); }
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
    .upd-actions { display: flex; gap: 8px; justify-content: flex-start; margin-top: 6px; }
    .upd-error { color: var(--danger); }
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
  `;
  document.head.appendChild(st);
}

// ---------- دیالوگ عمومی ----------

function closeDialog(): void {
  dialogEl?.remove();
  dialogEl = null;
}

function openDialog(html: string): HTMLElement {
  closeDialog();
  const overlay = document.createElement("div");
  overlay.className = "upd-overlay";
  overlay.innerHTML = `<div class="upd-dialog">${html}</div>`;
  document.body.appendChild(overlay);
  dialogEl = overlay;
  return overlay;
}

// ---------- گزارش نتیجه‌ی آپدیت قبلی (اولین کار در استارت) ----------

async function showUpdateReport(): Promise<void> {
  let report: Awaited<ReturnType<typeof api.getUpdateReport>>;
  try {
    report = await api.getUpdateReport();
  } catch {
    return; // بک‌اند هنوز آماده نیست یا گزارشی نیست — بی‌صدا رد شو
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

// ---------- دکمه‌ی هدر و toast ----------

function headerButton(): HTMLElement | null {
  return document.getElementById("update-btn");
}

function showHeaderButton(): void {
  const btn = headerButton();
  if (btn) btn.style.display = "";
}

function hideHeaderButton(): void {
  const btn = headerButton();
  if (btn) btn.style.display = "none";
}

function hideToast(): void {
  toastEl?.remove();
  toastEl = null;
}

function showToast(info: UpdateInfo): void {
  hideToast();
  const el = document.createElement("div");
  el.className = "upd-toast";
  const note = firstLine(info.notes);
  el.innerHTML = `
    <div class="upd-toast-title">⬆️ آپدیت جدید منتشر شد! (v${esc(info.version)})</div>
    ${note ? `<div class="upd-toast-note">${esc(note)}</div>` : ""}
    <div class="upd-actions">
      <button class="btn" id="upd-toast-install">⬆️ دانلود و نصب</button>
      <button class="btn ghost" id="upd-toast-close">✖</button>
    </div>`;
  document.body.appendChild(el);
  toastEl = el;
  el.querySelector("#upd-toast-install")!.addEventListener("click", () => {
    hideToast();
    openConfirmDialog(info);
  });
  el.querySelector("#upd-toast-close")!.addEventListener("click", hideToast);
}

// ---------- دیالوگ تأیید و دانلود ----------

function openConfirmDialog(info: UpdateInfo): void {
  pendingUpdate = info;
  const overlay = openDialog(`
    <h3>⬆️ آپدیت جدید</h3>
    <p>آپدیت جدید v${esc(info.version)} منتشر شده است.</p>
    ${info.notes ? `<div class="upd-notes">${esc(truncate(info.notes, 500))}</div>` : ""}
    <p>فایل آپدیت دانلود و بلافاصله اعمال می‌شود؛ برنامه بسته و دوباره باز می‌شود. ادامه می‌دهید؟</p>
    <div class="upd-actions">
      <button class="btn" id="upd-confirm-yes">بله، دانلود و نصب</button>
      <button class="btn ghost" id="upd-confirm-no">خیر</button>
    </div>`);
  overlay.querySelector("#upd-confirm-no")!.addEventListener("click", closeDialog);
  overlay.querySelector("#upd-confirm-yes")!.addEventListener("click", () => {
    void startDownload();
  });
}

async function startDownload(): Promise<void> {
  const overlay = openDialog(`
    <h3>⬆️ در حال دانلود آپدیت…</h3>
    <div class="upd-progress-track"><div class="upd-progress-fill" id="upd-fill"></div></div>
    <div class="upd-progress-text" id="upd-ptext">${faPercent(0)}</div>
    <div class="upd-actions">
      <button class="btn ghost" id="upd-cancel">انصراف</button>
    </div>`);
  const fill = overlay.querySelector<HTMLElement>("#upd-fill")!;
  const ptext = overlay.querySelector<HTMLElement>("#upd-ptext")!;
  const cancelBtn = overlay.querySelector<HTMLButtonElement>("#upd-cancel")!;

  let cancelled = false;
  let unlisten: UnlistenFn | null = null;
  try {
    unlisten = await listen<{ percent: number }>("update-progress", (e) => {
      const p = typeof e.payload?.percent === "number" ? e.payload.percent : 0;
      fill.style.width = `${Math.max(0, Math.min(100, p))}%`;
      ptext.textContent = faPercent(p);
    });
  } catch {
    // اگر رویداد در دسترس نبود، دانلود بدون درصد هم ادامه پیدا می‌کند
  }

  cancelBtn.addEventListener("click", () => {
    cancelled = true;
    try {
      void api.cancelUpdateDownload();
    } catch {
      // بی‌صدا
    }
    unlisten?.();
    closeDialog(); // بستن بی‌سروصدا
  });

  try {
    await api.downloadAndApplyUpdate();
    if (cancelled) return;
    unlisten?.();
    // دانلود و اعمال تمام شده؛ بک‌اند برنامه را می‌بندد و دوباره باز می‌کند
    ptext.textContent = "آپدیت دانلود و اعمال شد؛ برنامه در حال راه‌اندازی مجدد است…";
    cancelBtn.style.display = "none";
  } catch (e) {
    unlisten?.();
    if (cancelled) return; // خطای ناشی از انصراف کاربر است — بی‌صدا
    const overlay2 = openDialog(`
      <h3>⚠️ خطا در به‌روزرسانی</h3>
      <p class="upd-error">دانلود یا اعمال آپدیت با خطا مواجه شد:</p>
      <div class="upd-notes">${esc(errMsg(e))}</div>
      <div class="upd-actions">
        <button class="btn" id="upd-err-close">بستن</button>
      </div>`);
    overlay2.querySelector("#upd-err-close")!.addEventListener("click", closeDialog);
  }
}

// ---------- منطق بررسی آپدیت ----------

async function isAutoCheckEnabled(): Promise<boolean> {
  try {
    const v = await api.getSetting(AUTO_CHECK_KEY);
    if (v === null || v === undefined || v === "") return true; // پیش‌فرض: روشن
    return !["0", "false", "off", "no"].includes(String(v).trim().toLowerCase());
  } catch {
    return true;
  }
}

// اطلاع‌رسانی آپدیت تازه (دکمه‌ی هدر + toast) با ضداسپم بین ری‌استارت‌ها
async function notifyUpdate(info: UpdateInfo): Promise<void> {
  let notified: string | null = null;
  try {
    notified = await api.getSetting(NOTIFIED_KEY);
  } catch {
    // بدون حافظه هم ادامه بده
  }
  if (notified === info.version || sessionNotifiedVersion === info.version) {
    showHeaderButton(); // آپدیت هست؛ دکمه بماند ولی toast دوباره نیاید
    return;
  }
  sessionNotifiedVersion = info.version;
  showHeaderButton();
  showToast(info);
  try {
    await api.setSetting(NOTIFIED_KEY, info.version);
  } catch {
    // ذخیره نشد هم اشکالی ندارد؛ گارد همین اجرا جلوی تکرار را می‌گیرد
  }
}

// مسیر مشترک بررسی؛ manual=true یعنی کاربر صریحاً خواسته (دکمه‌ی «بررسی الآن»)
async function runCheck(manual: boolean): Promise<UpdateInfo | null> {
  if (checking) return pendingUpdate;
  checking = true;
  try {
    const info = await api.checkUpdate();
    if (info) {
      pendingUpdate = info;
      if (manual) {
        showHeaderButton();
        openConfirmDialog(info);
      } else {
        await notifyUpdate(info);
      }
    } else {
      pendingUpdate = null;
      hideHeaderButton();
      hideToast();
    }
    return info;
  } finally {
    checking = false;
  }
}

async function autoCheck(): Promise<void> {
  if (!(await isAutoCheckEnabled())) return;
  try {
    await runCheck(false);
  } catch {
    // چک خودکار بی‌صداست؛ خطای شبکه نباید مزاحم کاربر شود
  }
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

// ---------- بخش «به‌روزرسانی» برای صفحه‌ی تنظیمات (هماهنگ با EAgent5) ----------

export function renderUpdateSettings(container: HTMLElement): void {
  container.innerHTML = `
    <div class="card">
      <h2>به‌روزرسانی</h2>
      <label style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px; cursor: pointer;">
        <input type="checkbox" id="upd-auto-toggle" />
        <span>بررسی خودکار آپدیت</span>
      </label>
      <div style="display: flex; align-items: center; gap: 10px;">
        <button class="btn" id="upd-check-now">بررسی الآن</button>
        <span id="upd-check-status" style="color: var(--muted); font-size: 13px;"></span>
      </div>
      <div style="display: flex; align-items: center; gap: 10px; margin-top: 12px;">
        <button class="btn ghost" id="upd-manual">بارگذاری دستی فایل آپدیت</button>
        <span id="upd-manual-status" style="color: var(--muted); font-size: 13px;"></span>
      </div>
      <p style="color: var(--muted); font-size: 13px; margin: 8px 0 0; line-height: 1.9;">
        اگر فایل آپدیت (ZIP) را دستی دریافت کرده‌اید، از این‌جا انتخابش کنید؛ برنامه سالم‌بودنش را بررسی می‌کند، نصبش می‌کند و دوباره باز می‌شود.
      </p>
    </div>`;

  const toggle = container.querySelector<HTMLInputElement>("#upd-auto-toggle")!;
  const checkBtn = container.querySelector<HTMLButtonElement>("#upd-check-now")!;
  const status = container.querySelector<HTMLElement>("#upd-check-status")!;

  void (async () => {
    toggle.checked = await isAutoCheckEnabled();
  })();

  toggle.addEventListener("change", () => {
    void (async () => {
      try {
        await api.setSetting(AUTO_CHECK_KEY, toggle.checked ? "1" : "0");
        status.textContent = toggle.checked
          ? "بررسی خودکار آپدیت روشن شد."
          : "بررسی خودکار آپدیت خاموش شد.";
      } catch (e) {
        status.textContent = "خطا در ذخیره‌ی تنظیم: " + errMsg(e);
      }
    })();
  });

  checkBtn.addEventListener("click", () => {
    checkBtn.disabled = true;
    void manualCheckUpdate(status).finally(() => {
      checkBtn.disabled = false;
    });
  });

  const manualBtn = container.querySelector<HTMLButtonElement>("#upd-manual")!;
  const manualStatus = container.querySelector<HTMLElement>("#upd-manual-status")!;

  manualBtn.addEventListener("click", () => {
    void (async () => {
      manualStatus.textContent = "";
      let path: string | null;
      try {
        path = await api.openUpdateFileDialog();
      } catch (e) {
        manualStatus.textContent = "خطا در باز کردن انتخاب فایل: " + errMsg(e);
        return;
      }
      if (!path) return; // کاربر لغو کرد
      const fileName = path.split(/[\\/]/).pop() ?? path;
      const overlay = openDialog(`
        <h3>⬆️ نصب آپدیت از فایل</h3>
        <p>فایل «${esc(fileName)}» بررسی و نصب می‌شود؛ برنامه بسته و دوباره باز می‌شود. ادامه می‌دهید؟</p>
        <div class="upd-actions">
          <button class="btn" id="upd-local-yes">بله، نصب شود</button>
          <button class="btn ghost" id="upd-local-no">خیر</button>
        </div>`);
      overlay.querySelector("#upd-local-no")!.addEventListener("click", closeDialog);
      overlay.querySelector("#upd-local-yes")!.addEventListener("click", () => {
        void (async () => {
          try {
            await api.applyLocalUpdate(path!);
            // موفقیت: برنامه بسته و موتور آپدیت اجرا می‌شود
            closeDialog();
            manualStatus.textContent = "در حال نصب آپدیت…";
          } catch (e) {
            const overlay2 = openDialog(`
              <h3>⚠️ خطا در نصب آپدیت</h3>
              <p class="upd-error">فایل آپدیت قابل نصب نیست:</p>
              <div class="upd-notes">${esc(errMsg(e))}</div>
              <div class="upd-actions">
                <button class="btn" id="upd-local-err-close">بستن</button>
              </div>`);
            overlay2.querySelector("#upd-local-err-close")!.addEventListener("click", closeDialog);
          }
        })();
      });
    })();
  });
}

// ---------- راه‌اندازی (از main.ts صدا زده می‌شود) ----------

export async function initUpdateUI(): Promise<void> {
  if (initialized) return;
  initialized = true;
  ensureStyles();

  const btn = headerButton();
  btn?.addEventListener("click", () => {
    if (pendingUpdate) openConfirmDialog(pendingUpdate);
  });

  // ۱) اول از همه: گزارش نتیجه‌ی آپدیت قبلی
  await showUpdateReport();

  // ۲) چک خودکار: ۱۰ ثانیه بعد از بالا آمدن + هر ۱ ساعت (فقط اگر روشن باشد)
  window.setTimeout(() => void autoCheck(), FIRST_CHECK_DELAY_MS);
  window.setInterval(() => void autoCheck(), CHECK_INTERVAL_MS);
}
