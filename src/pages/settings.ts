// شیرین حساب — صفحه‌ی اطلاعات قناد (نام صادرکننده‌ی فاکتور + شماره تلفن)
import { api } from "../lib/api";

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

export function renderSettings(root: HTMLElement): void {
  let name = "";
  let phone = "";
  let msg = "";
  let msgOk = true;
  let loading = true;
  let saving = false;

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
      </div>`;

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

  void load();
}
