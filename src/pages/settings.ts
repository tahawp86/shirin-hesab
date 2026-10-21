// شیرین حساب — صفحه‌ی اطلاعات قناد (فرم قناد + به‌روزرسانی + پشتیبان‌گیری و انتقال)
import { api, type BackupInfo } from "../lib/api";
import { renderUpdateSettings } from "../lib/update-ui";
import { navigate } from "../lib/router";

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

function faCount(n: number): string {
  return (Number.isFinite(n) ? n : 0).toLocaleString("fa-IR");
}

export function renderSettings(root: HTMLElement): void {
  let name = "";
  let phone = "";
  let msg = "";
  let msgOk = true;
  let loading = true;
  let saving = false;

  // وضعیت بخش پشتیبان‌گیری و انتقال
  let backupBusy = false;
  let backupMsg = "";
  let backupMsgOk = true;
  let backupInfo: BackupInfo | null = null;

  async function load(): Promise<void> {
    loading = true;
    msg = "";
    draw();
    try {
      const info = await api.getConfectionerInfo();
      name = info.name ?? "";
      phone = info.phone ?? "";
    } catch (e) {
      msg = "خطا در بارگذاری اطلاعات: " + errMsg(e);
      msgOk = false;
    }
    loading = false;
    draw();
  }

  function backupSectionHtml(): string {
    if (backupInfo) {
      const c = backupInfo.counts;
      return `
        <div style="background: #fdf3e0; border: 1px solid #f0dfba; border-radius: 10px; padding: 12px 14px; max-width: 560px;">
          <p style="margin: 0 0 8px;"><b>خلاصه‌ی بک‌آپ انتخاب‌شده:</b></p>
          <ul style="margin: 0 0 10px; padding-inline-start: 20px; line-height: 1.9;">
            <li>تاریخ خروجی: ${esc(backupInfo.exported_at)}</li>
            <li>واحد پول: ${esc(backupInfo.currency)}</li>
            <li>مشتری‌ها: ${faCount(c.customers)}</li>
            <li>محصولات: ${faCount(c.products)}</li>
            <li>فاکتورها: ${faCount(c.invoices)}</li>
            <li>پرداخت‌ها: ${faCount(c.payments)}</li>
          </ul>
          <p style="color: var(--danger); font-weight: 700; margin: 0 0 12px;">⚠️ هشدار: همه‌ی اطلاعات فعلی با این بک‌آپ جایگزین می‌شود و قابل برگشت نیست.</p>
          <div style="display: flex; gap: 10px;">
            <button class="btn danger" id="b-confirm" ${backupBusy ? "disabled" : ""}>${backupBusy ? "در حال وارد کردن…" : "تأیید و جایگزینی"}</button>
            <button class="btn ghost" id="b-cancel" ${backupBusy ? "disabled" : ""}>انصراف</button>
          </div>
        </div>`;
    }
    return `
      <div style="display: flex; gap: 10px; flex-wrap: wrap;">
        <button class="btn" id="b-export" ${backupBusy ? "disabled" : ""}>خروجی گرفتن از اطلاعات</button>
        <button class="btn ghost" id="b-import" ${backupBusy ? "disabled" : ""}>وارد کردن اطلاعات</button>
      </div>
      <p style="color: var(--muted); font-size: 13px; margin: 8px 0 0; line-height: 1.9;">
        از همه‌ی اطلاعات (مشتری‌ها، محصولات، فاکتورها و پرداخت‌ها) یک فایل پشتیبان بگیرید یا بک‌آپ قبلی را برگردانید.
      </p>`;
  }

  function draw(): void {
    root.innerHTML = `
      <div class="card">
        <h2>اطلاعات قناد</h2>
        ${
          loading
            ? "<p>در حال بارگذاری…</p>"
            : `
        ${
          msg
            ? `<p style="color: ${
              msgOk ? "var(--ok)" : "var(--danger)"
            }; margin: 0 0 10px;">${esc(msg)}</p>`
            : ""
        }
        <div style="display: flex; flex-direction: column; gap: 10px; max-width: 420px;">
          <label>
            <span style="display: block; margin-bottom: 4px; color: var(--muted); font-size: 13px;">نام صادرکننده فاکتور</span>
            <input id="s-name" placeholder="مثلاً قنادی شیرین" value="${esc(name)}" style="width: 100%;" />
          </label>
          <label>
            <span style="display: block; margin-bottom: 4px; color: var(--muted); font-size: 13px;">شماره تلفن</span>
            <input id="s-phone" placeholder="مثلاً ۰۹۱۲۳۴۵۶۷۸۹" inputmode="tel" value="${esc(phone)}" style="width: 100%;" />
          </label>
          <div>
            <button class="btn" id="s-save" ${saving ? "disabled" : ""}>${
              saving ? "در حال ذخیره…" : "ذخیره"
            }</button>
          </div>
        </div>`
        }
      </div>
      <div id="update-settings-slot"></div>
      <div class="card">
        <h2>پشتیبان‌گیری و انتقال</h2>
        ${
          backupMsg
            ? `<p style="color: ${
              backupMsgOk ? "var(--ok)" : "var(--danger)"
            }; margin: 0 0 10px; word-break: break-all;">${esc(backupMsg)}</p>`
            : ""
        }
        ${backupSectionHtml()}
      </div>`;

    const slot = root.querySelector<HTMLElement>("#update-settings-slot");
    if (slot) renderUpdateSettings(slot);

    // بخش پشتیبان‌گیری
    if (backupInfo) {
      root.querySelector<HTMLButtonElement>("#b-confirm")?.addEventListener("click", () => void onConfirmImport());
      root.querySelector<HTMLButtonElement>("#b-cancel")?.addEventListener("click", () => {
        backupInfo = null;
        backupMsg = "";
        draw();
      });
    } else {
      root.querySelector<HTMLButtonElement>("#b-export")?.addEventListener("click", () => void onExport());
      root.querySelector<HTMLButtonElement>("#b-import")?.addEventListener("click", () => void onPickImport());
    }

    if (loading) return;
    const nameEl = root.querySelector<HTMLInputElement>("#s-name");
    const phoneEl = root.querySelector<HTMLInputElement>("#s-phone");
    const saveBtn = root.querySelector<HTMLButtonElement>("#s-save");
    if (!nameEl || !phoneEl || !saveBtn) return;

    nameEl.addEventListener("input", () => {
      name = nameEl.value;
    });
    phoneEl.addEventListener("input", () => {
      phone = phoneEl.value;
    });
    saveBtn.addEventListener("click", () => void onSave());
  }

  async function onSave(): Promise<void> {
    const n = name.trim();
    const p = phone.trim();
    if (!n) {
      msg = "نام صادرکننده فاکتور را وارد کنید.";
      msgOk = false;
      draw();
      return;
    }
    saving = true;
    msg = "";
    draw();
    try {
      await api.setConfectionerInfo(n, p);
      msg = "اطلاعات با موفقیت ذخیره شد.";
      msgOk = true;
    } catch (e) {
      msg = "خطا در ذخیره‌سازی: " + errMsg(e);
      msgOk = false;
    }
    saving = false;
    draw();
  }

  async function onExport(): Promise<void> {
    backupBusy = true;
    backupMsg = "";
    draw();
    try {
      const path = await api.exportBackup();
      if (path) {
        backupMsg = "خروجی با موفقیت ذخیره شد: " + path;
        backupMsgOk = true;
      }
    } catch (e) {
      backupMsg = "خطا در خروجی گرفتن: " + errMsg(e);
      backupMsgOk = false;
    }
    backupBusy = false;
    draw();
  }

  async function onPickImport(): Promise<void> {
    backupBusy = true;
    backupMsg = "";
    draw();
    try {
      const info = await api.pickAndValidateBackup();
      if (info) backupInfo = info;
    } catch (e) {
      backupMsg = "فایل بک‌آپ معتبر نیست: " + errMsg(e);
      backupMsgOk = false;
    }
    backupBusy = false;
    draw();
  }

  async function onConfirmImport(): Promise<void> {
    if (!backupInfo) return;
    const path = backupInfo.path;
    backupBusy = true;
    backupMsg = "";
    draw();
    try {
      await api.applyBackupImport(path);
      backupInfo = null;
      // داده‌ها عوض شده‌اند؛ برگرد به صفحه‌ی مشتری‌ها تا همه‌چیز تازه بارگذاری شود
      navigate("customers");
      return;
    } catch (e) {
      backupMsg = "خطا در وارد کردن اطلاعات: " + errMsg(e);
      backupMsgOk = false;
    }
    backupBusy = false;
    draw();
  }

  void load();
}
