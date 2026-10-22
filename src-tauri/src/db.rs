// شیرین حساب — لایه دیتابیس (SQLite با rusqlite)
// قرارداد دستورها: امضاهای Rust دقیقاً مطابق اسپک (snake_case).
// روی کامندهایی که فرانت آرگومان چندکلمه‌ای را camelCase می‌فرستد
// (مثل customerId در api.ts و defaultName در pdf.ts) از
// rename_all="camelCase" استفاده شده تا وایر فرانت هم جور باشد.

use chrono::Local;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Manager, State};

// ---------- مدل‌ها ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Customer {
    pub id: i64,
    pub name: String,
    pub phone: String,
    pub address: String,
    /// سقف اعتبار (۰ = بدون سقف)
    pub credit_limit: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Product {
    pub id: i64,
    pub name: String,
    pub unit_price: f64,
    /// واحد فروش (پیش‌فرض «عدد»)
    pub unit: String,
    /// قیمت خرید (مبنای محاسبه‌ی سود)
    pub cost_price: f64,
    /// موجودی فعلی
    pub stock: f64,
    /// حداقل موجودی برای هشدار
    pub min_stock: f64,
}

/// قلم ورودی فاکتور از سمت فرانت
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewItem {
    pub name: String,
    pub unit_price: f64,
    pub qty: f64,
    /// تخفیف سطری درصدی (۰ تا ۱۰۰) — نبودش در payload یعنی ۰
    #[serde(default)]
    pub discount_percent: f64,
}

/// قلم فاکتور در خروجی (مطابق قرارداد فرانت: بدون id)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemView {
    pub name: String,
    pub unit_price: f64,
    pub qty: f64,
    pub discount_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvoiceView {
    pub id: i64,
    pub customer_id: i64,
    pub invoice_number: i64,
    pub date: String,
    pub items: Vec<ItemView>,
    pub total: f64,
    pub paid_amount: f64,
    pub status: String, // "paid" | "unpaid"
    /// تخفیف کلی فاکتور
    pub discount_amount: f64,
    /// تاریخ سررسید (خالی = ندارد)
    pub due_date: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Summary {
    pub total_invoiced: f64,
    pub total_paid: f64,
    pub debt: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfectionerInfo {
    pub name: String,
    pub phone: String,
}

// ---------- وضعیت مشترک ----------

pub type DbState = Mutex<Connection>;

fn lock<'a>(state: &'a State<'_, DbState>) -> Result<MutexGuard<'a, Connection>, String> {
    state.lock().map_err(|e| format!("db lock failed: {e}"))
}

fn today_iso() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS customers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    phone        TEXT NOT NULL DEFAULT '',
    address      TEXT NOT NULL DEFAULT '',
    credit_limit REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS products (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    unit_price REAL NOT NULL DEFAULT 0,
    unit       TEXT NOT NULL DEFAULT 'عدد',
    cost_price REAL NOT NULL DEFAULT 0,
    stock      REAL NOT NULL DEFAULT 0,
    min_stock  REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS invoices (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id     INTEGER NOT NULL,
    invoice_number  INTEGER NOT NULL UNIQUE,
    date            TEXT NOT NULL,
    paid_amount     REAL NOT NULL DEFAULT 0,
    discount_amount REAL NOT NULL DEFAULT 0,
    due_date        TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS invoice_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id       INTEGER NOT NULL,
    name             TEXT NOT NULL,
    unit_price       REAL NOT NULL,
    qty              REAL NOT NULL,
    discount_percent REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS payments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    amount      REAL NOT NULL,
    date        TEXT NOT NULL,
    note        TEXT NOT NULL DEFAULT '',
    method      TEXT NOT NULL DEFAULT 'نقد'
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id);
";

/// افزودن ستون تازه به دیتابیس‌های موجود، فقط اگر نیست (پیش‌فرض امن؛ دیتای فعلی سالم می‌ماند)
fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    ddl: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let has: bool = conn.query_row(
        &format!("SELECT COUNT(*) > 0 FROM pragma_table_info('{table}') WHERE name = '{column}'"),
        [],
        |r| r.get(0),
    )?;
    if !has {
        conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {ddl}"), [])?;
    }
    Ok(())
}

/// اتصال به SQLite — فایل دیتابیس در app_data کنار exe
pub fn init_db(app: &AppHandle) -> Result<Connection, Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    let mut conn = Connection::open(dir.join("shirin-hesab.db"))?;
    // بهینه‌سازی SQLite برای سیستم‌های ضعیف (WAL + کش بزرگ‌تر + temp در حافظه)
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; \
         PRAGMA synchronous=NORMAL; \
         PRAGMA cache_size=-8000; \
         PRAGMA temp_store=MEMORY;",
    )?;
    conn.execute_batch(SCHEMA)?;
    // مایگریشن 0.8.0: ستون‌های تازه (دیتابیس‌های قدیمی با پیش‌فرض امن کامل می‌شوند)
    ensure_column(&conn, "customers", "credit_limit", "credit_limit REAL NOT NULL DEFAULT 0")?;
    ensure_column(&conn, "products", "unit", "unit TEXT NOT NULL DEFAULT 'عدد'")?;
    ensure_column(&conn, "products", "cost_price", "cost_price REAL NOT NULL DEFAULT 0")?;
    ensure_column(&conn, "products", "stock", "stock REAL NOT NULL DEFAULT 0")?;
    ensure_column(&conn, "products", "min_stock", "min_stock REAL NOT NULL DEFAULT 0")?;
    ensure_column(&conn, "invoices", "discount_amount", "discount_amount REAL NOT NULL DEFAULT 0")?;
    ensure_column(&conn, "invoices", "due_date", "due_date TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "invoice_items", "discount_percent", "discount_percent REAL NOT NULL DEFAULT 0")?;
    ensure_column(&conn, "payments", "method", "method TEXT NOT NULL DEFAULT 'نقد'")?;
    // مایگریشن: حذف ستون rolled_into (منطق تجمیع کاملاً حذف شد)
    let has_col: bool = conn.query_row(
        "SELECT COUNT(*) > 0 FROM pragma_table_info('invoices') WHERE name = 'rolled_into'",
        [],
        |r| r.get(0),
    )?;
    if has_col {
        conn.execute("ALTER TABLE invoices DROP COLUMN rolled_into", [])?;
    }
    // مهاجرت یک‌باره‌ی تومان → ریال (از نسخه 0.4.1): همه‌ی مبالغ ذخیره‌شده ×۱۰
    // گارد: کلید currency_rial_migrated در settings — داخل تراکنش (همه یا هیچ)
    let rial_done: bool = conn.query_row(
        "SELECT COUNT(*) > 0 FROM settings WHERE key = 'currency_rial_migrated' AND value = '1'",
        [],
        |r| r.get(0),
    )?;
    if !rial_done {
        let tx = conn.transaction()?;
        tx.execute("UPDATE products SET unit_price = unit_price * 10", [])?;
        tx.execute("UPDATE invoice_items SET unit_price = unit_price * 10", [])?;
        tx.execute("UPDATE invoices SET paid_amount = paid_amount * 10", [])?;
        tx.execute("UPDATE payments SET amount = amount * 10", [])?;
        tx.execute(
            "INSERT INTO settings (key, value) VALUES ('currency_rial_migrated', '1') \
             ON CONFLICT(key) DO UPDATE SET value = '1'",
            [],
        )?;
        tx.commit()?;
    }
    // نگاشت کلید قدیمی auto_update_check به update_mode موتور آپدیت v2
    // (فقط وقتی update_mode هنوز ست نشده: روشن = auto، خاموش = off)
    if read_setting(&conn, "update_mode")?.is_empty() {
        let legacy = read_setting(&conn, "auto_update_check")?;
        if !legacy.is_empty() {
            let mode = if legacy == "false" || legacy == "0" {
                "off"
            } else {
                "auto"
            };
            write_setting(&conn, "update_mode", mode)?;
        }
    }
    Ok(conn)
}

// ---------- کمک‌تابع‌ها ----------

/// نام آیتم «مانده حساب قبلی» — در فرمول بدهکاری از جمع فاکتورها کم می‌شود
/// تا دوباره شمرده نشود (تطبیق با نام دقیق).
pub const BALANCE_ITEM_NAME: &str = "مانده حساب قبلی";

/// آیتم‌های همه‌ی فاکتورهای یک مشتری با یک کوئری — گروه‌بندی‌شده بر اساس invoice_id
/// (بهینه‌سازی: جایگزین کوئری جدا برای هر فاکتور در لیست؛ ترتیب آیتم‌های هر فاکتور بر اساس id)
fn load_items_grouped(
    conn: &Connection,
    customer_id: i64,
) -> Result<std::collections::HashMap<i64, Vec<ItemView>>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT invoice_id, name, unit_price, qty, discount_percent FROM invoice_items \
             WHERE invoice_id IN (SELECT id FROM invoices WHERE customer_id = ?1) \
             ORDER BY invoice_id, id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![customer_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                ItemView {
                    name: r.get(1)?,
                    unit_price: r.get(2)?,
                    qty: r.get(3)?,
                    discount_percent: r.get(4)?,
                },
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut map: std::collections::HashMap<i64, Vec<ItemView>> =
        std::collections::HashMap::new();
    for row in rows {
        let (invoice_id, item) = row.map_err(|e| e.to_string())?;
        map.entry(invoice_id).or_default().push(item);
    }
    Ok(map)
}

fn insert_items(conn: &Connection, invoice_id: i64, items: &[NewItem]) -> Result<(), String> {
    for it in items {
        conn.execute(
            "INSERT INTO invoice_items (invoice_id, name, unit_price, qty, discount_percent) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![invoice_id, it.name, it.unit_price, it.qty, it.discount_percent],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// مبلغ خالص یک قلم بعد از تخفیف سطری — ردیف «مانده حساب قبلی» از تخفیف مستثناست
fn item_net(name: &str, unit_price: f64, qty: f64, discount_percent: f64) -> f64 {
    let gross = unit_price * qty;
    if name == BALANCE_ITEM_NAME {
        gross
    } else {
        gross * (1.0 - discount_percent / 100.0)
    }
}

fn items_net_total(items: &[ItemView]) -> f64 {
    items
        .iter()
        .map(|it| item_net(&it.name, it.unit_price, it.qty, it.discount_percent))
        .sum()
}

fn items_balance_total(items: &[ItemView]) -> f64 {
    items
        .iter()
        .filter(|it| it.name == BALANCE_ITEM_NAME)
        .map(|it| it.unit_price * it.qty)
        .sum()
}

/// جمع فاکتور = مجموع خالص آیتم‌ها (بعد از تخفیف سطری) − تخفیف کلی فاکتور
fn invoice_total_of(items: &[ItemView], discount_amount: f64) -> f64 {
    items_net_total(items) - discount_amount
}

/// مبنای بدهی فاکتور = جمع فاکتور − آیتم‌های «مانده حساب قبلی» (دوباره شمرده نمی‌شوند)
fn invoice_basis_of(items: &[ItemView], discount_amount: f64) -> f64 {
    invoice_total_of(items, discount_amount) - items_balance_total(items)
}

fn status_of(basis: f64, paid_amount: f64) -> String {
    if paid_amount >= basis {
        "paid".to_string()
    } else {
        "unpaid".to_string()
    }
}

/// محاسبه‌ی یک فاکتور: مبنای بدهی (جمع با تخفیف‌ها، بدون «مانده حساب قبلی»)
struct InvCalc {
    id: i64,
    invoice_number: i64,
    date: String,
    paid_amount: f64,
    basis: f64,
}

/// محاسبه‌ی همه‌ی فاکتورهای مشتری با SQL گروهی — منبع واحد حقیقت فرمول‌ها
/// (خلاصه حساب، تخصیص پرداخت، گزارش بدهکاران و صورت‌حساب همه از همین می‌خوانند)
fn invoice_calcs(conn: &Connection, customer_id: i64) -> Result<Vec<InvCalc>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT i.id, i.invoice_number, i.date, i.paid_amount, i.discount_amount, \
                    COALESCE(SUM(CASE WHEN it.name = ?2 THEN it.unit_price * it.qty \
                                      ELSE it.unit_price * it.qty * (1 - it.discount_percent / 100.0) END), 0), \
                    COALESCE(SUM(CASE WHEN it.name = ?2 THEN it.unit_price * it.qty ELSE 0 END), 0) \
             FROM invoices i LEFT JOIN invoice_items it ON it.invoice_id = i.id \
             WHERE i.customer_id = ?1 \
             GROUP BY i.id ORDER BY i.date ASC, i.id ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![customer_id, BALANCE_ITEM_NAME], |r| {
            let discount: f64 = r.get(4)?;
            let net: f64 = r.get(5)?;
            let balance: f64 = r.get(6)?;
            Ok(InvCalc {
                id: r.get(0)?,
                invoice_number: r.get(1)?,
                date: r.get(2)?,
                paid_amount: r.get(3)?,
                basis: net - discount - balance,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

fn summary_for(conn: &Connection, customer_id: i64) -> Result<Summary, String> {
    let calcs = invoice_calcs(conn, customer_id)?;
    // جمع کل فاکتورها (برای نمایش) — مبنای هر فاکتور یعنی بدون «مانده حساب قبلی»،
    // وگرنه بدهی قبلی دوبار شمرده می‌شود (یک بار در فاکتور خودش، یک بار در فاکتور جدید)
    let total_invoiced: f64 = calcs.iter().map(|c| c.basis).sum();
    // بدهکاری = جمع «پرداخت‌نشده»‌ی فاکتورها، فاکتوربه‌فاکتور (منفی نمی‌شود):
    // برای هر فاکتور: ‎max(0, مبنای فاکتور − paid_amount)‎ — روی جمع جدید (با تخفیف‌ها)
    let debt: f64 = calcs
        .iter()
        .map(|c| (c.basis - c.paid_amount).max(0.0))
        .sum();
    // جمع پرداخت‌های ثبت‌شده‌ی مشتری
    let total_paid: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(amount), 0) FROM payments WHERE customer_id = ?1",
            params![customer_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(Summary {
        total_invoiced,
        total_paid,
        debt,
    })
}

// ---------- مشتریان ----------

#[tauri::command]
pub fn list_customers(state: State<'_, DbState>) -> Result<Vec<Customer>, String> {
    let conn = lock(&state)?;
    let mut stmt = conn
        .prepare("SELECT id, name, phone, address, credit_limit FROM customers ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Customer {
                id: r.get(0)?,
                name: r.get(1)?,
                phone: r.get(2)?,
                address: r.get(3)?,
                credit_limit: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub fn add_customer(
    state: State<'_, DbState>,
    name: String,
    phone: String,
    address: String,
    credit_limit: f64,
) -> Result<Customer, String> {
    let conn = lock(&state)?;
    conn.execute(
        "INSERT INTO customers (name, phone, address, credit_limit) VALUES (?1, ?2, ?3, ?4)",
        params![name, phone, address, credit_limit],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    Ok(Customer {
        id,
        name,
        phone,
        address,
        credit_limit,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn update_customer(
    state: State<'_, DbState>,
    id: i64,
    name: String,
    phone: String,
    address: String,
    credit_limit: f64,
) -> Result<(), String> {
    let conn = lock(&state)?;
    conn.execute(
        "UPDATE customers SET name = ?1, phone = ?2, address = ?3, credit_limit = ?4 WHERE id = ?5",
        params![name, phone, address, credit_limit, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_customer(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let conn = lock(&state)?;
    conn.execute("DELETE FROM customers WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- محصولات ----------

#[tauri::command]
pub fn list_products(state: State<'_, DbState>) -> Result<Vec<Product>, String> {
    let conn = lock(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, unit_price, unit, cost_price, stock, min_stock \
             FROM products ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Product {
                id: r.get(0)?,
                name: r.get(1)?,
                unit_price: r.get(2)?,
                unit: r.get(3)?,
                cost_price: r.get(4)?,
                stock: r.get(5)?,
                min_stock: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub fn add_product(
    state: State<'_, DbState>,
    name: String,
    unit_price: f64,
    unit: String,
    cost_price: f64,
    stock: f64,
    min_stock: f64,
) -> Result<Product, String> {
    let conn = lock(&state)?;
    let unit = if unit.trim().is_empty() {
        "عدد".to_string()
    } else {
        unit
    };
    conn.execute(
        "INSERT INTO products (name, unit_price, unit, cost_price, stock, min_stock) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![name, unit_price, unit, cost_price, stock, min_stock],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    Ok(Product {
        id,
        name,
        unit_price,
        unit,
        cost_price,
        stock,
        min_stock,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn update_product(
    state: State<'_, DbState>,
    id: i64,
    name: String,
    unit_price: f64,
    unit: String,
    cost_price: f64,
    stock: f64,
    min_stock: f64,
) -> Result<(), String> {
    let conn = lock(&state)?;
    let unit = if unit.trim().is_empty() {
        "عدد".to_string()
    } else {
        unit
    };
    conn.execute(
        "UPDATE products SET name = ?1, unit_price = ?2, unit = ?3, cost_price = ?4, \
         stock = ?5, min_stock = ?6 WHERE id = ?7",
        params![name, unit_price, unit, cost_price, stock, min_stock, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_product(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let conn = lock(&state)?;
    conn.execute("DELETE FROM products WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- فاکتورها ----------

/// تغییر موجودی محصولات بر اساس آیتم‌های فاکتور (تطبیق با نام محصول) —
/// ردیف «مانده حساب قبلی» مستثناست و آیتم بدون محصول هم‌نام اثری ندارد.
/// ‏sign=+1‎ برگرداندن به انبار (حذف یا قبل از ویرایش)، ‎sign=−1‎ کم‌کردن (ثبت/ویرایش تازه)
fn adjust_stock(conn: &Connection, items: &[NewItem], sign: f64) -> Result<(), String> {
    for it in items {
        if it.name == BALANCE_ITEM_NAME {
            continue;
        }
        conn.execute(
            "UPDATE products SET stock = stock + ?1 WHERE name = ?2",
            params![sign * it.qty, it.name],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// آیتم‌های فعلی یک فاکتور (برای برگرداندن موجودی در ویرایش/حذف)
fn load_invoice_items(conn: &Connection, invoice_id: i64) -> Result<Vec<NewItem>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT name, unit_price, qty, discount_percent FROM invoice_items \
             WHERE invoice_id = ?1 ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![invoice_id], |r| {
            Ok(NewItem {
                name: r.get(0)?,
                unit_price: r.get(1)?,
                qty: r.get(2)?,
                discount_percent: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub fn list_invoices(
    state: State<'_, DbState>,
    customer_id: i64,
) -> Result<Vec<InvoiceView>, String> {
    let conn = lock(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, customer_id, invoice_number, date, paid_amount, discount_amount, due_date \
             FROM invoices WHERE customer_id = ?1 ORDER BY invoice_number DESC",
        )
        .map_err(|e| e.to_string())?;
    let inv_rows = stmt
        .query_map(params![customer_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, f64>(4)?,
                r.get::<_, f64>(5)?,
                r.get::<_, String>(6)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut items_by_invoice = load_items_grouped(&conn, customer_id)?;
    let mut out = Vec::new();
    for inv in inv_rows {
        let (id, cid, invoice_number, date, paid_amount, discount_amount, due_date) =
            inv.map_err(|e| e.to_string())?;
        let items = items_by_invoice.remove(&id).unwrap_or_default();
        let total = invoice_total_of(&items, discount_amount);
        let basis = invoice_basis_of(&items, discount_amount);
        out.push(InvoiceView {
            id,
            customer_id: cid,
            invoice_number,
            date,
            items,
            total,
            paid_amount,
            status: status_of(basis, paid_amount),
            discount_amount,
            due_date,
        });
    }
    Ok(out)
}

#[tauri::command(rename_all = "camelCase")]
pub fn create_invoice(
    state: State<'_, DbState>,
    customer_id: i64,
    items: Vec<NewItem>,
    invoice_number: Option<i64>,
    discount_amount: f64,
    due_date: Option<String>,
) -> Result<InvoiceView, String> {
    // سررسید خالی (null از فرانت) یعنی بدون سررسید
    let due_date = due_date.unwrap_or_default();
    let mut conn = lock(&state)?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("شروع تراکنش ثبت فاکتور ناموفق بود: {e}"))?;
    // شماره فاکتور: دستی (در صورت تکراری نبودن) یا خودکار max+1
    let number: i64 = match invoice_number {
        Some(n) => {
            let exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM invoices WHERE invoice_number = ?1)",
                    params![n],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if exists {
                return Err("این شماره فاکتور قبلاً ثبت شده".to_string());
            }
            n
        }
        None => tx
            .query_row(
                "SELECT COALESCE(MAX(invoice_number), 0) + 1 FROM invoices",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?,
    };
    let date = today_iso();
    tx.execute(
        "INSERT INTO invoices (customer_id, invoice_number, date, paid_amount, discount_amount, due_date) \
         VALUES (?1, ?2, ?3, 0, ?4, ?5)",
        params![customer_id, number, date, discount_amount, due_date],
    )
    .map_err(|e| e.to_string())?;
    let id = tx.last_insert_rowid();
    insert_items(&tx, id, &items)?;
    // کم‌کردن موجودی محصولات همین فاکتور (داخل همان تراکنش)
    adjust_stock(&tx, &items, -1.0)?;
    tx.commit()
        .map_err(|e| format!("ثبت نهایی فاکتور ناموفق بود: {e}"))?;
    let view_items: Vec<ItemView> = items
        .into_iter()
        .map(|i| ItemView {
            name: i.name,
            unit_price: i.unit_price,
            qty: i.qty,
            discount_percent: i.discount_percent,
        })
        .collect();
    let total = invoice_total_of(&view_items, discount_amount);
    let basis = invoice_basis_of(&view_items, discount_amount);
    Ok(InvoiceView {
        id,
        customer_id,
        invoice_number: number,
        date,
        items: view_items,
        total,
        paid_amount: 0.0,
        status: status_of(basis, 0.0),
        discount_amount,
        due_date,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn update_invoice(
    state: State<'_, DbState>,
    id: i64,
    items: Vec<NewItem>,
    discount_amount: f64,
    due_date: Option<String>,
) -> Result<(), String> {
    // سررسید خالی (null از فرانت) یعنی بدون سررسید
    let due_date = due_date.unwrap_or_default();
    let mut conn = lock(&state)?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("شروع تراکنش ویرایش فاکتور ناموفق بود: {e}"))?;
    // ویرایش = برگرداندن موجودی آیتم‌های قبلی + اعمال آیتم‌های تازه (تراکنشی)
    let old_items = load_invoice_items(&tx, id)?;
    adjust_stock(&tx, &old_items, 1.0)?;
    tx.execute("DELETE FROM invoice_items WHERE invoice_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    insert_items(&tx, id, &items)?;
    adjust_stock(&tx, &items, -1.0)?;
    tx.execute(
        "UPDATE invoices SET discount_amount = ?1, due_date = ?2 WHERE id = ?3",
        params![discount_amount, due_date, id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit()
        .map_err(|e| format!("ثبت نهایی ویرایش فاکتور ناموفق بود: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn delete_invoice(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let mut conn = lock(&state)?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("شروع تراکنش حذف فاکتور ناموفق بود: {e}"))?;
    // برگرداندن موجودی آیتم‌های فاکتور حذف‌شده
    let old_items = load_invoice_items(&tx, id)?;
    adjust_stock(&tx, &old_items, 1.0)?;
    tx.execute("DELETE FROM invoice_items WHERE invoice_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM invoices WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.commit()
        .map_err(|e| format!("ثبت نهایی حذف فاکتور ناموفق بود: {e}"))?;
    Ok(())
}

// ---------- پرداخت و خلاصه حساب ----------

#[tauri::command(rename_all = "camelCase")]
pub fn record_payment(
    state: State<'_, DbState>,
    customer_id: i64,
    amount: f64,
    note: String,
    method: String,
) -> Result<Summary, String> {
    // روش پرداخت: نقد/کارتخوان/چک/نسیه — خالی یعنی پیش‌فرض «نقد»
    let method = if method.trim().is_empty() {
        "نقد".to_string()
    } else if ["نقد", "کارتخوان", "چک", "نسیه"].contains(&method.as_str()) {
        method
    } else {
        return Err("روش پرداخت نامعتبر است.".to_string());
    };
    let conn = lock(&state)?;
    let date = today_iso();
    conn.execute(
        "INSERT INTO payments (customer_id, amount, date, note, method) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![customer_id, amount, date, note, method],
    )
    .map_err(|e| e.to_string())?;

    // تخصیص مبلغ به قدیمی‌ترین فاکتورهای پرداخت‌نشده — بر مبنای بدهی هر فاکتور
    // (جمع جدید با تخفیف‌ها، بدون «مانده حساب قبلی») دقیقاً مثل فرمول خلاصه حساب
    let calcs = invoice_calcs(&conn, customer_id)?;
    let mut remaining = amount;
    for c in &calcs {
        if remaining <= 0.0 {
            break;
        }
        let owed = c.basis - c.paid_amount;
        if owed <= 0.0 {
            continue;
        }
        let apply = owed.min(remaining);
        conn.execute(
            "UPDATE invoices SET paid_amount = paid_amount + ?1 WHERE id = ?2",
            params![apply, c.id],
        )
        .map_err(|e| e.to_string())?;
        remaining -= apply;
    }

    summary_for(&conn, customer_id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn customer_summary(
    state: State<'_, DbState>,
    customer_id: i64,
) -> Result<Summary, String> {
    let conn = lock(&state)?;
    summary_for(&conn, customer_id)
}

// ---------- گزارش‌ها ----------

/// فروش یک روز: جمع فروش (بدون «مانده حساب قبلی»، با تخفیف‌ها) + تعداد فاکتور
#[derive(Debug, Clone, Serialize)]
pub struct SalesDay {
    pub date: String,
    pub total: f64,
    pub count: i64,
}

#[tauri::command(rename_all = "camelCase")]
pub fn report_sales(
    state: State<'_, DbState>,
    from: String,
    to: String,
) -> Result<Vec<SalesDay>, String> {
    let conn = lock(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT i.date, i.discount_amount, \
                    COALESCE(SUM(CASE WHEN it.name = ?3 THEN 0 \
                                      ELSE it.unit_price * it.qty * (1 - it.discount_percent / 100.0) END), 0) \
             FROM invoices i LEFT JOIN invoice_items it ON it.invoice_id = i.id \
             WHERE i.date >= ?1 AND i.date <= ?2 \
             GROUP BY i.id ORDER BY i.date ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![from, to, BALANCE_ITEM_NAME], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, f64>(1)?,
                r.get::<_, f64>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut days: std::collections::BTreeMap<String, (f64, i64)> =
        std::collections::BTreeMap::new();
    for row in rows {
        let (date, discount, net_sales) = row.map_err(|e| e.to_string())?;
        let e = days.entry(date).or_insert((0.0, 0));
        e.0 += net_sales - discount;
        e.1 += 1;
    }
    Ok(days
        .into_iter()
        .map(|(date, (total, count))| SalesDay { date, total, count })
        .collect())
}

/// محصول پرفروش: تعداد و مبلغ خالص (بعد از تخفیف سطری) + سود با قیمت خرید فعلی محصول
#[derive(Debug, Clone, Serialize)]
pub struct TopProduct {
    pub name: String,
    pub qty: f64,
    pub amount: f64,
    pub profit: f64,
}

#[tauri::command(rename_all = "camelCase")]
pub fn report_top_products(
    state: State<'_, DbState>,
    from: String,
    to: String,
    limit: Option<i64>,
) -> Result<Vec<TopProduct>, String> {
    // فرانت ممکن است limit نفرستد — پیش‌فرض ۱۰
    let limit = limit.unwrap_or(10);
    let conn = lock(&state)?;
    // قیمت خرید هر محصول (تطبیق با نام؛ نبود محصول = ۰)
    let mut cost_map: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT name, cost_price FROM products")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (n, c) = row.map_err(|e| e.to_string())?;
            cost_map.insert(n, c);
        }
    }
    let mut stmt = conn
        .prepare(
            "SELECT it.name, it.unit_price, it.qty, it.discount_percent \
             FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id \
             WHERE i.date >= ?1 AND i.date <= ?2 AND it.name != ?3",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![from, to, BALANCE_ITEM_NAME], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, f64>(1)?,
                r.get::<_, f64>(2)?,
                r.get::<_, f64>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    // name → (qty, amount, profit)
    let mut agg: std::collections::HashMap<String, (f64, f64, f64)> =
        std::collections::HashMap::new();
    for row in rows {
        let (name, price, qty, disc) = row.map_err(|e| e.to_string())?;
        let net = price * qty * (1.0 - disc / 100.0);
        let cost = cost_map.get(&name).copied().unwrap_or(0.0) * qty;
        let e = agg.entry(name).or_insert((0.0, 0.0, 0.0));
        e.0 += qty;
        e.1 += net;
        e.2 += net - cost;
    }
    let mut out: Vec<TopProduct> = agg
        .into_iter()
        .map(|(name, (qty, amount, profit))| TopProduct {
            name,
            qty,
            amount,
            profit,
        })
        .collect();
    out.sort_by(|a, b| {
        b.amount
            .partial_cmp(&a.amount)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.qty.partial_cmp(&a.qty).unwrap_or(std::cmp::Ordering::Equal))
    });
    if limit > 0 {
        out.truncate(limit as usize);
    }
    Ok(out)
}

/// بدهکار: جمع بدهی + تاریخ قدیمی‌ترین فاکتور پرداخت‌نشده (برای قدمت بدهی)
#[derive(Debug, Clone, Serialize)]
pub struct DebtorRow {
    pub customer_id: i64,
    pub name: String,
    pub debt: f64,
    pub oldest_unpaid_date: String,
}

#[tauri::command]
pub fn report_debtors(state: State<'_, DbState>) -> Result<Vec<DebtorRow>, String> {
    let conn = lock(&state)?;
    let customers: Vec<(i64, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, name FROM customers ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?
    };
    let mut out = Vec::new();
    for (cid, name) in customers {
        let calcs = invoice_calcs(&conn, cid)?;
        let mut debt = 0.0;
        let mut oldest: Option<String> = None;
        for c in &calcs {
            let owed = c.basis - c.paid_amount;
            if owed > 0.0 {
                debt += owed;
                if oldest.is_none() {
                    oldest = Some(c.date.clone());
                }
            }
        }
        if debt > 0.0 {
            out.push(DebtorRow {
                customer_id: cid,
                name,
                debt,
                oldest_unpaid_date: oldest.unwrap_or_default(),
            });
        }
    }
    out.sort_by(|a, b| {
        b.debt
            .partial_cmp(&a.debt)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(out)
}

/// ردیف صورت‌حساب مشتری: گردش زمانی فاکتورها (بدهکار) و پرداخت‌ها (بستانکار) با مانده‌ی جاری
#[derive(Debug, Clone, Serialize)]
pub struct StatementRow {
    pub date: String,
    pub kind: String, // "invoice" | "payment"
    pub description: String,
    pub debit: f64,
    pub credit: f64,
    pub balance: f64,
}

#[tauri::command(rename_all = "camelCase")]
pub fn customer_statement(
    state: State<'_, DbState>,
    customer_id: i64,
) -> Result<Vec<StatementRow>, String> {
    let conn = lock(&state)?;
    // رویدادها: (تاریخ، ترتیب هم‌روز، ردیف بدون مانده) — فاکتور قبل از پرداخت همان روز
    let mut events: Vec<(String, u8, StatementRow)> = Vec::new();
    for c in invoice_calcs(&conn, customer_id)? {
        events.push((
            c.date.clone(),
            0,
            StatementRow {
                date: c.date.clone(),
                kind: "invoice".to_string(),
                description: format!("فاکتور شماره {}", c.invoice_number),
                debit: c.basis,
                credit: 0.0,
                balance: 0.0,
            },
        ));
    }
    {
        let mut stmt = conn
            .prepare(
                "SELECT date, amount, note, method FROM payments \
                 WHERE customer_id = ?1 ORDER BY date ASC, id ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![customer_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, f64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (date, amount, note, method) = row.map_err(|e| e.to_string())?;
            let description = if note.trim().is_empty() {
                format!("پرداخت ({method})")
            } else {
                note
            };
            events.push((
                date.clone(),
                1,
                StatementRow {
                    date,
                    kind: "payment".to_string(),
                    description,
                    debit: 0.0,
                    credit: amount,
                    balance: 0.0,
                },
            ));
        }
    }
    events.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    let mut balance = 0.0;
    let mut out = Vec::with_capacity(events.len());
    for (_, _, mut row) in events {
        balance += row.debit - row.credit;
        row.balance = balance;
        out.push(row);
    }
    Ok(out)
}

// ---------- اطلاعات قناد ----------

fn read_setting_opt(conn: &Connection, key: &str) -> Result<Option<String>, String> {
    let mut stmt = conn
        .prepare("SELECT value FROM settings WHERE key = ?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map(params![key], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    match rows.next() {
        Some(r) => r.map(Some).map_err(|e| e.to_string()),
        None => Ok(None),
    }
}

fn read_setting(conn: &Connection, key: &str) -> Result<String, String> {
    Ok(read_setting_opt(conn, key)?.unwrap_or_default())
}

fn write_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// خواندن مستقیم یک کلید از جدول settings (قرارداد فرانت) — نبودِ کلید = null
#[tauri::command]
pub fn get_setting(state: State<'_, DbState>, key: String) -> Result<Option<String>, String> {
    let conn = lock(&state)?;
    read_setting_opt(&conn, &key)
}

/// نوشتن مستقیم یک کلید در جدول settings (قرارداد فرانت)
#[tauri::command]
pub fn set_setting(state: State<'_, DbState>, key: String, value: String) -> Result<(), String> {
    let conn = lock(&state)?;
    write_setting(&conn, &key, &value)
}

#[tauri::command]
pub fn get_confectioner_info(state: State<'_, DbState>) -> Result<ConfectionerInfo, String> {
    let conn = lock(&state)?;
    Ok(ConfectionerInfo {
        name: read_setting(&conn, "confectioner_name")?,
        phone: read_setting(&conn, "confectioner_phone")?,
    })
}

#[tauri::command]
pub fn set_confectioner_info(
    state: State<'_, DbState>,
    name: String,
    phone: String,
) -> Result<(), String> {
    let conn = lock(&state)?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('confectioner_name', ?1) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![name],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('confectioner_phone', ?1) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![phone],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- تنظیمات موتور آپدیت v2 ----------

/// حالت آپدیت: ‏auto (دانلود خودکار + اطلاع برای نصب) | notify (فقط اطلاع) | off
/// اگر update_mode ست نشده باشد، از کلید قدیمی auto_update_check نگاشت می‌شود
/// (روشن = auto، خاموش = off؛ پیش‌فرض قدیم روشن بود)
#[tauri::command]
pub fn get_update_mode(state: State<'_, DbState>) -> Result<String, String> {
    let conn = lock(&state)?;
    let m = read_setting(&conn, "update_mode")?;
    if m == "auto" || m == "notify" || m == "off" {
        return Ok(m);
    }
    let legacy = read_setting(&conn, "auto_update_check")?;
    Ok(if legacy == "false" || legacy == "0" {
        "off".to_string()
    } else {
        "auto".to_string()
    })
}

#[tauri::command]
pub fn set_update_mode(state: State<'_, DbState>, mode: String) -> Result<(), String> {
    if mode != "auto" && mode != "notify" && mode != "off" {
        return Err("حالت آپدیت نامعتبر است.".to_string());
    }
    let conn = lock(&state)?;
    write_setting(&conn, "update_mode", &mode)
}

/// آخرین نسخه‌ای که به کاربر اطلاع داده شده (ضداسپم)
#[tauri::command]
pub fn get_update_notified_version(state: State<'_, DbState>) -> Result<String, String> {
    let conn = lock(&state)?;
    read_setting(&conn, "update_notified_version")
}

#[tauri::command]
pub fn set_update_notified_version(
    state: State<'_, DbState>,
    version: String,
) -> Result<(), String> {
    let conn = lock(&state)?;
    write_setting(&conn, "update_notified_version", &version)
}

// ---------- خروجی PDF ----------
// نکته: pdf.ts فرانت این دو دستور را با آرگومان‌های camelCase صدا می‌زند
// ({ defaultName } و { path, data: base64 }) — با rename_all هر دو سمت جور است.

#[tauri::command(rename_all = "camelCase")]
pub fn save_pdf_dialog(app: AppHandle, default_name: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::{DialogExt, FilePath};
    let picked = app
        .dialog()
        .file()
        .add_filter("PDF", &["pdf"])
        .set_file_name(&default_name)
        .blocking_save_file();
    Ok(match picked {
        Some(FilePath::Path(p)) => Some(p.to_string_lossy().into_owned()),
        _ => None,
    })
}

#[tauri::command]
pub fn write_pdf_file(path: String, data: String) -> Result<(), String> {
    // فرانت (pdf.ts) دیتا را base64 می‌فرستد؛ دیکد و مستقیم با std می‌نویسیم
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let bytes = STANDARD
        .decode(&data)
        .map_err(|e| format!("base64 decode failed: {e}"))?;
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())
}

// ---------- پشتیبان‌گیری و بازیابی (Export / Import) ----------

const BACKUP_TABLES: [&str; 5] = [
    "customers",
    "products",
    "invoices",
    "invoice_items",
    "payments",
];

/// خلاصه‌ی فایل پشتیبان برای نمایش تأیید به کاربر (قرارداد فرانت)
#[derive(Debug, Clone, Serialize)]
pub struct BackupInfo {
    pub path: String,
    pub exported_at: String,
    pub currency: String,
    pub counts: BackupCounts,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupCounts {
    pub customers: usize,
    pub products: usize,
    pub invoices: usize,
    pub payments: usize,
}

/// خواندن کل یک جدول به‌صورت آرایه‌ی JSON از آبجکت‌های سطر (با ID اصلی)
fn read_table_rows(conn: &Connection, table: &str) -> Result<Vec<serde_json::Value>, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT * FROM {table} ORDER BY id"))
        .map_err(|e| e.to_string())?;
    let col_names: Vec<String> = stmt
        .column_names()
        .iter()
        .map(|s| s.to_string())
        .collect();
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let mut obj = serde_json::Map::new();
        for (i, name) in col_names.iter().enumerate() {
            use rusqlite::types::ValueRef;
            let v = match row.get_ref(i).map_err(|e| e.to_string())? {
                ValueRef::Null => serde_json::Value::Null,
                ValueRef::Integer(n) => serde_json::json!(n),
                ValueRef::Real(f) => serde_json::json!(f),
                ValueRef::Text(t) => {
                    serde_json::json!(String::from_utf8_lossy(t).into_owned())
                }
                ValueRef::Blob(b) => {
                    use base64::{engine::general_purpose::STANDARD, Engine as _};
                    serde_json::json!(STANDARD.encode(b))
                }
            };
            obj.insert(name.clone(), v);
        }
        out.push(serde_json::Value::Object(obj));
    }
    Ok(out)
}

// ---------- لوگوی کاربر (برای PDF) ----------
// لوگو در پوشه‌ی داده‌ی برنامه با نام ثابت user-logo.<ext> نگه داشته می‌شود؛
// PDF و پیش‌نمایش از get_user_logo می‌خوانند.

const LOGO_MAX_BYTES: usize = 2 * 1024 * 1024;
const LOGO_EXTS: [&str; 4] = ["png", "jpg", "jpeg", "webp"];

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("مسیر داده‌ی برنامه پیدا نشد: {e}"))
}

fn find_user_logo(dir: &Path) -> Option<(PathBuf, String)> {
    for ext in LOGO_EXTS {
        let p = dir.join(format!("user-logo.{ext}"));
        if p.exists() {
            return Some((p, ext.to_string()));
        }
    }
    None
}

/// تشخیص فرمت واقعی عکس از روی بایت‌های اول (نه پسوند فایل)
fn detect_image_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else {
        None
    }
}

/// ذخیره‌ی بایت‌های لوگو با اعتبارسنجی (فرمت واقعی + سقف ۲ مگابایت)؛ پسوند واقعی برمی‌گردد
fn save_user_logo_bytes(dir: &Path, bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > LOGO_MAX_BYTES {
        return Err("حجم لوگو باید حداکثر ۲ مگابایت باشد.".to_string());
    }
    let ext = detect_image_ext(bytes).ok_or_else(|| {
        "فرمت فایل پشتیبانی نمی‌شود؛ یک عکس PNG یا JPG یا WebP انتخاب کنید.".to_string()
    })?;
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("ساخت پوشه‌ی داده‌ی برنامه ناموفق بود: {e}"))?;
    // نسخه‌ی قبلی (با هر پسوندی) پاک شود تا فقط یک لوگو بماند
    for e in LOGO_EXTS {
        let p = dir.join(format!("user-logo.{e}"));
        if p.exists() {
            let _ = std::fs::remove_file(&p);
        }
    }
    std::fs::write(dir.join(format!("user-logo.{ext}")), bytes)
        .map_err(|e| format!("ذخیره‌ی فایل لوگو ناموفق بود: {e}"))?;
    Ok(ext.to_string())
}

fn user_logo_data_url(dir: &Path) -> Result<Option<String>, String> {
    use base64::Engine;
    match find_user_logo(dir) {
        None => Ok(None),
        Some((path, ext)) => {
            let bytes = std::fs::read(&path)
                .map_err(|e| format!("خواندن فایل لوگو ناموفق بود: {e}"))?;
            let mime = match ext.as_str() {
                "png" => "image/png",
                "webp" => "image/webp",
                _ => "image/jpeg",
            };
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            Ok(Some(format!("data:{mime};base64,{b64}")))
        }
    }
}

/// انتخاب فایل لوگو از دیالوگ، اعتبارسنجی و ذخیره — data URL برای پیش‌نمایش یا None (انصراف)
#[tauri::command]
pub fn pick_and_set_user_logo(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::{DialogExt, FilePath};
    let picked = app
        .dialog()
        .file()
        .add_filter("عکس", &["png", "jpg", "jpeg", "webp"])
        .blocking_pick_file();
    let path = match picked {
        Some(FilePath::Path(p)) => p,
        _ => return Ok(None),
    };
    let bytes = std::fs::read(&path)
        .map_err(|e| format!("خواندن فایل لوگو ناموفق بود: {e}"))?;
    let dir = data_dir(&app)?;
    save_user_logo_bytes(&dir, &bytes)?;
    user_logo_data_url(&dir)
}

/// data URL لوگوی کاربر برای PDF و پیش‌نمایش — None اگر لوگویی نیست
#[tauri::command]
pub fn get_user_logo(app: AppHandle) -> Result<Option<String>, String> {
    user_logo_data_url(&data_dir(&app)?)
}

/// حذف فایل لوگوی کاربر
#[tauri::command]
pub fn clear_user_logo(app: AppHandle) -> Result<(), String> {
    let dir = data_dir(&app)?;
    for e in LOGO_EXTS {
        let p = dir.join(format!("user-logo.{e}"));
        if p.exists() {
            std::fs::remove_file(&p)
                .map_err(|e2| format!("حذف فایل لوگو ناموفق بود: {e2}"))?;
        }
    }
    Ok(())
}

/// ساخت و ذخیره‌ی فایل پشتیبان JSON از همه‌ی جدول‌ها — مسیر انتخابی یا None (انصراف)
#[tauri::command]
pub fn export_backup(
    app: AppHandle,
    state: State<'_, DbState>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::{DialogExt, FilePath};
    let conn = lock(&state)?;
    let mut data = serde_json::Map::new();
    for t in BACKUP_TABLES {
        let rows = read_table_rows(&conn, t)?;
        data.insert(t.to_string(), serde_json::Value::Array(rows));
    }
    // settings به‌صورت آبجکت key → value
    let mut settings = serde_json::Map::new();
    {
        let mut stmt = conn
            .prepare("SELECT key, value FROM settings ORDER BY key")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        while let Some(r) = rows.next().map_err(|e| e.to_string())? {
            let k: String = r.get(0).map_err(|e| e.to_string())?;
            let v: String = r.get(1).map_err(|e| e.to_string())?;
            settings.insert(k, serde_json::json!(v));
        }
    }
    data.insert("settings".to_string(), serde_json::Value::Object(settings));
    // لوگوی کاربر هم کنار داده‌ها می‌رود: {ext, base64} یا null
    // (کلید pdf_palette هم داخل همان settings بالاست و خودکار جابه‌جا می‌شود)
    let user_logo = data_dir(&app).ok().and_then(|dir| {
        let (path, ext) = find_user_logo(&dir)?;
        let bytes = std::fs::read(&path).ok()?;
        use base64::Engine;
        Some(serde_json::json!({
            "ext": ext,
            "base64": base64::engine::general_purpose::STANDARD.encode(&bytes),
        }))
    });
    data.insert(
        "user_logo".to_string(),
        user_logo.unwrap_or(serde_json::Value::Null),
    );
    // واحد پول ذخیره‌شده‌ی فعلی: گارد مهاجرت ست شده باشد یعنی داده‌ها ریالی‌اند
    let currency = if read_setting(&conn, "currency_rial_migrated")? == "1" {
        "rial"
    } else {
        "toman"
    };
    let backup = serde_json::json!({
        "app": "ShirinHesab",
        "kind": "backup",
        "format": 1,
        "currency": currency,
        "exported_at": Local::now().to_rfc3339(),
        "data": serde_json::Value::Object(data),
    });
    let text = serde_json::to_string_pretty(&backup).map_err(|e| e.to_string())?;
    drop(conn);
    let default_name = format!("shirin-hesab-backup-{}.json", today_iso());
    let picked = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .set_file_name(&default_name)
        .blocking_save_file();
    let path = match picked {
        Some(FilePath::Path(p)) => p,
        _ => return Ok(None),
    };
    std::fs::write(&path, text)
        .map_err(|e| format!("نوشتن فایل پشتیبان ناموفق بود: {e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// پشتیبان خوانده و اعتبارسنجی‌شده (بدون اعمال هیچ تغییری)
struct LoadedBackup {
    exported_at: String,
    currency: String,
    data: serde_json::Map<String, serde_json::Value>,
    /// بایت‌های لوگوی کاربر از داخل بک‌آپ — None در بک‌آپ‌های قدیمی یا بدون لوگو
    user_logo: Option<Vec<u8>>,
}

fn load_backup_file(path: &str) -> Result<LoadedBackup, String> {
    let raw = std::fs::read_to_string(path).map_err(|_| {
        "خواندن فایل پشتیبان ناموفق بود؛ فایل پیدا نشد یا قابل خواندن نیست.".to_string()
    })?;
    let root: serde_json::Value = serde_json::from_str(&raw).map_err(|_| {
        "فایل پشتیبان معتبر نیست: محتوای JSON خراب یا ناقص است.".to_string()
    })?;
    let obj = root.as_object().ok_or_else(|| {
        "فایل پشتیبان معتبر نیست: ساختار اصلی فایل نادرست است.".to_string()
    })?;
    if obj.get("app").and_then(|v| v.as_str()) != Some("ShirinHesab") {
        return Err("این فایل، پشتیبان «شیرین‌حساب» نیست.".to_string());
    }
    if obj.get("kind").and_then(|v| v.as_str()) != Some("backup") {
        return Err("این فایل، فایل پشتیبان نیست.".to_string());
    }
    if obj.get("format").and_then(|v| v.as_i64()) != Some(1) {
        return Err(
            "نسخه‌ی قالب این پشتیبان پشتیبانی نمی‌شود؛ برنامه را به‌روز کنید.".to_string(),
        );
    }
    let currency = obj.get("currency").and_then(|v| v.as_str()).unwrap_or("");
    if currency != "rial" && currency != "toman" {
        return Err("واحد پول فایل پشتیبان ناشناخته است.".to_string());
    }
    let exported_at = obj
        .get("exported_at")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let data = obj.get("data").and_then(|v| v.as_object()).ok_or_else(|| {
        "فایل پشتیبان ناقص است: بخش داده‌ها وجود ندارد.".to_string()
    })?;
    for t in BACKUP_TABLES {
        match data.get(t) {
            Some(serde_json::Value::Array(rows))
                if rows.iter().all(|r| r.is_object()) => {}
            _ => {
                return Err(format!(
                    "فایل پشتیبان ناقص است: بخش «{t}» وجود ندارد یا نادرست است."
                ))
            }
        }
    }
    match data.get("settings") {
        Some(serde_json::Value::Object(_)) => {}
        _ => {
            return Err(
                "فایل پشتیبان ناقص است: بخش تنظیمات وجود ندارد.".to_string(),
            )
        }
    }
    // لوگوی کاربر اختیاری است — بک‌آپ‌های قدیمی این بخش را ندارند و نباید خطا بدهند؛
    // اگر بود، base64 و فرمت و سقف حجمش همین‌جا اعتبارسنجی می‌شود
    let user_logo = match data.get("user_logo") {
        None | Some(serde_json::Value::Null) => None,
        Some(v) => {
            let obj = v.as_object().ok_or_else(|| {
                "فایل پشتیبان ناقص است: بخش لوگوی کاربر نادرست است.".to_string()
            })?;
            let b64 = obj
                .get("base64")
                .and_then(|x| x.as_str())
                .ok_or_else(|| {
                    "فایل پشتیبان ناقص است: داده‌ی لوگوی کاربر وجود ندارد.".to_string()
                })?;
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|_| "داده‌ی لوگوی داخل فایل پشتیبان خراب است.".to_string())?;
            if bytes.len() > LOGO_MAX_BYTES {
                return Err(
                    "لوگوی داخل فایل پشتیبان بزرگ‌تر از حد مجاز (۲ مگابایت) است.".to_string(),
                );
            }
            if detect_image_ext(&bytes).is_none() {
                return Err("لوگوی داخل فایل پشتیبان عکس معتبر نیست.".to_string());
            }
            Some(bytes)
        }
    };
    Ok(LoadedBackup {
        exported_at,
        currency: currency.to_string(),
        data: data.clone(),
        user_logo,
    })
}

/// انتخاب فایل پشتیبان و اعتبارسنجی — فقط خلاصه برمی‌گردد، هیچ تغییری اعمال نمی‌شود
#[tauri::command]
pub fn pick_and_validate_backup(app: AppHandle) -> Result<Option<BackupInfo>, String> {
    use tauri_plugin_dialog::{DialogExt, FilePath};
    let picked = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .blocking_pick_file();
    let path = match picked {
        Some(FilePath::Path(p)) => p,
        _ => return Ok(None),
    };
    let path_str = path.to_string_lossy().into_owned();
    let backup = load_backup_file(&path_str)?;
    let count = |t: &str| {
        backup
            .data
            .get(t)
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0)
    };
    Ok(Some(BackupInfo {
        path: path_str,
        exported_at: backup.exported_at,
        currency: backup.currency,
        counts: BackupCounts {
            customers: count("customers"),
            products: count("products"),
            invoices: count("invoices"),
            payments: count("payments"),
        },
    }))
}

/// ستون‌هایی که هنگام بازیابی پشتیبان تومانی باید ×۱۰ شوند
fn is_amount_column(table: &str, column: &str) -> bool {
    matches!(
        (table, column),
        ("products", "unit_price")
            | ("invoice_items", "unit_price")
            | ("invoices", "paid_amount")
            | ("payments", "amount")
    )
}

fn insert_backup_row(
    tx: &rusqlite::Transaction<'_>,
    table: &str,
    row: &serde_json::Value,
    mult: f64,
) -> Result<(), String> {
    let obj = row
        .as_object()
        .ok_or_else(|| format!("سطر نامعتبر در بخش «{table}»."))?;
    if obj.is_empty() {
        return Err(format!("سطر خالی در بخش «{table}»."));
    }
    let cols: Vec<&String> = obj.keys().collect();
    let col_sql = cols
        .iter()
        .map(|c| format!("\"{c}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let marks = (1..=cols.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("INSERT INTO {table} ({col_sql}) VALUES ({marks})");
    let mut values: Vec<rusqlite::types::Value> = Vec::with_capacity(cols.len());
    for c in &cols {
        let raw = &obj[*c];
        let v = match raw {
            serde_json::Value::Null => rusqlite::types::Value::Null,
            serde_json::Value::Bool(b) => {
                rusqlite::types::Value::Integer(if *b { 1 } else { 0 })
            }
            serde_json::Value::Number(n) => {
                if mult != 1.0 && is_amount_column(table, c) {
                    let f = n
                        .as_f64()
                        .ok_or_else(|| format!("مبلغ نامعتبر در بخش «{table}»."))?;
                    rusqlite::types::Value::Real(f * mult)
                } else if let Some(i) = n.as_i64() {
                    rusqlite::types::Value::Integer(i)
                } else if let Some(f) = n.as_f64() {
                    rusqlite::types::Value::Real(f)
                } else {
                    return Err(format!("عدد نامعتبر در بخش «{table}»."));
                }
            }
            serde_json::Value::String(s) => rusqlite::types::Value::Text(s.clone()),
            _ => return Err(format!("مقدار نامعتبر در بخش «{table}».")),
        };
        values.push(v);
    }
    tx.execute(&sql, rusqlite::params_from_iter(values.iter()))
        .map_err(|e| {
            format!("درج داده‌های «{table}» ناموفق بود؛ هیچ تغییری اعمال نشد. ({e})")
        })?;
    Ok(())
}

/// اعمال بازیابی داخل تراکنشِ باز — هر خطا یعنی rollback کامل توسط صدازننده
fn apply_import_tx(
    tx: &rusqlite::Transaction<'_>,
    backup: &LoadedBackup,
    mult: f64,
) -> Result<(), String> {
    // حذف داده‌های فعلی: اول جدول‌های فرزند، بعد والدها
    for t in ["invoice_items", "payments", "invoices", "products", "customers"] {
        tx.execute(&format!("DELETE FROM {t}"), [])
            .map_err(|e| format!("پاک‌کردن داده‌های فعلی («{t}») ناموفق بود: {e}"))?;
    }
    // درج سطرهای پشتیبان با ID اصلی: اول والدها، بعد فرزندها
    for t in ["customers", "products", "invoices", "invoice_items", "payments"] {
        let rows = backup
            .data
            .get(t)
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for row in &rows {
            insert_backup_row(tx, t, row, mult)?;
        }
    }
    // تنظیمات از پشتیبان برمی‌گردد — جز گارد مهاجرت ریال که محلی و دست‌نخورده می‌ماند
    if let Some(settings) = backup.data.get("settings").and_then(|v| v.as_object()) {
        for (k, v) in settings {
            if k == "currency_rial_migrated" {
                continue;
            }
            let val = v
                .as_str()
                .map(|s| s.to_string())
                .unwrap_or_else(|| v.to_string());
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![k, val],
            )
            .map_err(|e| format!("بازیابی تنظیمات ناموفق بود: {e}"))?;
        }
    }
    Ok(())
}

/// بازیابی کامل از فایل پشتیبان — در یک تراکنش؛ پشتیبان تومانی هنگام درج ×۱۰ می‌شود
#[tauri::command]
pub fn apply_backup_import(
    app: AppHandle,
    state: State<'_, DbState>,
    path: String,
) -> Result<(), String> {
    let backup = load_backup_file(&path)?;
    let mult: f64 = if backup.currency == "toman" { 10.0 } else { 1.0 };
    let mut conn = lock(&state)?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("شروع تراکنش بازیابی ناموفق بود: {e}"))?;
    // اگر apply_import_tx خطا بدهد، tx بدون commit رها و همه‌چیز rollback می‌شود
    apply_import_tx(&tx, &backup, mult)?;
    // لوگوی کاربر هم برمی‌گردد — قبل از commit تا خطایش تراکنش را هم rollback کند؛
    // بک‌آپ بدون لوگو (قدیمی) لوگوی فعلی را دست نمی‌زند
    if let Some(bytes) = &backup.user_logo {
        let dir = data_dir(&app)?;
        save_user_logo_bytes(&dir, bytes)?;
    }
    tx.commit()
        .map_err(|e| format!("ثبت نهایی بازیابی ناموفق بود: {e}"))?;
    Ok(())
}
