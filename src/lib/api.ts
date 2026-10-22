// شیرین حساب — لایه ارتباط با بک‌اند Tauri
// EAgent1 امضای دستورهای main.rs را نهایی می‌کند؛ این فایل همان‌ها را صدا می‌زند.
import { invoke } from "@tauri-apps/api/core";

export interface Customer {
  id: number; name: string; phone: string; address: string;
  credit_limit?: number; // سقف اعتبار (ریال) — قرارداد ۰٫۸٫۰؛ صفر/نامشخص = بدون سقف
}
export interface Product {
  id: number; name: string; unit_price: number;
  // فیلدهای ۰٫۸٫۰ — اختیاری تا با داده‌ی قدیمی هم سازگار بماند
  unit?: string;            // واحد: عدد / کیلوگرم / جعبه / … (متن آزاد)
  purchase_price?: number; // قیمت خرید
  stock?: number;          // موجودی فعلی
  min_stock?: number;      // حداقل موجودی (آستانه‌ی هشدار کم‌موجودی)
}
export interface InvoiceItem {
  name: string; unit_price: number; qty: number; // qty می‌تواند اعشاری باشد (فروش وزنی)
  discount_pct?: number; // تخفیف درصدی این ردیف (۰ تا ۱۰۰) — قرارداد ۰٫۸٫۰
}
export interface Invoice {
  id: number; customer_id: number; invoice_number: number; date: string;
  due_date: string | null; // سررسید پرداخت (ISO) — قرارداد ۰٫۸٫۰ ایجنت۱؛ null یعنی بدون سررسید
  items: InvoiceItem[]; total: number; paid_amount: number; status: "paid" | "unpaid";
  discount_amount?: number; // تخفیف کلی فاکتور (مبلغی، ریال) — قرارداد ۰٫۸٫۰
}
/** روش پرداخت — قرارداد ۰٫۸٫۰ (ذخیره در payments.method در بک‌اند ایجنت۱) */
export type PaymentMethod = "cash" | "card" | "cheque" | "credit";
/** یک ردیف گردش حساب مشتری از کامند customer_statement (قرارداد ۰٫۸٫۰ ایجنت۱):
 * ردیف‌ها به ترتیب زمانی صعودی برمی‌گردند و balance مانده‌ی بدهی مشتری بعد از همان ردیف است. */
export interface StatementEntry {
  date: string;                   // ISO
  kind: "invoice" | "payment";
  invoice_number: number | null;  // فقط برای ردیف فاکتور
  amount: number;                 // مبلغ فاکتور یا مبلغ پرداخت
  balance: number;                // مانده‌ی جاری بدهی بعد از این ردیف
  method: PaymentMethod | null;   // فقط برای ردیف پرداخت
  note: string;
}
export interface CustomerSummary { total_invoiced: number; total_paid: number; debt: number; }
export interface ConfectionerInfo { name: string; phone: string; }
export interface BackupCounts { customers: number; products: number; invoices: number; payments: number; }
export interface BackupInfo { path: string; exported_at: string; currency: string; counts: BackupCounts; }
export interface UpdateInfo2 { version: string; notes_fa: string; mandatory: boolean; published_at: string; }
export type UpdateReport =
  | { status: "ok"; prev_version: string; new_version: string; changelog: string }
  | { status: "failed" | "rolled_back"; detail: string };
// گزارش‌ها (0.8.0 — بک‌اند: EAgent1) — قرارداد ثابت با صفحه‌ی reports.ts
export interface DailySale { date: string; total: number; count: number; }
export interface SalesReport { total_sales: number; invoice_count: number; daily: DailySale[]; }
export interface TopProduct { name: string; qty: number; amount: number; profit: number; }
export interface Debtor { customer_id: number; name: string; phone: string; debt: number; oldest_date: string; }

export const api = {
  listCustomers: (): Promise<Customer[]> => invoke("list_customers"),
  addCustomer: (name: string, phone: string, address: string): Promise<Customer> =>
    invoke("add_customer", { name, phone, address }),
  updateCustomer: (c: Customer): Promise<void> => invoke("update_customer", { ...c }),
  deleteCustomer: (id: number): Promise<void> => invoke("delete_customer", { id }),

  listProducts: (): Promise<Product[]> => invoke("list_products"),
  addProduct: (
    name: string, unitPrice: number,
    unit?: string, purchasePrice?: number, stock?: number, minStock?: number
  ): Promise<Product> =>
    invoke("add_product", { name, unitPrice, unit, purchasePrice, stock, minStock }),
  updateProduct: (p: Product): Promise<void> => invoke("update_product", { ...p }),
  deleteProduct: (id: number): Promise<void> => invoke("delete_product", { id }),

  listInvoices: (customerId: number): Promise<Invoice[]> =>
    invoke("list_invoices", { customerId }),
  createInvoice: (
    customerId: number, items: InvoiceItem[], invoiceNumber?: number,
    opts?: { discountAmount?: number; dueDate?: string | null }
  ): Promise<Invoice> =>
    invoke("create_invoice", {
      customerId, items, invoiceNumber,
      discountAmount: opts?.discountAmount, dueDate: opts?.dueDate,
    }),
  updateInvoice: (
    id: number, items: InvoiceItem[],
    opts?: { discountAmount?: number; dueDate?: string | null }
  ): Promise<void> =>
    invoke("update_invoice", {
      id, items,
      discountAmount: opts?.discountAmount, dueDate: opts?.dueDate,
    }),
  deleteInvoice: (id: number): Promise<void> => invoke("delete_invoice", { id }),

  recordPayment: (customerId: number, amount: number, note: string, method: PaymentMethod): Promise<CustomerSummary> =>
    invoke("record_payment", { customerId, amount, note, method }),
  customerSummary: (customerId: number): Promise<CustomerSummary> =>
    invoke("customer_summary", { customerId }),
  customerStatement: (customerId: number): Promise<StatementEntry[]> =>
    invoke("customer_statement", { customerId }),

  getConfectionerInfo: (): Promise<ConfectionerInfo> =>
    invoke("get_confectioner_info"),
  setConfectionerInfo: (name: string, phone: string): Promise<void> =>
    invoke("set_confectioner_info", { name, phone }),

  // موتور به‌روزرسانی جدید (بک‌اند: EAgent1) — قرارداد ثابت با رابط کاربری update-ui.ts
  checkUpdate2: (): Promise<UpdateInfo2 | null> => invoke("check_update2"),
  downloadUpdate2: (): Promise<void> => invoke("download_update2"),
  cancelUpdateDownload2: (): Promise<void> => invoke("cancel_update_download2"),
  applyUpdate2: (): Promise<void> => invoke("apply_update2"),
  openUpdateFileDialog: (): Promise<string | null> => invoke("open_update_file_dialog"),
  applyLocalUpdate: (path: string): Promise<void> => invoke("apply_local_update", { path }),
  getUpdateReport: (): Promise<UpdateReport | null> => invoke("get_update_report"),
  getSetting: (key: string): Promise<string | null> => invoke("get_setting", { key }),
  setSetting: (key: string, value: string): Promise<void> =>
    invoke("set_setting", { key, value }),

  // لوگوی کاربر برای PDF (بک‌اند: EAgent1) — pickAndSetUserLogo و getUserLogo
  // یک data URL برای پیش‌نمایش برمی‌گردانند (یا null)
  pickAndSetUserLogo: (): Promise<string | null> =>
    invoke("pick_and_set_user_logo"),
  getUserLogo: (): Promise<string | null> => invoke("get_user_logo"),
  clearUserLogo: (): Promise<void> => invoke("clear_user_logo"),

  // گزارش‌ها (0.8.0 — بک‌اند: EAgent1)
  reportSales: (from: string, to: string): Promise<SalesReport> =>
    invoke("report_sales", { from, to }),
  reportTopProducts: (from: string, to: string): Promise<TopProduct[]> =>
    invoke("report_top_products", { from, to }),
  reportDebtors: (): Promise<Debtor[]> => invoke("report_debtors"),

  // پشتیبان‌گیری و انتقال (بک‌اند: EAgent1)
  exportBackup: (): Promise<string | null> => invoke("export_backup"),
  pickAndValidateBackup: (): Promise<BackupInfo | null> =>
    invoke("pick_and_validate_backup"),
  applyBackupImport: (path: string): Promise<void> =>
    invoke("apply_backup_import", { path }),
};
