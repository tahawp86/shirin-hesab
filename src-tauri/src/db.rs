// شیرین حساب — لایه دیتابیس (SQLite با rusqlite)
// قرارداد دستورها: امضاهای Rust دقیقاً مطابق اسپک (snake_case).
// روی کامندهایی که فرانت آرگومان چندکلمه‌ای را camelCase می‌فرستد
// (مثل customerId در api.ts و defaultName در pdf.ts) از
// rename_all="camelCase" استفاده شده تا وایر فرانت هم جور باشد.

use chrono::Local;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Manager, State};

// ---------- مدل‌ها ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Customer {
    pub id: i64,
    pub name: String,
    pub phone: String,
    pub address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Product {
    pub id: i64,
    pub name: String,
    pub unit_price: f64,
}

/// قلم ورودی فاکتور از سمت فرانت
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewItem {
    pub name: String,
    pub unit_price: f64,
    pub qty: f64,
}

/// قلم فاکتور در خروجی (مطابق قرارداد فرانت: بدون id)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemView {
    pub name: String,
    pub unit_price: f64,
    pub qty: f64,
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
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT NOT NULL,
    phone   TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS products (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    unit_price REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS invoices (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id    INTEGER NOT NULL,
    invoice_number INTEGER NOT NULL UNIQUE,
    date           TEXT NOT NULL,
    paid_amount    REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS invoice_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id  INTEGER NOT NULL,
    name        TEXT NOT NULL,
    unit_price  REAL NOT NULL,
    qty         REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    amount      REAL NOT NULL,
    date        TEXT NOT NULL,
    note        TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id);
";

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
            "SELECT invoice_id, name, unit_price, qty FROM invoice_items \
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
            "INSERT INTO invoice_items (invoice_id, name, unit_price, qty) VALUES (?1, ?2, ?3, ?4)",
            params![invoice_id, it.name, it.unit_price, it.qty],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn items_total(items: &[ItemView]) -> f64 {
    items.iter().map(|it| it.unit_price * it.qty).sum()
}

fn status_of(total: f64, paid_amount: f64) -> String {
    if paid_amount >= total {
        "paid".to_string()
    } else {
        "unpaid".to_string()
    }
}

fn summary_for(conn: &Connection, customer_id: i64) -> Result<Summary, String> {
    // جمع کل فاکتورها (برای نمایش) — آیتم‌های «مانده حساب قبلی» جزوش نیستند،
    // وگرنه بدهی قبلی دوبار شمرده می‌شود (یک بار در فاکتور خودش، یک بار در فاکتور جدید)
    let total_all: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(it.unit_price * it.qty), 0) \
             FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id \
             WHERE i.customer_id = ?1",
            params![customer_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let balance_total: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(it.unit_price * it.qty), 0) \
             FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id \
             WHERE i.customer_id = ?1 AND it.name = ?2",
            params![customer_id, BALANCE_ITEM_NAME],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let total_invoiced = total_all - balance_total;
    // جمع پرداخت‌های ثبت‌شده‌ی مشتری
    let total_paid: f64 = conn
        .query_row(
            "SELECT COALESCE(SUM(amount), 0) FROM payments WHERE customer_id = ?1",
            params![customer_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    // بدهکاری = جمع «پرداخت‌نشده»‌ی فاکتورها، فاکتوربه‌فاکتور (منفی نمی‌شود):
    // برای هر فاکتور: ‎max(0, (جمع فاکتور − آیتم‌های «مانده حساب قبلی») − paid_amount)‎
    let debt: f64 = {
        let mut stmt = conn
            .prepare(
                "SELECT i.paid_amount, \
                        COALESCE(SUM(it.unit_price * it.qty), 0), \
                        COALESCE(SUM(CASE WHEN it.name = ?2 THEN it.unit_price * it.qty ELSE 0 END), 0) \
                 FROM invoices i LEFT JOIN invoice_items it ON it.invoice_id = i.id \
                 WHERE i.customer_id = ?1 \
                 GROUP BY i.id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![customer_id, BALANCE_ITEM_NAME], |r| {
                Ok((
                    r.get::<_, f64>(0)?,
                    r.get::<_, f64>(1)?,
                    r.get::<_, f64>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut d = 0.0;
        for row in rows {
            let (paid, total, balance) = row.map_err(|e| e.to_string())?;
            d += ((total - balance) - paid).max(0.0);
        }
        d
    };
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
        .prepare("SELECT id, name, phone, address FROM customers ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Customer {
                id: r.get(0)?,
                name: r.get(1)?,
                phone: r.get(2)?,
                address: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_customer(
    state: State<'_, DbState>,
    name: String,
    phone: String,
    address: String,
) -> Result<Customer, String> {
    let conn = lock(&state)?;
    conn.execute(
        "INSERT INTO customers (name, phone, address) VALUES (?1, ?2, ?3)",
        params![name, phone, address],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    Ok(Customer {
        id,
        name,
        phone,
        address,
    })
}

#[tauri::command]
pub fn update_customer(
    state: State<'_, DbState>,
    id: i64,
    name: String,
    phone: String,
    address: String,
) -> Result<(), String> {
    let conn = lock(&state)?;
    conn.execute(
        "UPDATE customers SET name = ?1, phone = ?2, address = ?3 WHERE id = ?4",
        params![name, phone, address, id],
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
        .prepare("SELECT id, name, unit_price FROM products ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Product {
                id: r.get(0)?,
                name: r.get(1)?,
                unit_price: r.get(2)?,
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
) -> Result<Product, String> {
    let conn = lock(&state)?;
    conn.execute(
        "INSERT INTO products (name, unit_price) VALUES (?1, ?2)",
        params![name, unit_price],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    Ok(Product {
        id,
        name,
        unit_price,
    })
}

#[tauri::command]
pub fn update_product(
    state: State<'_, DbState>,
    id: i64,
    name: String,
    unit_price: f64,
) -> Result<(), String> {
    let conn = lock(&state)?;
    conn.execute(
        "UPDATE products SET name = ?1, unit_price = ?2 WHERE id = ?3",
        params![name, unit_price, id],
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

#[tauri::command(rename_all = "camelCase")]
pub fn list_invoices(
    state: State<'_, DbState>,
    customer_id: i64,
) -> Result<Vec<InvoiceView>, String> {
    let conn = lock(&state)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, customer_id, invoice_number, date, paid_amount \
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
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut items_by_invoice = load_items_grouped(&conn, customer_id)?;
    let mut out = Vec::new();
    for inv in inv_rows {
        let (id, cid, invoice_number, date, paid_amount) = inv.map_err(|e| e.to_string())?;
        let items = items_by_invoice.remove(&id).unwrap_or_default();
        let total = items_total(&items);
        out.push(InvoiceView {
            id,
            customer_id: cid,
            invoice_number,
            date,
            items,
            total,
            paid_amount,
            status: status_of(total, paid_amount),
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
) -> Result<InvoiceView, String> {
    let conn = lock(&state)?;
    // شماره فاکتور: دستی (در صورت تکراری نبودن) یا خودکار max+1
    let number: i64 = match invoice_number {
        Some(n) => {
            let exists: bool = conn
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
        None => conn
            .query_row(
                "SELECT COALESCE(MAX(invoice_number), 0) + 1 FROM invoices",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?,
    };
    let date = today_iso();
    conn.execute(
        "INSERT INTO invoices (customer_id, invoice_number, date, paid_amount) \
         VALUES (?1, ?2, ?3, 0)",
        params![customer_id, number, date],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    insert_items(&conn, id, &items)?;
    let view_items: Vec<ItemView> = items
        .into_iter()
        .map(|i| ItemView {
            name: i.name,
            unit_price: i.unit_price,
            qty: i.qty,
        })
        .collect();
    let total = items_total(&view_items);
    Ok(InvoiceView {
        id,
        customer_id,
        invoice_number: number,
        date,
        items: view_items,
        total,
        paid_amount: 0.0,
        status: status_of(total, 0.0),
    })
}

#[tauri::command]
pub fn update_invoice(
    state: State<'_, DbState>,
    id: i64,
    items: Vec<NewItem>,
) -> Result<(), String> {
    let conn = lock(&state)?;
    conn.execute("DELETE FROM invoice_items WHERE invoice_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    insert_items(&conn, id, &items)?;
    Ok(())
}

#[tauri::command]
pub fn delete_invoice(state: State<'_, DbState>, id: i64) -> Result<(), String> {
    let conn = lock(&state)?;
    conn.execute("DELETE FROM invoice_items WHERE invoice_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM invoices WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------- پرداخت و خلاصه حساب ----------

#[tauri::command(rename_all = "camelCase")]
pub fn record_payment(
    state: State<'_, DbState>,
    customer_id: i64,
    amount: f64,
    note: String,
) -> Result<Summary, String> {
    let conn = lock(&state)?;
    let date = today_iso();
    conn.execute(
        "INSERT INTO payments (customer_id, amount, date, note) VALUES (?1, ?2, ?3, ?4)",
        params![customer_id, amount, date, note],
    )
    .map_err(|e| e.to_string())?;

    // تخصیص مبلغ به قدیمی‌ترین فاکتورهای پرداخت‌نشده
    let mut stmt = conn
        .prepare(
            "SELECT i.id, COALESCE(SUM(it.unit_price * it.qty), 0), i.paid_amount \
             FROM invoices i LEFT JOIN invoice_items it ON it.invoice_id = i.id \
             WHERE i.customer_id = ?1 \
             GROUP BY i.id \
             HAVING COALESCE(SUM(it.unit_price * it.qty), 0) > i.paid_amount \
             ORDER BY i.date ASC, i.id ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![customer_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, f64>(1)?,
                r.get::<_, f64>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut remaining = amount;
    for row in rows {
        let (inv_id, total, paid) = row.map_err(|e| e.to_string())?;
        if remaining <= 0.0 {
            break;
        }
        let apply = (total - paid).min(remaining);
        conn.execute(
            "UPDATE invoices SET paid_amount = paid_amount + ?1 WHERE id = ?2",
            params![apply, inv_id],
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
    Ok(LoadedBackup {
        exported_at,
        currency: currency.to_string(),
        data: data.clone(),
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
pub fn apply_backup_import(state: State<'_, DbState>, path: String) -> Result<(), String> {
    let backup = load_backup_file(&path)?;
    let mult: f64 = if backup.currency == "toman" { 10.0 } else { 1.0 };
    let mut conn = lock(&state)?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("شروع تراکنش بازیابی ناموفق بود: {e}"))?;
    // اگر apply_import_tx خطا بدهد، tx بدون commit رها و همه‌چیز rollback می‌شود
    apply_import_tx(&tx, &backup, mult)?;
    tx.commit()
        .map_err(|e| format!("ثبت نهایی بازیابی ناموفق بود: {e}"))?;
    Ok(())
}
