// شیرین حساب — صفحه‌ی مدیریت مشتریان
import { api, type Customer } from "../lib/api";
import { navigate } from "../lib/router";

// فرار از کاراکترهای HTML برای نمایش امن داده‌های کاربر
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderCustomers(root: HTMLElement): void {
  root.innerHTML = `
    <style>
      .page-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
      .page-head h2 { margin: 0; font-size: 20px; }
      .hint { color: var(--muted); font-size: 13px; margin: 0 0 8px; }
      #customer-rows tr { cursor: pointer; }
      #customer-rows tr:hover td { background: #faf3e7; }
      .row-actions { display: flex; gap: 8px; justify-content: flex-end; }
      .modal-overlay {
        position: fixed; inset: 0; z-index: 50;
        background: rgba(0, 0, 0, 0.35);
        display: flex; align-items: center; justify-content: center;
      }
      .modal-box { width: min(420px, 92vw); display: flex; flex-direction: column; gap: 10px; margin-bottom: 0; }
      .modal-box h3 { margin: 0 0 4px; font-size: 18px; }
      .modal-box label { display: flex; flex-direction: column; gap: 6px; font-size: 14px; }
      .modal-actions { display: flex; gap: 8px; justify-content: flex-start; margin-top: 6px; }
    </style>
    <div class="page-head">
      <h2>مشتریان</h2>
      <button class="btn" id="add-customer">+ مشتری جدید</button>
    </div>
    <div class="card">
      <p class="hint">برای مشاهده‌ی فاکتورهای هر مشتری، روی ردیف آن دابل‌کلیک کنید.</p>
      <table>
        <thead>
          <tr><th>نام</th><th>تلفن</th><th>آدرس</th><th></th></tr>
        </thead>
        <tbody id="customer-rows"></tbody>
      </table>
      <p id="customer-empty" style="display:none; color: var(--muted);">هنوز مشتری‌ای ثبت نشده است.</p>
    </div>
    <div id="customer-modal" class="modal-overlay" style="display:none">
      <div class="card modal-box">
        <h3 id="modal-title">مشتری جدید</h3>
        <label>نام
          <input id="f-name" type="text" placeholder="نام مشتری" autocomplete="off" />
        </label>
        <label>تلفن
          <input id="f-phone" type="tel" placeholder="شماره تلفن" autocomplete="off" />
        </label>
        <label>آدرس
          <input id="f-address" type="text" placeholder="آدرس" autocomplete="off" />
        </label>
        <div class="modal-actions">
          <button class="btn" id="f-save">ذخیره</button>
          <button class="btn ghost" id="f-cancel">انصراف</button>
        </div>
      </div>
    </div>`;

  const tbody = root.querySelector<HTMLTableSectionElement>("#customer-rows")!;
  const emptyMsg = root.querySelector<HTMLElement>("#customer-empty")!;
  const modal = root.querySelector<HTMLElement>("#customer-modal")!;
  const modalTitle = root.querySelector<HTMLElement>("#modal-title")!;
  const nameIn = root.querySelector<HTMLInputElement>("#f-name")!;
  const phoneIn = root.querySelector<HTMLInputElement>("#f-phone")!;
  const addressIn = root.querySelector<HTMLInputElement>("#f-address")!;
  const saveBtn = root.querySelector<HTMLButtonElement>("#f-save")!;
  const cancelBtn = root.querySelector<HTMLButtonElement>("#f-cancel")!;

  let customers: Customer[] = [];
  let editing: Customer | null = null;

  function paint(): void {
    tbody.innerHTML = customers
      .map(
        (c, i) => `
        <tr data-i="${i}">
          <td>${esc(c.name)}</td>
          <td>${esc(c.phone)}</td>
          <td>${esc(c.address)}</td>
          <td><div class="row-actions">
            <button class="btn ghost act-edit">ویرایش</button>
            <button class="btn danger act-del">حذف</button>
          </div></td>
        </tr>`
      )
      .join("");
    emptyMsg.style.display = customers.length ? "none" : "";
    tbody.querySelectorAll("tr").forEach((tr) => {
      const c = customers[Number(tr.dataset.i)];
      tr.addEventListener("dblclick", () => navigate("customer-invoices", c));
      tr.querySelector(".act-edit")!.addEventListener("click", (e) => {
        e.stopPropagation();
        openModal(c);
      });
      tr.querySelector(".act-del")!.addEventListener("click", (e) => {
        e.stopPropagation();
        removeCustomer(c);
      });
    });
  }

  function openModal(c?: Customer): void {
    editing = c ?? null;
    modalTitle.textContent = c ? "ویرایش مشتری" : "مشتری جدید";
    nameIn.value = c?.name ?? "";
    phoneIn.value = c?.phone ?? "";
    addressIn.value = c?.address ?? "";
    modal.style.display = "flex";
    nameIn.focus();
  }

  function closeModal(): void {
    modal.style.display = "none";
  }

  async function saveCustomer(): Promise<void> {
    const name = nameIn.value.trim();
    const phone = phoneIn.value.trim();
    const address = addressIn.value.trim();
    if (!name) {
      nameIn.focus();
      return;
    }
    saveBtn.disabled = true;
    try {
      if (editing) {
        await api.updateCustomer({ ...editing, name, phone, address });
        Object.assign(editing, { name, phone, address });
      } else {
        const created = await api.addCustomer(name, phone, address);
        customers.push(created);
      }
      closeModal();
      paint();
    } catch {
      alert("ذخیره‌ی مشتری با خطا مواجه شد.");
    } finally {
      saveBtn.disabled = false;
    }
  }

  async function removeCustomer(c: Customer): Promise<void> {
    if (!confirm(`آیا از حذف «${c.name}» مطمئن هستید؟`)) return;
    try {
      await api.deleteCustomer(c.id);
      customers = customers.filter((x) => x.id !== c.id);
      paint();
    } catch {
      alert("حذف مشتری با خطا مواجه شد.");
    }
  }

  root.querySelector("#add-customer")!.addEventListener("click", () => openModal());
  cancelBtn.addEventListener("click", closeModal);
  saveBtn.addEventListener("click", () => void saveCustomer());
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  async function load(): Promise<void> {
    tbody.innerHTML = `<tr><td colspan="4">در حال بارگذاری…</td></tr>`;
    try {
      customers = await api.listCustomers();
    } catch {
      tbody.innerHTML = `<tr><td colspan="4">خطا در بارگذاری مشتریان.</td></tr>`;
      return;
    }
    paint();
  }

  void load();
}
