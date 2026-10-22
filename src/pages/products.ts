// شیرین حساب — صفحه‌ی مدیریت محصولات (نام، واحد، قیمت خرید/فروش، موجودی)
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

const faNum = (n: number): string => n.toLocaleString("fa-IR");

const UNIT_SUGGESTIONS = ["عدد", "کیلوگرم", "گرم", "جعبه", "بسته", "لیتر", "متر", "شیشه", "کارتن"];

/** وضعیت موجودی برای نشان هشدار: «out» ناموجود، «low» کم‌موجود، null یعنی عادی/نامشخص */
function stockState(p: Product): "out" | "low" | null {
  if (typeof p.stock !== "number") return null;
  if (p.stock <= 0) return "out";
  if (typeof p.min_stock === "number" && p.stock <= p.min_stock) return "low";
  return null;
}

export function renderProducts(root: HTMLElement): void {
  let products: Product[] = [];
  let editingId: number | null = null;
  let draftName = "";
  let draftUnit = "";
  let draftPrice = "";
  let draftPurchase = "";
  let draftStock = "";
  let draftMinStock = "";
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

  function clearDraft(): void {
    draftName = "";
    draftUnit = "";
    draftPrice = "";
    draftPurchase = "";
    draftStock = "";
    draftMinStock = "";
  }

  function draw(): void {
    const rows = products
      .map((p) => {
        const st = stockState(p);
        const badge =
          st === "out"
            ? `<span class="stk stk-out">ناموجود</span>`
            : st === "low"
              ? `<span class="stk stk-low">کم‌موجود</span>`
              : "";
        return `
      <tr>
        <td>${esc(p.name)}</td>
        <td>${esc(p.unit ?? "—")}</td>
        <td>${typeof p.purchase_price === "number" ? fmtMoney(p.purchase_price) : "—"}</td>
        <td>${fmtMoney(p.unit_price)}</td>
        <td>${typeof p.stock === "number" ? faNum(p.stock) : "—"} ${badge}</td>
        <td>
          <button class="btn ghost btn-edit" data-id="${p.id}">ویرایش</button>
          <button class="btn danger btn-del" data-id="${p.id}">حذف</button>
        </td>
      </tr>`;
      })
      .join("");

    root.innerHTML = `
    <style>
      .stk { display:inline-block; padding:1px 9px; border-radius:999px; font-size:12px; font-weight:700; margin-inline-start:6px; vertical-align:middle; }
      .stk-out { background:#fdecec; color:var(--danger); border:1px solid #f3c2c2; }
      .stk-low { background:#fdf3e0; color:#9a6a12; border:1px solid #ecd9ae; }
      .p-form { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
      .p-form input { width:170px; }
      .p-form input.p-unit { width:120px; }
      .p-form input.p-num { width:130px; }
    </style>
      <div class="card">
        <h2>${editingId === null ? "افزودن محصول" : "ویرایش محصول"}</h2>
        ${
          formError
            ? `<p style="color: var(--danger); margin: 0 0 10px;">${esc(formError)}</p>`
            : ""
        }
        <div class="p-form">
          <input id="p-name" placeholder="نام محصول" value="${esc(draftName)}" />
          <input id="p-unit" class="p-unit" placeholder="واحد (عدد، کیلو…)" list="unitList" value="${esc(draftUnit)}" />
          <datalist id="unitList">${UNIT_SUGGESTIONS.map((u) => `<option value="${u}"></option>`).join("")}</datalist>
          <input id="p-purchase" class="p-num" placeholder="قیمت خرید (ریال)" inputmode="numeric" value="${esc(draftPurchase)}" />
          <input id="p-price" class="p-num" placeholder="قیمت فروش (ریال)" inputmode="numeric" value="${esc(draftPrice)}" />
          <input id="p-stock" class="p-num" placeholder="موجودی فعلی" inputmode="decimal" value="${esc(draftStock)}" />
          <input id="p-minstock" class="p-num" placeholder="حداقل موجودی" inputmode="decimal" value="${esc(draftMinStock)}" />
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
          <thead><tr><th>نام</th><th>واحد</th><th>قیمت خرید</th><th>قیمت فروش</th><th>موجودی</th><th>عملیات</th></tr></thead>
          <tbody>${
            rows ||
            `<tr><td colspan="6" style="text-align:center; color: var(--muted);">محصولی ثبت نشده است.</td></tr>`
          }</tbody>
        </table>`
        }
      </div>`;

    const bind = (id: string, set: (v: string) => void): HTMLInputElement | null => {
      const el = root.querySelector<HTMLInputElement>(id);
      el?.addEventListener("input", () => set(el.value));
      return el;
    };
    bind("#p-name", (v) => (draftName = v));
    bind("#p-unit", (v) => (draftUnit = v));
    bind("#p-price", (v) => (draftPrice = v));
    bind("#p-purchase", (v) => (draftPurchase = v));
    bind("#p-stock", (v) => (draftStock = v));
    bind("#p-minstock", (v) => (draftMinStock = v));

    const saveBtn = root.querySelector<HTMLButtonElement>("#p-save");
    const cancelBtn = root.querySelector<HTMLButtonElement>("#p-cancel");
    if (!saveBtn) return;
    saveBtn.addEventListener("click", () => void onSave());
    cancelBtn?.addEventListener("click", () => {
      editingId = null;
      clearDraft();
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
        draftUnit = p.unit ?? "";
        draftPrice = String(p.unit_price);
        draftPurchase = typeof p.purchase_price === "number" ? String(p.purchase_price) : "";
        draftStock = typeof p.stock === "number" ? String(p.stock) : "";
        draftMinStock = typeof p.min_stock === "number" ? String(p.min_stock) : "";
        formError = "";
        draw();
      })
    );

    root.querySelectorAll<HTMLButtonElement>(".btn-del").forEach((b) =>
      b.addEventListener("click", () => void onDelete(Number(b.dataset.id)))
    );
  }

  function parseNum(raw: string): number {
    return Number(toLatinDigits(raw.trim()).replace(/,/g, ""));
  }

  async function onSave(): Promise<void> {
    const name = draftName.trim();
    const unit = draftUnit.trim();
    const price = parseNum(draftPrice);
    const purchase = draftPurchase.trim() === "" ? 0 : parseNum(draftPurchase);
    const stock = draftStock.trim() === "" ? 0 : parseNum(draftStock);
    const minStock = draftMinStock.trim() === "" ? 0 : parseNum(draftMinStock);
    if (!name) {
      formError = "نام محصول را وارد کنید.";
      draw();
      return;
    }
    if (!Number.isFinite(price) || price <= 0) {
      formError = "قیمت فروش باید عددی بزرگ‌تر از صفر باشد.";
      draw();
      return;
    }
    if (!Number.isFinite(purchase) || purchase < 0) {
      formError = "قیمت خرید نمی‌تواند منفی باشد.";
      draw();
      return;
    }
    if (!Number.isFinite(stock) || stock < 0 || !Number.isFinite(minStock) || minStock < 0) {
      formError = "موجودی و حداقل موجودی نمی‌توانند منفی باشند.";
      draw();
      return;
    }
    formError = "";
    try {
      if (editingId === null) {
        await api.addProduct(name, price, unit, purchase, stock, minStock);
      } else {
        await api.updateProduct({
          id: editingId, name, unit_price: price,
          unit, purchase_price: purchase, stock, min_stock: minStock,
        });
      }
      editingId = null;
      clearDraft();
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
        clearDraft();
      }
      await refresh();
    } catch (e) {
      formError = "خطا در حذف: " + errMsg(e);
      draw();
    }
  }

  void refresh();
}
