// شیرین حساب — لایه ارتباط با بک‌اند Tauri
// EAgent1 امضای دستورهای main.rs را نهایی می‌کند؛ این فایل همان‌ها را صدا می‌زند.
import { invoke } from "@tauri-apps/api/core";

export interface Customer { id: number; name: string; phone: string; address: string; }
export interface Product { id: number; name: string; unit_price: number; }
export interface InvoiceItem { name: string; unit_price: number; qty: number; }
export interface Invoice {
  id: number; customer_id: number; invoice_number: number; date: string;
  items: InvoiceItem[]; total: number; paid_amount: number; status: "paid" | "unpaid";
}
export interface CustomerSummary { total_invoiced: number; total_paid: number; debt: number; }
export interface ConfectionerInfo { name: string; phone: string; }
export interface UpdateInfo { version: string; notes: string; published_at: string; }
export type UpdateReport =
  | { status: "ok"; prev_version: string; new_version: string; changelog: string }
  | { status: "failed" | "rolled_back"; detail: string };

export const api = {
  listCustomers: (): Promise<Customer[]> => invoke("list_customers"),
  addCustomer: (name: string, phone: string, address: string): Promise<Customer> =>
    invoke("add_customer", { name, phone, address }),
  updateCustomer: (c: Customer): Promise<void> => invoke("update_customer", { ...c }),
  deleteCustomer: (id: number): Promise<void> => invoke("delete_customer", { id }),

  listProducts: (): Promise<Product[]> => invoke("list_products"),
  addProduct: (name: string, unitPrice: number): Promise<Product> =>
    invoke("add_product", { name, unitPrice }),
  updateProduct: (p: Product): Promise<void> => invoke("update_product", { ...p }),
  deleteProduct: (id: number): Promise<void> => invoke("delete_product", { id }),

  listInvoices: (customerId: number): Promise<Invoice[]> =>
    invoke("list_invoices", { customerId }),
  createInvoice: (customerId: number, items: InvoiceItem[], invoiceNumber?: number): Promise<Invoice> =>
    invoke("create_invoice", { customerId, items, invoiceNumber }),
  updateInvoice: (id: number, items: InvoiceItem[]): Promise<void> =>
    invoke("update_invoice", { id, items }),
  deleteInvoice: (id: number): Promise<void> => invoke("delete_invoice", { id }),

  recordPayment: (customerId: number, amount: number, note: string): Promise<CustomerSummary> =>
    invoke("record_payment", { customerId, amount, note }),
  customerSummary: (customerId: number): Promise<CustomerSummary> =>
    invoke("customer_summary", { customerId }),

  getConfectionerInfo: (): Promise<ConfectionerInfo> =>
    invoke("get_confectioner_info"),
  setConfectionerInfo: (name: string, phone: string): Promise<void> =>
    invoke("set_confectioner_info", { name, phone }),

  // موتور به‌روزرسانی (بک‌اند: EAgent1) — قرارداد ثابت با رابط کاربری update-ui.ts
  checkUpdate: (): Promise<UpdateInfo | null> => invoke("check_update"),
  openUpdateFileDialog: (): Promise<string | null> => invoke("open_update_file_dialog"),
  applyLocalUpdate: (path: string): Promise<void> => invoke("apply_local_update", { path }),
  downloadAndApplyUpdate: (): Promise<void> => invoke("download_and_apply_update"),
  cancelUpdateDownload: (): Promise<void> => invoke("cancel_update_download"),
  getUpdateReport: (): Promise<UpdateReport | null> => invoke("get_update_report"),
  getSetting: (key: string): Promise<string | null> => invoke("get_setting", { key }),
  setSetting: (key: string, value: string): Promise<void> =>
    invoke("set_setting", { key, value }),
};
