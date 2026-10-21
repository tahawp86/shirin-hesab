// شیرین حساب — صفحه‌ی فاکتورهای یک مشتری
// BabyT (EAgents) — 2026-10-18
import { api, Customer, Invoice } from "../lib/api";
import { fmtMoney, toJalali } from "../lib/jalali";
import { navigate } from "../lib/router";
import { exportInvoicePdf } from "../lib/pdf";

const STYLE = `
<style>
/* هدر صفحه */
.ci-header { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding-bottom: 12px; border-bottom: 1px solid #f0e4d2; }
.ci-header h2 { margin: 0; flex: 1; min-width: 180px; font-size: 20px; }
/* کارت‌های خلاصه‌ی بالای صفحه */
.ci-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 12px; }
@media (max-width: 640px) { .ci-stats { grid-template-columns: 1fr; } }
.ci-stat { background: #faf5ec; border: 1px solid #f0e4d2; border-radius: 10px; padding: 12px 14px; }
.ci-stat .lbl { font-size: 12px; color: var(--muted); display: block; margin-bottom: 6px; }
.ci-stat .val { font-size: 20px; font-weight: 700; line-height: 1.4; }
.ci-stat.debt { background: #fbf0ee; border-color: #f0d4cf; }
.ci-stat.debt .val { color: var(--danger); }
/* عنوان کارت‌ها و متن راهنما */
.ci-card-title { margin: 0 0 12px; font-size: 17px; }
.ci-hint { font-size: 12px; color: var(--muted); margin: 10px 0 0; line-height: 1.9; }
/* جدول فاکتورها */
.ci-table-wrap { overflow-x: auto; }
.ci-page thead th { background: #faf5ec; border-bottom: 2px solid #f0e4d2; white-space: nowrap; }
.ci-page tbody td { vertical-align: middle; }
.ci-page tbody tr { transition: background-color .12s ease; }
.ci-page tbody tr:nth-child(even) { background: #fdfaf5; }
.ci-page tbody tr:hover { background: #faf3e7; }
.ci-page tbody tr:last-child td { border-bottom: none; }
/* نشان وضعیت پرداخت (پیل) */
.ci-page .paid, .ci-page .unpaid { display: inline-block; padding: 3px 12px; border-radius: 999px; font-size: 12.5px; line-height: 1.7; white-space: nowrap; }
.ci-page .paid { background: #e9f5ee; }
.ci-page .unpaid { background: #fbeeec; }
/* دکمه‌های عملیات داخل ردیف جدول */
.ci-actions { display: flex; gap: 6px; justify-content: flex-end; }
.ci-actions .btn { padding: 6px 12px; font-size: 13px; border-radius: 8px; }
/* حالت‌های دکمه در این صفحه (hover عمیق‌تر، active، disabled، فوکوس) */
.ci-page .btn { transition: background-color .12s ease, transform .05s ease; }
.ci-page .btn:active { transform: translateY(1px); }
.ci-page .btn.ghost:hover { background: #e6d9c3; }
.ci-page .btn.danger:hover { background: #a93226; }
.ci-page .btn:disabled { opacity: .55; cursor: not-allowed; transform: none; }
.ci-page .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
/* فرم ثبت پرداخت */
.ci-pay-form { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; }
.ci-pay-form label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--muted); }
.ci-pay-form label.grow { flex: 1 1 200px; }
.ci-pay-form label.grow input { width: 100%; }
.ci-pay-form input { min-width: 170px; }
.ci-page input:focus { border-color: var(--accent); outline: none; box-shadow: 0 0 0 3px rgba(201, 138, 46, .18); }
/* حالت‌های خالی / بارگذاری / خطا */
.ci-empty { text-align: center; color: var(--muted); background: #faf5ec; border: 1px dashed #e2d5c0; border-radius: 10px; padding: 26px 16px; margin: 0; }
.ci-loading { text-align: center; color: var(--muted); background: #faf5ec; border: 1px solid #f0e4d2; border-radius: 10px; padding: 26px 16px; margin: 0; }
.ci-error { text-align: center; color: var(--danger); background: #fbeeec; border: 1px solid #f0d4cf; border-radius: 10px; padding: 16px; margin: 0; }
/* دکمه‌ی «نمایش بیشتر» */
.ci-more { text-align: center; }
.ci-more .btn { margin-top: 12px; }
</style>`;

/** ارقام فارسی را به لاتین برمی‌گرداند تا parseFloat درست کار کند */
function normalizeDigits(s: string): string {
  return s
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٬,٫\s]/g, "");
}

export function renderCustomerInvoices(root: HTMLElement, customer: Customer): void {
  if (!customer) {
    navigate("customers");
    return;
  }

  root.innerHTML = `
${STYLE}
<div dir="rtl" class="ci-page">
  <div class="card">
    <div class="ci-header">
      <h2>فاکتورهای «${escapeHtml(customer.name)}»</h2>
      <button class="btn" id="ci-new-invoice">＋ فاکتور جدید</button>
      <button class="btn ghost" id="ci-back">← بازگشت به مشتریان</button>
    </div>
    <div class="ci-stats">
      <div class="ci-stat"><span class="lbl">جمع کل فاکتورها</span><span class="val" id="ci-total-invoiced">…</span></div>
      <div class="ci-stat"><span class="lbl">جمع پرداخت‌ها</span><span class="val" id="ci-total-paid">…</span></div>
      <div class="ci-stat debt"><span class="lbl">بدهکاری</span><span class="val" id="ci-debt">…</span></div>
    </div>
  </div>

  <div class="card">
    <h3 class="ci-card-title">فاکتورها</h3>
    <div id="ci-invoices"><p class="ci-loading">در حال بارگذاری…</p></div>
  </div>

  <div class="card">
    <h3 class="ci-card-title">ثبت پرداخت</h3>
    <form class="ci-pay-form" id="ci-pay-form">
      <label>مبلغ (ریال)
        <input type="text" id="ci-pay-amount" inputmode="numeric" placeholder="مثلاً ۱۵۰٬۰۰۰" autocomplete="off" />
      </label>
      <label class="grow">توضیح
        <input type="text" id="ci-pay-note" placeholder="توضیح اختیاری…" />
      </label>
      <button class="btn" type="submit">ثبت پرداخت</button>
    </form>
    <p class="ci-hint">
      مبلغ ثبت‌شده به‌صورت خودکار از قدیمی‌ترین فاکتورهای پرداخت‌نشده کم می‌شود.
    </p>
  </div>
</div>`;

  const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
    root.querySelector<T>(`#${id}`);

  $("ci-back")?.addEventListener("click", () => navigate("customers"));
  $("ci-new-invoice")?.addEventListener("click", () =>
    navigate("invoice-editor", { customer })
  );

  $("ci-pay-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const amountRaw = ($("ci-pay-amount") as HTMLInputElement | null)?.value ?? "";
    const note = ($("ci-pay-note") as HTMLInputElement | null)?.value.trim() ?? "";
    const amount = parseFloat(normalizeDigits(amountRaw));
    if (!Number.isFinite(amount) || amount <= 0) {
      alert("لطفاً مبلغ معتبر وارد کنید.");
      return;
    }
    try {
      await api.recordPayment(customer.id, amount, note);
      renderCustomerInvoices(root, customer); // رفرش صفحه
    } catch (err) {
      alert("ثبت پرداخت ناموفق بود: " + (err instanceof Error ? err.message : err));
    }
  });

  // بارگذاری خلاصه و فاکتورها
  Promise.all([api.customerSummary(customer.id), api.listInvoices(customer.id)])
    .then(([summary, invoices]) => {
      $("ci-total-invoiced")!.textContent = fmtMoney(summary.total_invoiced);
      $("ci-total-paid")!.textContent = fmtMoney(summary.total_paid);
      $("ci-debt")!.textContent = fmtMoney(summary.debt);
      renderTable(invoices);
    })
    .catch((err) => {
      const box = $("ci-invoices");
      if (box)
        box.innerHTML = `<p class="ci-error">خطا در بارگذاری: ${escapeHtml(
          err instanceof Error ? err.message : String(err)
        )}</p>`;
    });

  const INVOICE_PAGE_SIZE = 100; // سقف ردیف در هر نوبت رندر (بهینه‌سازی برای سیستم‌های ضعیف)
  let shownCount = 0; // چند ردیف از فاکتورها تا این لحظه رندر شده است

  function renderTable(invoices: Invoice[]): void {
    const box = $("ci-invoices");
    if (!box) return;
    if (invoices.length === 0) {
      box.innerHTML = `<p class="ci-empty">هنوز فاکتوری برای این مشتری ثبت نشده است.</p>`;
      return;
    }
    // اسکلت جدول یک‌جا ساخته می‌شود؛ ردیف‌ها با DocumentFragment و دسته‌ای اضافه می‌شوند.
    box.innerHTML = `
      <div class="ci-table-wrap">
      <table>
        <thead>
          <tr>
            <th>شماره فاکتور</th>
            <th>تاریخ</th>
            <th>مبلغ</th>
            <th>وضعیت پرداخت</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="ci-tbody"></tbody>
      </table>
      </div>
      <div id="ci-more" class="ci-more"></div>`;
    shownCount = 0;
    appendRows(invoices);
  }

  // حداکثر INVOICE_PAGE_SIZE ردیف را در یک DocumentFragment می‌سازد و یک‌جا به
  // tbody اضافه می‌کند؛ اگر فاکتور بیشتری مانده باشد دکمه‌ی «نمایش بیشتر» می‌آید.
  function appendRows(invoices: Invoice[]): void {
    const tbody = root.querySelector<HTMLTableSectionElement>("#ci-tbody");
    const moreBox = root.querySelector<HTMLElement>("#ci-more");
    if (!tbody) return;
    const chunk = invoices.slice(shownCount, shownCount + INVOICE_PAGE_SIZE);
    const frag = document.createDocumentFragment();
    for (const inv of chunk) {
      const tr = document.createElement("tr");
      tr.dataset.id = String(inv.id);
      tr.innerHTML = `
        <td>${inv.invoice_number.toLocaleString("fa-IR")}</td>
        <td>${toJalali(inv.date)}</td>
        <td>${fmtMoney(inv.total)}</td>
        <td><span class="${inv.status === "paid" ? "paid" : "unpaid"}">${
          inv.status === "paid" ? "پرداخت شده" : "پرداخت نشده"
        }</span></td>
        <td>
          <div class="ci-actions">
            <button class="btn ghost" data-act="pdf">خروجی PDF</button>
            <button class="btn ghost" data-act="edit">ویرایش</button>
            <button class="btn danger" data-act="del">حذف</button>
          </div>
        </td>`;
      tr.querySelector('[data-act="edit"]')?.addEventListener("click", () =>
        navigate("invoice-editor", { customer, invoice: inv })
      );
      tr.querySelector('[data-act="pdf"]')?.addEventListener("click", async (e) => {
        const btn = e.currentTarget as HTMLButtonElement;
        btn.disabled = true;
        try {
          let conf: { name: string; phone: string } | null = null;
          try {
            conf = await api.getConfectionerInfo();
          } catch {
            conf = null; // بدون اطلاعات قناد ادامه می‌دهیم
          }
          await exportInvoicePdf({
            invoiceNumber: inv.invoice_number.toLocaleString("fa-IR", { useGrouping: false }),
            fileNumber: String(inv.invoice_number),
            dateJalali: toJalali(inv.date),
            customerName: customer.name,
            items: inv.items,
            confectionerName: conf?.name,
            confectionerPhone: conf?.phone,
          });
        } catch (err) {
          alert("خطا در ساخت PDF: " + (err instanceof Error ? err.message : err));
        } finally {
          btn.disabled = false;
        }
      });
      tr.querySelector('[data-act="del"]')?.addEventListener("click", async () => {
        if (!confirm(`فاکتور شماره‌ی ${inv.invoice_number.toLocaleString("fa-IR")} حذف شود؟`))
          return;
        try {
          await api.deleteInvoice(inv.id);
          renderCustomerInvoices(root, customer); // رفرش صفحه
        } catch (err) {
          alert("حذف ناموفق بود: " + (err instanceof Error ? err.message : err));
        }
      });
      frag.appendChild(tr);
    }
    tbody.appendChild(frag); // همه‌ی ردیف‌های این دسته یک‌جا به DOM اضافه می‌شوند
    shownCount += chunk.length;
    if (moreBox) {
      if (shownCount < invoices.length) {
        moreBox.innerHTML = `<button class="btn ghost" id="ci-more-btn">نمایش بیشتر</button>`;
        moreBox
          .querySelector("#ci-more-btn")
          ?.addEventListener("click", () => appendRows(invoices));
      } else {
        moreBox.innerHTML = "";
      }
    }
  }

}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}
