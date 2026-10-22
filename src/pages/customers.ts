// شیرین حساب — صفحه‌ی مدیریت مشتریان
import { api, type Customer } from "../lib/api";
import { navigate } from "../lib/router";

// بهینه‌سازی برای سیستم‌های ضعیف: ردیف‌ها با DocumentFragment و یک‌جا ساخته می‌شوند
// و در لیست‌های بلند (بیش از PAGE_SIZE مشتری) بقیه با دکمه‌ی «نمایش بیشتر» می‌آیند.
const PAGE_SIZE = 100;

export function renderCustomers(root: HTMLElement): void {
  root.innerHTML = `
    <style>
      /* پولیش ظاهری صفحه‌ی مشتریان — محدود به همین صفحه (.cust-page) */
      .cust-page .btn { transition: background .15s ease, transform .05s ease, opacity .15s ease; }
      .cust-page .btn:active { transform: translateY(1px); }
      .cust-page .btn:disabled { opacity: .55; cursor: not-allowed; transform: none; }
      .cust-page .btn.danger:hover { background: #a93226; }
      .cust-page .btn.ghost:hover { background: #e7dcc6; }
      .cust-page input { transition: border-color .15s ease, box-shadow .15s ease; }
      .cust-page input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(201, 138, 46, .15); outline: none; }
      .cust-page input::placeholder { color: #b8a88f; }
      .page-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
      .page-head h2 { margin: 0; font-size: 20px; font-weight: 700; }
      .hint { color: var(--muted); font-size: 13px; margin: 0 0 10px; }
      .cust-page table th { background: #faf5ec; }
      .cust-page table td { vertical-align: middle; }
      #customer-rows tr { cursor: pointer; transition: background .15s ease; }
      #customer-rows tr:hover td { background: #faf3e7; }
      #customer-rows tr:last-child td { border-bottom: none; }
      .row-actions { display: flex; gap: 8px; justify-content: flex-end; }
      .note-cell { text-align: center; color: var(--muted); padding: 22px 10px; }
      .error-cell { text-align: center; color: var(--danger); padding: 22px 10px; }
      #customer-empty {
        text-align: center; color: var(--muted); padding: 26px 12px; margin: 6px 0 0;
        border: 1.5px dashed #e8dcc4; border-radius: 10px; background: #fffdf8;
      }
      .modal-overlay {
        position: fixed; inset: 0; z-index: 50;
        background: rgba(0, 0, 0, 0.35);
        display: flex; align-items: center; justify-content: center;
      }
      .modal-box {
        width: min(420px, 92vw); display: flex; flex-direction: column; gap: 10px;
        margin-bottom: 0; box-shadow: 0 12px 32px rgba(0, 0, 0, .18);
      }
      .modal-box h3 { margin: 0; padding-bottom: 10px; border-bottom: 1px solid #f0e4d2; font-size: 18px; }
      .modal-box label { display: flex; flex-direction: column; gap: 6px; font-size: 14px; }
      .modal-box .field-error { border-color: var(--danger); box-shadow: 0 0 0 3px rgba(192, 57, 43, .12); }
      .field-err { color: var(--danger); font-size: 12.5px; margin: -2px 0 0; }
      .modal-actions { display: flex; gap: 8px; justify-content: flex-start; margin-top: 6px; }
      .cust-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
      .cust-toolbar input { flex: 1 1 220px; }
      #debtor-toggle.on { background: var(--accent); color: #fff; }
      #cust-count { color: var(--muted); font-size: 12.5px; }
    </style>
    <div class="cust-page">
    <div class="page-head">
      <h2>مشتریان</h2>
      <button class="btn" id="add-customer">+ مشتری جدید</button>
    </div>
    <div class="card">
      <p class="hint">برای مشاهده‌ی فاکتورهای هر مشتری، روی ردیف آن دابل‌کلیک کنید.</p>
      <div class="cust-toolbar">
        <input id="customer-search" type="text" placeholder="جست‌وجو بر اساس نام یا شماره تلفن…" autocomplete="off" />
        <button class="btn ghost" id="debtor-toggle" aria-pressed="false">مشتریان بدهکار</button>
        <span id="cust-count"></span>
      </div>
      <table>
        <thead>
          <tr><th>نام</th><th>تلفن</th><th>آدرس</th><th></th></tr>
        </thead>
        <tbody id="customer-rows"></tbody>
      </table>
      <p id="customer-empty" style="display:none">هنوز مشتری‌ای ثبت نشده است.</p>
      <div id="customer-more-wrap" style="display:none; text-align:center; margin-top:12px;">
        <button class="btn ghost" id="customer-more">نمایش بیشتر</button>
      </div>
    </div>
    <div id="customer-modal" class="modal-overlay" style="display:none">
      <div class="card modal-box">
        <h3 id="modal-title">مشتری جدید</h3>
        <label>نام
          <input id="f-name" type="text" placeholder="نام مشتری" autocomplete="off" />
        </label>
        <p class="field-err" id="f-name-err" style="display:none">نام مشتری را وارد کنید.</p>
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
    </div>
    </div>`;

  const tbody = root.querySelector<HTMLTableSectionElement>("#customer-rows")!;
  const emptyMsg = root.querySelector<HTMLElement>("#customer-empty")!;
  const moreWrap = root.querySelector<HTMLElement>("#customer-more-wrap")!;
  const moreBtn = root.querySelector<HTMLButtonElement>("#customer-more")!;
  const modal = root.querySelector<HTMLElement>("#customer-modal")!;
  const modalTitle = root.querySelector<HTMLElement>("#modal-title")!;
  const nameIn = root.querySelector<HTMLInputElement>("#f-name")!;
  const phoneIn = root.querySelector<HTMLInputElement>("#f-phone")!;
  const addressIn = root.querySelector<HTMLInputElement>("#f-address")!;
  const saveBtn = root.querySelector<HTMLButtonElement>("#f-save")!;
  const cancelBtn = root.querySelector<HTMLButtonElement>("#f-cancel")!;
  const nameErr = root.querySelector<HTMLElement>("#f-name-err")!;

  // فقط ظاهر خطای فرم: برجسته‌سازی فیلد نام خالی (بدون هیچ تغییر در منطق ذخیره)
  function clearNameError(): void {
    nameIn.classList.remove("field-error");
    nameErr.style.display = "none";
  }
  nameIn.addEventListener("input", clearNameError);

  let customers: Customer[] = [];
  let editing: Customer | null = null;
  let visibleCount = PAGE_SIZE;

  // جست‌وجوی زنده (نام/تلفن) + فیلتر سریع «مشتریان بدهکار» (0.8.0)
  const searchIn = root.querySelector<HTMLInputElement>("#customer-search")!;
  const debtorBtn = root.querySelector<HTMLButtonElement>("#debtor-toggle")!;
  const countEl = root.querySelector<HTMLElement>("#cust-count")!;
  let query = "";
  let debtorOnly = false;
  let debtorIds: Set<number> | null = null;
  let debtorLoading = false;

  function normSearch(s: string): string {
    return s
      .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
      .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
      .replace(/[\s\-]/g, "")
      .toLowerCase();
  }

  function getView(): Customer[] {
    let list = customers;
    if (debtorOnly && debtorIds) list = list.filter((c) => debtorIds!.has(c.id));
    const q = normSearch(query);
    if (q) {
      list = list.filter(
        (c) => normSearch(c.name).includes(q) || normSearch(c.phone).includes(q)
      );
    }
    return list;
  }

  searchIn.addEventListener("input", () => {
    query = searchIn.value;
    visibleCount = PAGE_SIZE;
    paint();
  });

  debtorBtn.addEventListener("click", () => {
    void (async () => {
      debtorOnly = !debtorOnly;
      debtorBtn.classList.toggle("on", debtorOnly);
      debtorBtn.setAttribute("aria-pressed", String(debtorOnly));
      if (debtorOnly && !debtorIds && !debtorLoading) {
        debtorLoading = true;
        debtorBtn.disabled = true;
        try {
          const ds = await api.reportDebtors();
          debtorIds = new Set(ds.map((d) => d.customer_id));
        } catch {
          alert("خطا در دریافت فهرست بدهکاران.");
          debtorOnly = false;
          debtorBtn.classList.remove("on");
          debtorBtn.setAttribute("aria-pressed", "false");
        } finally {
          debtorLoading = false;
          debtorBtn.disabled = false;
        }
      }
      visibleCount = PAGE_SIZE;
      paint();
    })();
  });

  function buildRow(c: Customer): HTMLTableRowElement {
    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    tdName.textContent = c.name;
    const tdPhone = document.createElement("td");
    tdPhone.textContent = c.phone;
    const tdAddress = document.createElement("td");
    tdAddress.textContent = c.address;

    const tdOps = document.createElement("td");
    const ops = document.createElement("div");
    ops.className = "row-actions";
    const editBtn = document.createElement("button");
    editBtn.className = "btn ghost";
    editBtn.textContent = "ویرایش";
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openModal(c);
    });
    const delBtn = document.createElement("button");
    delBtn.className = "btn danger";
    delBtn.textContent = "حذف";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void removeCustomer(c);
    });
    ops.append(editBtn, delBtn);
    tdOps.appendChild(ops);

    tr.append(tdName, tdPhone, tdAddress, tdOps);
    tr.addEventListener("dblclick", () => navigate("customer-invoices", c));
    return tr;
  }

  function paint(): void {
    // ساخت همه‌ی ردیف‌های این صفحه در یک Fragment و الحاق یک‌جای آن‌ها به DOM
    const view = getView();
    const frag = document.createDocumentFragment();
    for (const c of view.slice(0, visibleCount)) {
      frag.appendChild(buildRow(c));
    }
    tbody.replaceChildren(frag);
    if (customers.length === 0) {
      emptyMsg.textContent = "هنوز مشتری‌ای ثبت نشده است.";
      emptyMsg.style.display = "";
    } else if (view.length === 0) {
      emptyMsg.textContent = "مشتری‌ای مطابق جست‌وجو پیدا نشد.";
      emptyMsg.style.display = "";
    } else {
      emptyMsg.style.display = "none";
    }
    moreWrap.style.display = view.length > visibleCount ? "" : "none";
    countEl.textContent =
      view.length && (query || debtorOnly)
        ? `${view.length.toLocaleString("fa-IR")} مشتری`
        : "";
  }

  function openModal(c?: Customer): void {
    editing = c ?? null;
    clearNameError();
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
      nameIn.classList.add("field-error");
      nameErr.style.display = "";
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
        visibleCount = getView().length; // مشتری تازه مثل قبل بلافاصله در لیست دیده شود
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
  moreBtn.addEventListener("click", () => {
    visibleCount += PAGE_SIZE;
    paint();
  });
  cancelBtn.addEventListener("click", closeModal);
  saveBtn.addEventListener("click", () => void saveCustomer());
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  async function load(): Promise<void> {
    tbody.innerHTML = `<tr><td colspan="4" class="note-cell">در حال بارگذاری…</td></tr>`;
    visibleCount = PAGE_SIZE;
    try {
      customers = await api.listCustomers();
    } catch {
      tbody.innerHTML = `<tr><td colspan="4" class="error-cell">خطا در بارگذاری مشتریان.</td></tr>`;
      return;
    }
    paint();
  }

  void load();
}
