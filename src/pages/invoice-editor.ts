// شیرین حساب — ویرایشگر فاکتور (ثبت جدید / ویرایش) + خروجی PDF
import { api, type Customer, type Invoice, type InvoiceItem, type Product } from "../lib/api";
import { dueDateDisplay, fmtMoney, normalizeDueDateInput, toJalali, todayIso } from "../lib/jalali";
import { navigate } from "../lib/router";
import { exportInvoicePdf } from "../lib/pdf";

interface Row {
  key: number;
  manual: boolean;
  productId: number | null;
  name: string;
  unitPrice: number;
  qty: number;          // می‌تواند اعشاری باشد (فروش وزنی)
  discountPct: number;  // تخفیف درصدی ردیف (۰ تا ۱۰۰)
  unit: string;         // واحد محصول (نمایشی)
  stock: number | null; // موجودی محصول (برای هشدار نرم)؛ null = نامشخص
}

const faNum = (n: number): string => n.toLocaleString("fa-IR", { useGrouping: false });

function safeJalali(iso: string): string {
  try {
    return toJalali(iso);
  } catch {
    return iso;
  }
}

const clampPct = (n: number): number => (Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0);

/** جمع خالص یک ردیف بعد از تخفیف درصدی خودش */
function rowTotal(r: Row): number {
  const q = Number.isFinite(r.qty) ? Math.max(0, r.qty) : 0;
  const u = Number.isFinite(r.unitPrice) ? Math.max(0, r.unitPrice) : 0;
  return Math.round(q * u * (1 - clampPct(r.discountPct) / 100));
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

  // بدهی فعلی مشتری — هم برای ردیف خودکار «مانده حساب قبلی» (حالت جدید)
  // و هم برای هشدار نرم سقف اعتبار لازم است.
  let baseDebt = 0;
  try {
    baseDebt = (await api.customerSummary(customer.id)).debt;
  } catch {
    baseDebt = 0;
  }

  const rows: Row[] = [];
  let seq = 1;
  const addRow = (r: Omit<Row, "key">): void => {
    rows.push({ ...r, key: seq++ });
  };

  const BALANCE_ROW_NAME = "مانده حساب قبلی";
  const isBalanceRow = (name: string): boolean => name.trim() === BALANCE_ROW_NAME;

  // فقط در حالت «فاکتور جدید»: ردیف خودکار «مانده حساب قبلی» با مبلغ بدهکاری فعلی مشتری
  // (اگر صفر یا منفی بود، ردیفی اضافه نمی‌شود). در حالت ویرایش، ردیف ذخیره‌شده
  // دست‌نخورده از آیتم‌های فاکتور پر می‌شود — بدون بازنویسی و بدون محاسبه‌ی مجدد.
  if (!invoice && baseDebt > 0) {
    addRow({ manual: true, productId: null, name: BALANCE_ROW_NAME, unitPrice: baseDebt, qty: 1, discountPct: 0, unit: "", stock: null });
  }

  // حالت ویرایش: آیتم‌های فاکتور از قبل پر باشند (از جمله ردیف «مانده حساب قبلی» ذخیره‌شده)
  // اگر نام و قیمت با محصولی تطابق داشت، ردیف «محصول» می‌شود وگرنه «دستی»
  if (invoice) {
    for (const it of invoice.items) {
      const match = products.find((p) => p.name === it.name && p.unit_price === it.unit_price);
      if (match) {
        addRow({
          manual: false, productId: match.id, name: match.name, unitPrice: match.unit_price,
          qty: it.qty, discountPct: isBalanceRow(it.name) ? 0 : (it.discount_pct ?? 0),
          unit: match.unit ?? "", stock: typeof match.stock === "number" ? match.stock : null,
        });
      } else {
        addRow({
          manual: true, productId: null, name: it.name, unitPrice: it.unit_price,
          qty: it.qty, discountPct: isBalanceRow(it.name) ? 0 : (it.discount_pct ?? 0),
          unit: "", stock: null,
        });
      }
    }
  }

  const isEdit = !!invoice;
  const numberLabel = invoice ? faNum(invoice.invoice_number) : "خودکار";
  const dateLabel = invoice ? safeJalali(invoice.date) : toJalali(todayIso());
  // درصد تخفیف کلی: در حالت ویرایش از روی مبلغ ذخیره‌شده و جمع ردیف‌ها برگردانده می‌شود
  // (با دقت کامل نگه داشته می‌شود تا مبلغ ذخیره‌شده بی‌تغییر بماند؛ نمایش در فیلد ۲ رقم اعشار است)
  const initSubtotal = rows.reduce((s, r) => s + rowTotal(r), 0);
  let discountPctState = 0;
  if (invoice?.discount_amount && invoice.discount_amount > 0 && initSubtotal > 0) {
    discountPctState = (invoice.discount_amount / initSubtotal) * 100;
  }
  const initDiscountPct = discountPctState ? String(Math.round(discountPctState * 100) / 100) : "";
  const initDue = dueDateDisplay(invoice?.due_date) ?? "";

  root.innerHTML = `
  <style>
    .inv-meta { display:flex; flex-wrap:wrap; gap:14px 32px; margin:10px 0 18px; align-items:center; background:#fbf7f0; border:1px solid #f0e4d2; border-radius:12px; padding:14px 18px; }
    .inv-meta .lbl { color:var(--muted); font-size:13px; margin-inline-end:6px; }
    .inv-meta input[readonly] { background:#f7f1e6; border-style:dashed; min-width:190px; }
    .inv-tools { display:flex; gap:10px; align-items:center; margin:16px 0 6px; flex-wrap:wrap; }
    .inv-opts { display:flex; gap:12px 28px; align-items:center; margin:8px 0 2px; flex-wrap:wrap; }
    .inv-opts .lbl { color:var(--muted); font-size:13px; margin-inline-end:6px; }
    .inv-opts input { width:150px; text-align:center; }
    #dueDate { width:130px; }
    .sub-total { color:var(--muted); font-size:14px; }
    .sub-total b { color:var(--ink); }
    .grand { margin-inline-start:auto; font-size:17px; background:#f7f1e6; border:1px solid #f0e4d2; padding:8px 16px; border-radius:10px; }
    .grand b { color:var(--accent-dark); }
    .warn-box { margin-top:12px; background:#fdf6e0; border:1px solid #ecd9ae; color:#7a5b12; border-radius:10px; padding:10px 14px; font-size:14px; line-height:2; }
    .inv-actions { display:flex; gap:10px; margin-top:18px; flex-wrap:wrap; }
    .inv-actions .btn { min-width:140px; padding:11px 20px; }
    .err { color:var(--danger); min-height:22px; margin:8px 0 0; }
    td.c, th.c { text-align:center; }
    td { vertical-align:middle; }
    #invRows tr:nth-child(even) { background:#fbf7f0; }
    #invRows tr:hover { background:#f7f1e6; }
    input:focus, select:focus { outline:2px solid #ecd9ae; border-color:var(--accent); }
    .p-sum { font-weight:700; white-space:nowrap; }
    select.p-sel, input.m-name { width:100%; }
    input.p-qty, input.m-qty { width:78px; text-align:center; }
    input.r-disc { width:70px; text-align:center; }
    input.m-unit { width:150px; }
    .r-unit { color:var(--muted); font-size:12px; margin-inline-start:5px; white-space:nowrap; }
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
        <th class="c" style="width:52px">ردیف</th><th>کالا / شرح</th>
        <th class="c" style="width:130px">تعداد</th><th class="c" style="width:92px">تخفیف ٪</th>
        <th class="c" style="width:190px">قیمت واحد (ریال)</th>
        <th class="c" style="width:190px">جمع (ریال)</th><th class="c" style="width:84px">عملیات</th>
      </tr></thead>
      <tbody id="invRows"></tbody>
    </table>
    <div class="inv-tools">
      <button class="btn ghost" id="addProduct">+ افزودن کالا از لیست</button>
      <button class="btn ghost" id="addManual">+ آیتم دستی</button>
      <span class="grand">مبلغ نهایی فاکتور: <b id="grandTotal">${fmtMoney(0)}</b></span>
    </div>
    <div class="inv-opts">
      <div><span class="lbl">تخفیف کلی فاکتور ٪:</span><input id="invDiscount" inputmode="decimal" placeholder="۰" value="${escapeHtml(initDiscountPct)}"><span class="sub-total" id="discountEq"></span></div>
      <div><span class="lbl">تاریخ سررسید:</span><input id="dueDate" placeholder="۱۴۰۴/۰۹/۰۱" value="${escapeHtml(initDue)}"></div>
      <span class="sub-total">جمع ردیف‌ها: <b id="subTotal">${fmtMoney(0)}</b></span>
    </div>
    <div id="warnBox" class="warn-box" hidden></div>
    <div class="inv-actions">
      <button class="btn" id="saveBtn">${isEdit ? "ذخیره تغییرات" : "ثبت فاکتور"}</button>
      <button class="btn ghost" id="pdfBtn">خروجی PDF</button>
      <button class="btn ghost" id="backBtn">بازگشت</button>
    </div>
    <p class="err" id="formErr"></p>
  </div>`;

  const tbody = root.querySelector<HTMLTableSectionElement>("#invRows")!;
  const grandEl = root.querySelector<HTMLElement>("#grandTotal")!;
  const subEl = root.querySelector<HTMLElement>("#subTotal")!;
  const errEl = root.querySelector<HTMLElement>("#formErr")!;
  const warnBox = root.querySelector<HTMLElement>("#warnBox")!;
  const discountInput = root.querySelector<HTMLInputElement>("#invDiscount")!;
  const discountEqEl = root.querySelector<HTMLElement>("#discountEq")!;
  const dueInput = root.querySelector<HTMLInputElement>("#dueDate")!;

  const productOptions = (selectedId: number | null): string => {
    const opts = products
      .map(
        (p) =>
          `<option value="${p.id}"${p.id === selectedId ? " selected" : ""}>${escapeHtml(p.name)}${p.unit ? ` (${escapeHtml(p.unit)})` : ""} — ${faNum(
            p.unit_price
          )} ریال</option>`
      )
      .join("");
    return `<option value="">— انتخاب محصول —</option>${opts}`;
  };

  function rowHtml(r: Row, i: number): string {
    const num = faNum(i + 1);
    const del = `<button class="btn danger p-del" data-key="${r.key}" style="padding:6px 12px">حذف</button>`;
    const balance = isBalanceRow(r.name);
    const discCell = balance
      ? `<span style="color:var(--muted)">—</span>`
      : `<input type="number" class="r-disc" data-key="${r.key}" min="0" max="100" step="any" value="${r.discountPct || ""}" placeholder="۰">`;
    if (r.manual) {
      return `<tr data-key="${r.key}">
        <td class="c">${num}</td>
        <td><input class="m-name" data-key="${r.key}" placeholder="نام کالا یا خدمت" value="${escapeHtml(r.name)}"></td>
        <td class="c"><input type="number" class="m-qty" data-key="${r.key}" min="0" step="any" value="${r.qty}"></td>
        <td class="c">${discCell}</td>
        <td class="c"><input type="number" class="m-unit" data-key="${r.key}" min="0" value="${r.unitPrice}" placeholder="قیمت واحد"></td>
        <td class="c"><span class="p-sum" data-sum="${r.key}">${fmtMoney(rowTotal(r))}</span></td>
        <td class="c">${del}</td></tr>`;
    }
    return `<tr data-key="${r.key}">
      <td class="c">${num}</td>
      <td><select class="p-sel" data-key="${r.key}">${productOptions(r.productId)}</select></td>
      <td class="c"><input type="number" class="p-qty" data-key="${r.key}" min="0" step="any" value="${r.qty}"><span class="r-unit" data-unitlabel="${r.key}">${escapeHtml(r.unit)}</span></td>
      <td class="c">${discCell}</td>
      <td class="c"><span class="p-unit" data-unit="${r.key}">${r.productId ? faNum(r.unitPrice) + " ریال" : "—"}</span></td>
      <td class="c"><span class="p-sum" data-sum="${r.key}">${fmtMoney(rowTotal(r))}</span></td>
      <td class="c">${del}</td></tr>`;
  }

  const subtotalRows = (): number => rows.reduce((s, r) => s + rowTotal(r), 0);

  /** مبلغ تخفیف کلی از روی درصد و جمع ردیف‌ها — همین مبلغ در discount_amount ذخیره می‌شود */
  const invoiceDiscountAmount = (): number =>
    Math.round((subtotalRows() * clampPct(discountPctState)) / 100);

  /** سهم خالص یک فاکتور از بدهی = جمعش منهای ردیف‌های «مانده حساب قبلی» (جلوگیری از شمارش مضاعف) */
  const carryNet = (items: Array<{ name: string; unit_price: number; qty: number; discount_pct?: number }>): number =>
    items
      .filter((it) => isBalanceRow(it.name))
      .reduce((s, it) => s + Math.round(it.qty * it.unit_price * (1 - clampPct(it.discount_pct ?? 0) / 100)), 0);

  function computeWarnings(finalTotal: number): string[] {
    const warns: string[] = [];
    // موجودی ناکافی (هشدار نرم — ذخیره را متوقف نمی‌کند)
    for (const r of rows) {
      if (!r.manual && r.stock !== null && r.qty > r.stock) {
        warns.push(`موجودی کافی نیست: «${escapeHtml(r.name)}» — موجودی ${faNum(r.stock)}${r.unit ? " " + escapeHtml(r.unit) : ""}، مقدار فاکتور ${faNum(r.qty)}.`);
      }
    }
    // سقف اعتبار (هشدار نرم)
    const limit = customer.credit_limit ?? 0;
    if (limit > 0) {
      const oldEffect = invoice ? invoice.total - carryNet(invoice.items) : 0;
      const newEffect = finalTotal - carryNet(rows.map((r) => ({ name: r.name, unit_price: r.unitPrice, qty: r.qty, discount_pct: r.discountPct })));
      const projected = baseDebt - oldEffect + newEffect;
      if (projected > limit) {
        warns.push(`از سقف اعتبار گذشت: بدهی مشتری بعد از این فاکتور ${fmtMoney(projected)} می‌شود و سقف اعتبار او ${fmtMoney(limit)} است.`);
      }
    }
    return warns;
  }

  function updateTotals(): void {
    const subtotal = subtotalRows();
    const discAmt = invoiceDiscountAmount();
    const finalTotal = Math.max(0, subtotal - discAmt);
    subEl.textContent = fmtMoney(subtotal);
    grandEl.textContent = fmtMoney(finalTotal);
    discountEqEl.textContent = discAmt > 0 ? `معادل ${fmtMoney(discAmt)}` : "";
    const warns = computeWarnings(finalTotal);
    warnBox.innerHTML = warns.map((w) => `<div>⚠ ${w}</div>`).join("");
    warnBox.hidden = warns.length === 0;
  }

  function refreshRow(row: Row): void {
    const sumEl = tbody.querySelector(`[data-sum="${row.key}"]`);
    if (sumEl) sumEl.textContent = fmtMoney(rowTotal(row));
    updateTotals();
  }

  function renderRows(): void {
    tbody.innerHTML = rows.length
      ? rows.map((r, i) => rowHtml(r, i)).join("")
      : `<tr><td colspan="7" class="c" style="color:var(--muted);padding:22px">ردیفی ثبت نشده است — از دکمه‌های زیر جدول استفاده کنید.</td></tr>`;
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
      row.unit = p.unit ?? "";
      row.stock = typeof p.stock === "number" ? p.stock : null;
    } else {
      row.productId = null;
      row.name = "";
      row.unitPrice = 0;
      row.unit = "";
      row.stock = null;
    }
    const unitEl = tbody.querySelector(`[data-unit="${key}"]`);
    if (unitEl) unitEl.textContent = row.productId ? faNum(row.unitPrice) + " ریال" : "—";
    const unitLabel = tbody.querySelector(`[data-unitlabel="${key}"]`);
    if (unitLabel) unitLabel.textContent = row.unit;
    refreshRow(row);
  });

  tbody.addEventListener("input", (e) => {
    const t = e.target as HTMLInputElement;
    const key = Number(t.dataset.key);
    const row = rows.find((r) => r.key === key);
    if (!row) return;
    if (t.classList.contains("p-qty") || t.classList.contains("m-qty")) {
      row.qty = Math.max(0, Number(t.value) || 0); // اعشاری مجاز است (فروش وزنی)
    } else if (t.classList.contains("m-unit")) {
      row.unitPrice = Math.max(0, Number(t.value) || 0);
    } else if (t.classList.contains("m-name")) {
      row.name = t.value;
    } else if (t.classList.contains("r-disc")) {
      row.discountPct = clampPct(Number(t.value) || 0);
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

  discountInput.addEventListener("input", () => {
    discountPctState = clampPct(Number(toLatinDigits(discountInput.value.trim())) || 0);
    updateTotals();
  });

  root.querySelector("#addProduct")!.addEventListener("click", () => {
    addRow({ manual: false, productId: null, name: "", unitPrice: 0, qty: 1, discountPct: 0, unit: "", stock: null });
    renderRows();
  });
  root.querySelector("#addManual")!.addEventListener("click", () => {
    addRow({ manual: true, productId: null, name: "", unitPrice: 0, qty: 1, discountPct: 0, unit: "", stock: null });
    renderRows();
  });

  const collectItems = (): InvoiceItem[] =>
    rows
      .filter((r) => r.qty > 0 && r.name.trim() !== "")
      .map((r) => ({
        name: r.name.trim(),
        unit_price: Math.max(0, Math.round(r.unitPrice)),
        qty: r.qty,
        discount_pct: isBalanceRow(r.name) ? 0 : clampPct(r.discountPct),
      }));

  /** سررسید برای ارسال: همیشه رشته — متن شمسی نرمال «YYYY/MM/DD» با ارقام لاتین یا رشته‌ی خالی؛ نامعتبر = null */
  const readDueDate = (): string | null => normalizeDueDateInput(dueInput.value);

  const saveBtn = root.querySelector<HTMLButtonElement>("#saveBtn")!;
  saveBtn.addEventListener("click", async () => {
    errEl.textContent = "";
    const items = collectItems();
    if (!items.length) {
      errEl.textContent = "حداقل یک ردیف معتبر (نام + تعداد بیشتر از صفر) وارد کنید.";
      return;
    }
    const dueStr = readDueDate();
    if (dueStr === null) {
      errEl.textContent = "تاریخ سررسید معتبر نیست؛ قالب درست: ۱۴۰۴/۰۹/۰۱ (یا خالی بگذارید).";
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
    const opts = { discountAmount: invoiceDiscountAmount(), dueDate: dueStr };
    saveBtn.disabled = true;
    try {
      if (invoice) await api.updateInvoice(invoice.id, items, opts);
      else await api.createInvoice(customer.id, items, invoiceNumber, opts);
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
      const dueStr = readDueDate();
      await exportInvoicePdf({
        invoiceNumber: invoice ? faNum(invoice.invoice_number) : hasNum ? faNum(n) : "خودکار",
        fileNumber: invoice ? String(invoice.invoice_number) : hasNum ? String(n) : "new",
        dateJalali: dateLabel,
        customerName: customer.name,
        items,
        paidAmount: invoice ? invoice.paid_amount : 0,
        discountAmount: invoiceDiscountAmount(),
        discountPct: discountPctState,
        dueDateJalali: dueStr ? dueDateDisplay(dueStr) : null,
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
