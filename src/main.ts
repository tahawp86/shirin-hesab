// شیرین حساب — نقطه‌ی ورود فرانت‌اند
import { navigate, registerRoute } from "./lib/router";
import { renderCustomers } from "./pages/customers";
import { renderProducts } from "./pages/products";
import { renderCustomerInvoices } from "./pages/customer-invoices";
import { renderInvoiceEditor } from "./pages/invoice-editor";
import { renderSettings } from "./pages/settings";
import { renderGuide } from "./pages/guide";
import { renderReports } from "./pages/reports";
import { initUpdateUI } from "./lib/update-ui";

registerRoute("customers", renderCustomers);
registerRoute("products", renderProducts);
registerRoute("customer-invoices", renderCustomerInvoices);
registerRoute("invoice-editor", renderInvoiceEditor);
registerRoute("settings", renderSettings);
registerRoute("guide", renderGuide);
registerRoute("reports", renderReports);

document.querySelectorAll(".nav-btn").forEach((b) =>
  b.addEventListener("click", () => navigate((b as HTMLElement).dataset.page!))
);

navigate("customers");

// رابط کاربری موتور به‌روزرسانی: اول گزارش آپدیت قبلی، بعد چک خودکار (۱۰ ثانیه + هر ساعت)
void initUpdateUI();
