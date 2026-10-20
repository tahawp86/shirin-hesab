// شیرین حساب — صفحه‌ی مدیریت محصولات (نام + قیمت واحد)
import { api, type Product } from "../lib/api";
import { fmtMoney } from "../lib/jalali";

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";

/** تبدیل ارقام فارسی/عربی به لاتین برای پارس عدد */
function toLatinDigits(s: string): string {
  return s
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));
}

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

export function renderProducts(root: HTMLElement): void {
  let products: Product[] = [];
  let editingId: number | null = null;
  let draftName = "";
  let draftPrice = "";
  let formError = "";
  let loading = true;

  async function refresh(): Promise<void> {
    loading = true;
    formError = "";
    draw();
    try {
      products = await api.listProducts();
    } catch (e) {
      formError = "خطا در بارگذاری محصولات: " + errMsg(e);
    }
    loading = false;
    draw();
  }

  function draw(): void {
    const rows = products
      .map(
        (p) => `
      <tr>
        <td>${esc(p.name)}</td>
        <td>${fmtMoney(p.unit_price)}</td>
        <td>
          <button class="btn ghost btn-edit" data-id="${p.id}">ویرایش</button>
          <button class="btn danger btn-del" data-id="${p.id}">حذف</button>
        </td>
      </tr>`
      )
      .join("");

    root.innerHTML = `
      <div class="card">
        <h2>${editingId === null ? "افزودن محصول" : "ویرایش محصول"}</h2>
        ${
          formError
            ? `<p style="color: var(--danger); margin: 0 0 10px;">${esc(formError)}</p>`
            : ""
        }
        <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
          <input id="p-name" placeholder="نام محصول" value="${esc(draftName)}" />
          <input id="p-price" placeholder="قیمت واحد (ریال)" inputmode="numeric" value="${esc(draftPrice)}" />
          <button class="btn" id="p-save">${editingId === null ? "افزودن" : "ذخیره"}</button>
          ${
            editingId !== null
              ? `<button class="btn ghost" id="p-cancel">انصراف</button>`
              : ""
          }
        </div>
      </div>
      <div class="card">
        <h2>محصولات</h2>
        ${
          loading
            ? "<p>در حال بارگذاری…</p>"
            : `<table>
          <thead><tr><th>نام</th><th>قیمت واحد</th><th>عملیات</th></tr></thead>
          <tbody>${
            rows ||
            `<tr><td colspan="3" style="text-align:center; color: var(--muted);">محصولی ثبت نشده است.</td></tr>`
          }</tbody>
        </table>`
        }
      </div>`;

    const nameEl = root.querySelector<HTMLInputElement>("#p-name");
    const priceEl = root.querySelector<HTMLInputElement>("#p-price");
    const saveBtn = root.querySelector<HTMLButtonElement>("#p-save");
    const cancelBtn = root.querySelector<HTMLButtonElement>("#p-cancel");
    if (!nameEl || !priceEl || !saveBtn) return;

    nameEl.addEventListener("input", () => {
      draftName = nameEl.value;
    });
    priceEl.addEventListener("input", () => {
      draftPrice = priceEl.value;
    });
    saveBtn.addEventListener("click", () => void onSave());
    cancelBtn?.addEventListener("click", () => {
      editingId = null;
      draftName = "";
      draftPrice = "";
      formError = "";
      draw();
    });

    root.querySelectorAll<HTMLButtonElement>(".btn-edit").forEach((b) =>
      b.addEventListener("click", () => {
        const id = Number(b.dataset.id);
        const p = products.find((x) => x.id === id);
        if (!p) return;
        editingId = id;
        draftName = p.name;
        draftPrice = String(p.unit_price);
        formError = "";
        draw();
      })
    );

    root.querySelectorAll<HTMLButtonElement>(".btn-del").forEach((b) =>
      b.addEventListener("click", () => void onDelete(Number(b.dataset.id)))
    );
  }

  async function onSave(): Promise<void> {
    const name = draftName.trim();
    const price = Number(toLatinDigits(draftPrice.trim()).replace(/,/g, ""));
    if (!name) {
      formError = "نام محصول را وارد کنید.";
      draw();
      return;
    }
    if (!Number.isFinite(price) || price <= 0) {
      formError = "قیمت واحد باید عددی بزرگ‌تر از صفر باشد.";
      draw();
      return;
    }
    formError = "";
    try {
      if (editingId === null) {
        await api.addProduct(name, price);
      } else {
        await api.updateProduct({ id: editingId, name, unit_price: price });
      }
      editingId = null;
      draftName = "";
      draftPrice = "";
      await refresh();
    } catch (e) {
      formError = "خطا در ذخیره‌سازی: " + errMsg(e);
      draw();
    }
  }

  async function onDelete(id: number): Promise<void> {
    const p = products.find((x) => x.id === id);
    if (!p) return;
    if (!window.confirm(`«${p.name}» حذف شود؟`)) return;
    try {
      await api.deleteProduct(id);
      if (editingId === id) {
        editingId = null;
        draftName = "";
        draftPrice = "";
      }
      await refresh();
    } catch (e) {
      formError = "خطا در حذف: " + errMsg(e);
      draw();
    }
  }

  void refresh();
}
