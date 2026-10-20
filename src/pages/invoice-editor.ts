// شیرین حساب — ویرایشگر فاکتور (ثبت جدید / ویرایش) + خروجی PDF
import { api, type Customer, type Invoice, type InvoiceItem, type Product } from "../lib/api";
import { fmtMoney, toJalali, todayIso } from "../lib/jalali";
import { navigate } from "../lib/router";
import { exportInvoicePdf } from "../lib/pdf";

interface Row {
  key: number;
  manual: boolean;
  productId: number | null;
  name: string;
  unitPrice: number;
  qty: number;
}

const faNum = (n: number): string => n.toLocaleString("fa-IR", { useGrouping: false });

function safeJalali(iso: string): string {
  try {
    return toJalali(iso);
  } catch {
    return iso;
  }
}

function rowTotal(r: Row): number {
  const q = Number.isFinite(r.qty) ? Math.max(0, r.qty) : 0;
  const u = Number.isFinite(r.unitPrice) ? Math.max(0, r.unitPrice) : 0;
  return Math.round(q * u);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** تبدیل ارقام فارسی/عربی به لاتین برای پارس عددی */
function toLatinDigits(s: string): string {
  return s
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
}

export function renderInvoiceEditor(root: HTMLElement, arg: { customer: Customer; invoice?: Invoice }): void {
  if (!arg || !arg.customer) {
    root.innerHTML = `<div class="card"><p>مشتری مشخص نیست.</p></div>`;
    return;
  }
  root.innerHTML = `<div class="card"><p>در حال بارگذاری محصولات…</p></div>`;
  initEditor(root, arg.customer, arg.invoice).catch((e) => {
    root.innerHTML = `<div class="card"><p style="color:var(--danger)">خطا در بارگذاری ویرایشگر: ${escapeHtml(
      String((e as Error)?.message || e)
    )}</p></div>`;
  });
}

async function initEditor(root: HTMLElement, customer: Customer, invoice?: Invoice): Promise<void> {
  let products: Product[] = [];
  let productsError = "";
  try {
    products = await api.listProducts();
  } catch {
    productsError = "لیست محصولات بارگذاری نشد؛ فقط «آیتم دستی» در دسترس است.";
  }

  const rows: Row[] = [];
  let seq = 1;
  const addRow = (r: Omit<Row, "key">): void => {
    rows.push({ ...r, key: seq++ });
  };

  const BALANCE_ROW_NAME = "مانده حساب قبلی";

  // فقط در حالت «فاکتور جدید»: ردیف خودکار «مانده حساب قبلی» با مبلغ بدهکاری فعلی مشتری
  // (اگر صفر یا منفی بود، ردیفی اضافه نمی‌شود). در حالت ویرایش، ردیف ذخیره‌شده
  // دست‌نخورده از آیتم‌های فاکتور پر می‌شود — بدون بازنویسی و بدون محاسبه‌ی مجدد.
  if (!invoice) {
    let debt = 0;
    try {
      debt = (await api.customerSummary(customer.id)).debt;
    } catch {
      debt = 0;
    }
    if (debt > 0) {
      addRow({ manual: true, productId: null, name: BALANCE_ROW_NAME, unitPrice: debt, qty: 1 });
    }
  }

  // حالت ویرایش: آیتم‌های فاکتور از قبل پر باشند (از جمله ردیف «مانده حساب قبلی» ذخیره‌شده)
  // اگر نام و قیمت با محصولی تطابق داشت، ردیف «محصول» می‌شود وگرنه «دستی»
  if (invoice) {
    for (const it of invoice.items) {
      const match = products.find((p) => p.name === it.name && p.unit_price === it.unit_price);
      if (match) {
        addRow({ manual: false, productId: match.id, name: match.name, unitPrice: match.unit_price, qty: it.qty });
      } else {
        addRow({ manual: true, productId: null, name: it.name, unitPrice: it.unit_price, qty: it.qty });
      }
    }
  }

  const isEdit = !!invoice;
  const numberLabel = invoice ? faNum(invoice.invoice_number) : "خودکار";
  const dateLabel = invoice ? safeJalali(invoice.date) : toJalali(todayIso());

  root.innerHTML = `
  <style>
    .inv-meta { display:flex; flex-wrap:wrap; gap:14px 36px; margin:6px 0 16px; align-items:center; }
    .inv-meta .lbl { color:var(--muted); font-size:13px; margin-inline-end:6px; }
    .inv-meta input[readonly] { background:#f7f1e6; border-style:dashed; }
    .inv-tools { display:flex; gap:10px; align-items:center; margin:14px 0 4px; flex-wrap:wrap; }
    .grand { margin-inline-start:auto; font-size:17px; }
    .grand b { color:var(--accent-dark); }
    .inv-actions { display:flex; gap:10px; margin-top:16px; flex-wrap:wrap; }
    .err { color:var(--danger); min-height:22px; margin:8px 0 0; }
    td.c, th.c { text-align:center; }
    .p-sum { font-weight:700; white-space:nowrap; }
    select.p-sel, input.m-name { width:100%; }
    input.p-qty, input.m-qty { width:90px; text-align:center; }
    input.m-unit { width:160px; }
    #invNumber { width:110px; text-align:center; }
  </style>
  <div class="card">
    <h2 style="margin-top:0">${isEdit ? "ویرایش فاکتور" : "فاکتور جدید"}</h2>
    <div class="inv-meta">
      <div><span class="lbl">شماره فاکتور:</span>${isEdit ? `<b>${numberLabel}</b>` : `<input id="invNumber" placeholder="خودکار" inputmode="numeric">`}</div>
      <div><span class="lbl">تاریخ:</span><b>${dateLabel}</b></div>
      <div><span class="lbl">مشتری:</span><input readonly value="${escapeHtml(customer.name)}"></div>
    </div>
    ${productsError ? `<p class="err">${escapeHtml(productsError)}</p>` : ""}
    <table>
      <thead><tr>
        <th class="c" style="width:56px">ردیف</th><th>کالا / شرح</th>
        <th class="c" style="width:110px">تعداد</th><th class="c" style="width:200px">قیمت واحد (ریال)</th>
        <th class="c" style="width:200px">جمع (ریال)</th><th class="c" style="width:90px">عملیات</th>
      </tr></thead>
      <tbody id="invRows"></tbody>
    </table>
    <div class="inv-tools">
      <button class="btn ghost" id="addProduct">+ افزودن کالا از لیست</button>
      <button class="btn ghost" id="addManual">+ آیتم دستی</button>
      <span class="grand">جمع کل فاکتور: <b id="grandTotal">${fmtMoney(0)}</b></span>
    </div>
    <div class="inv-actions">
      <button class="btn" id="saveBtn">${isEdit ? "ذخیره تغییرات" : "ثبت فاکتور"}</button>
      <button class="btn ghost" id="pdfBtn">خروجی PDF</button>
      <button class="btn ghost" id="backBtn">بازگشت</button>
    </div>
    <p class="err" id="formErr"></p>
  </div>`;

  const tbody = root.querySelector<HTMLTableSectionElement>("#invRows")!;
  const grandEl = root.querySelector<HTMLElement>("#grandTotal")!;
  const errEl = root.querySelector<HTMLElement>("#formErr")!;

  const productOptions = (selectedId: number | null): string => {
    const opts = products
      .map(
        (p) =>
          `<option value="${p.id}"${p.id === selectedId ? " selected" : ""}>${escapeHtml(p.name)} — ${faNum(
            p.unit_price
          )} ریال</option>`
      )
      .join("");
    return `<option value="">— انتخاب محصول —</option>${opts}`;
  };

  function rowHtml(r: Row, i: number): string {
    const num = faNum(i + 1);
    const del = `<button class="btn danger p-del" data-key="${r.key}" style="padding:6px 12px">حذف</button>`;
    if (r.manual) {
      return `<tr data-key="${r.key}">
        <td class="c">${num}</td>
        <td><input class="m-name" data-key="${r.key}" placeholder="نام کالا یا خدمت" value="${escapeHtml(r.name)}"></td>
        <td class="c"><input type="number" class="m-qty" data-key="${r.key}" min="1" value="${r.qty}"></td>
        <td class="c"><input type="number" class="m-unit" data-key="${r.key}" min="0" value="${r.unitPrice}" placeholder="قیمت واحد"></td>
        <td class="c"><span class="p-sum" data-sum="${r.key}">${fmtMoney(rowTotal(r))}</span></td>
        <td class="c">${del}</td></tr>`;
    }
    return `<tr data-key="${r.key}">
      <td class="c">${num}</td>
      <td><select class="p-sel" data-key="${r.key}">${productOptions(r.productId)}</select></td>
      <td class="c"><input type="number" class="p-qty" data-key="${r.key}" min="1" value="${r.qty}"></td>
      <td class="c"><span class="p-unit" data-unit="${r.key}">${r.productId ? faNum(r.unitPrice) + " ریال" : "—"}</span></td>
      <td class="c"><span class="p-sum" data-sum="${r.key}">${fmtMoney(rowTotal(r))}</span></td>
      <td class="c">${del}</td></tr>`;
  }

  function updateTotals(): void {
    grandEl.textContent = fmtMoney(rows.reduce((s, r) => s + rowTotal(r), 0));
  }

  function refreshRow(row: Row): void {
    const sumEl = tbody.querySelector(`[data-sum="${row.key}"]`);
    if (sumEl) sumEl.textContent = fmtMoney(rowTotal(row));
    updateTotals();
  }

  function renderRows(): void {
    tbody.innerHTML = rows.length
      ? rows.map((r, i) => rowHtml(r, i)).join("")
      : `<tr><td colspan="6" class="c" style="color:var(--muted);padding:22px">ردیفی ثبت نشده است — از دکمه‌های زیر جدول استفاده کنید.</td></tr>`;
    updateTotals();
  }

  tbody.addEventListener("change", (e) => {
    const t = e.target as HTMLElement;
    const key = Number((t as HTMLSelectElement).dataset.key);
    const row = rows.find((r) => r.key === key);
    if (!row || !t.classList.contains("p-sel")) return;
    const p = products.find((x) => x.id === Number((t as HTMLSelectElement).value));
    if (p) {
      row.productId = p.id;
      row.name = p.name;
      row.unitPrice = p.unit_price;
    } else {
      row.productId = null;
      row.name = "";
      row.unitPrice = 0;
    }
    const unitEl = tbody.querySelector(`[data-unit="${key}"]`);
    if (unitEl) unitEl.textContent = row.productId ? faNum(row.unitPrice) + " ریال" : "—";
    refreshRow(row);
  });

  tbody.addEventListener("input", (e) => {
    const t = e.target as HTMLInputElement;
    const key = Number(t.dataset.key);
    const row = rows.find((r) => r.key === key);
    if (!row) return;
    if (t.classList.contains("p-qty") || t.classList.contains("m-qty")) {
      row.qty = Math.max(0, Math.floor(Number(t.value) || 0));
    } else if (t.classList.contains("m-unit")) {
      row.unitPrice = Math.max(0, Number(t.value) || 0);
    } else if (t.classList.contains("m-name")) {
      row.name = t.value;
    }
    refreshRow(row);
  });

  tbody.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(".p-del") as HTMLElement | null;
    if (!btn) return;
    const ix = rows.findIndex((r) => r.key === Number(btn.dataset.key));
    if (ix >= 0) {
      rows.splice(ix, 1);
      renderRows();
    }
  });

  root.querySelector("#addProduct")!.addEventListener("click", () => {
    addRow({ manual: false, productId: null, name: "", unitPrice: 0, qty: 1 });
    renderRows();
  });
  root.querySelector("#addManual")!.addEventListener("click", () => {
    addRow({ manual: true, productId: null, name: "", unitPrice: 0, qty: 1 });
    renderRows();
  });

  const collectItems = (): InvoiceItem[] =>
    rows
      .filter((r) => r.qty > 0 && r.name.trim() !== "")
      .map((r) => ({ name: r.name.trim(), unit_price: Math.max(0, Math.round(r.unitPrice)), qty: r.qty }));

  const saveBtn = root.querySelector<HTMLButtonElement>("#saveBtn")!;
  saveBtn.addEventListener("click", async () => {
    errEl.textContent = "";
    const items = collectItems();
    if (!items.length) {
      errEl.textContent = "حداقل یک ردیف معتبر (نام + تعداد بیشتر از صفر) وارد کنید.";
      return;
    }
    // شماره فاکتور: خالی = خودکار (بک‌اند max+1 می‌دهد)، وگرنه عدد واردشده
    let invoiceNumber: number | undefined;
    const numInput = root.querySelector<HTMLInputElement>("#invNumber");
    if (numInput && !invoice) {
      const raw = toLatinDigits(numInput.value.trim());
      if (raw) {
        const n = Math.floor(Number(raw));
        if (!Number.isFinite(n) || n <= 0) {
          errEl.textContent = "شماره فاکتور باید یک عدد مثبت باشد؛ یا خالی بگذارید تا خودکار تعیین شود.";
          return;
        }
        invoiceNumber = n;
      }
    }
    saveBtn.disabled = true;
    try {
      if (invoice) await api.updateInvoice(invoice.id, items);
      else await api.createInvoice(customer.id, items, invoiceNumber);
      navigate("customer-invoices", customer);
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      errEl.textContent = /duplicate|تکراری|UNIQUE/i.test(msg)
        ? "این شماره فاکتور قبلاً ثبت شده است؛ شماره دیگری وارد کنید."
        : "خطا در ذخیره فاکتور: " + msg;
      saveBtn.disabled = false;
    }
  });

  const pdfBtn = root.querySelector<HTMLButtonElement>("#pdfBtn")!;
  pdfBtn.addEventListener("click", async () => {
    errEl.textContent = "";
    const items = collectItems();
    if (!items.length) {
      errEl.textContent = "برای خروجی PDF حداقل یک ردیف معتبر لازم است.";
      return;
    }
    pdfBtn.disabled = true;
    try {
      let conf: { name: string; phone: string } | null = null;
      try {
        conf = await api.getConfectionerInfo();
      } catch {
        conf = null; // بدون اطلاعات قناد ادامه می‌دهیم
      }
      const numInput = root.querySelector<HTMLInputElement>("#invNumber");
      const raw = numInput ? toLatinDigits(numInput.value.trim()) : "";
      const n = Math.floor(Number(raw));
      const hasNum = raw !== "" && Number.isFinite(n) && n > 0;
      await exportInvoicePdf({
        invoiceNumber: invoice ? faNum(invoice.invoice_number) : hasNum ? faNum(n) : "خودکار",
        fileNumber: invoice ? String(invoice.invoice_number) : hasNum ? String(n) : "new",
        dateJalali: dateLabel,
        customerName: customer.name,
        items,
        confectionerName: conf?.name,
        confectionerPhone: conf?.phone,
      });
    } catch (e) {
      errEl.textContent = "خطا در ساخت PDF: " + String((e as Error)?.message || e);
    } finally {
      pdfBtn.disabled = false;
    }
  });

  root.querySelector("#backBtn")!.addEventListener("click", () => navigate("customer-invoices", customer));

  renderRows();
}
