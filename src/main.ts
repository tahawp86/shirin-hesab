// شیرین حساب — نقطه‌ی ورود فرانت‌اند
import { navigate, registerRoute } from "./lib/router";
import { renderCustomers } from "./pages/customers";
import { renderProducts } from "./pages/products";
import { renderCustomerInvoices } from "./pages/customer-invoices";
import { renderInvoiceEditor } from "./pages/invoice-editor";
import { renderSettings } from "./pages/settings";

registerRoute("customers", renderCustomers);
registerRoute("products", renderProducts);
registerRoute("customer-invoices", renderCustomerInvoices);
registerRoute("invoice-editor", renderInvoiceEditor);
registerRoute("settings", renderSettings);

document.querySelectorAll(".nav-btn").forEach((b) =>
  b.addEventListener("click", () => navigate((b as HTMLElement).dataset.page!))
);

navigate("customers");
