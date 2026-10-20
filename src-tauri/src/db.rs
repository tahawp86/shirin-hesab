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
";

/// اتصال به SQLite — فایل دیتابیس در app_data کنار exe
pub fn init_db(app: &AppHandle) -> Result<Connection, Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&dir)?;
    let conn = Connection::open(dir.join("shirin-hesab.db"))?;
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
    Ok(conn)
}

// ---------- کمک‌تابع‌ها ----------

/// نام آیتم «مانده حساب قبلی» — در فرمول بدهکاری از جمع فاکتورها کم می‌شود
/// تا دوباره شمرده نشود (تطبیق با نام دقیق).
pub const BALANCE_ITEM_NAME: &str = "مانده حساب قبلی";

fn load_items(conn: &Connection, invoice_id: i64) -> Result<Vec<ItemView>, String> {
    let mut stmt = conn
        .prepare("SELECT name, unit_price, qty FROM invoice_items WHERE invoice_id = ?1 ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![invoice_id], |r| {
            Ok(ItemView {
                name: r.get(0)?,
                unit_price: r.get(1)?,
                qty: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
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
    let mut out = Vec::new();
    for inv in inv_rows {
        let (id, cid, invoice_number, date, paid_amount) = inv.map_err(|e| e.to_string())?;
        let items = load_items(&conn, id)?;
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

// ---------- تنظیمات آپدیت خودکار ----------

/// چک خودکار آپدیت در استارت — پیش‌فرض روشن
#[tauri::command]
pub fn get_auto_update_check(state: State<'_, DbState>) -> Result<bool, String> {
    let conn = lock(&state)?;
    let v = read_setting(&conn, "auto_update_check")?;
    Ok(v != "false" && v != "0")
}

#[tauri::command]
pub fn set_auto_update_check(state: State<'_, DbState>, enabled: bool) -> Result<(), String> {
    let conn = lock(&state)?;
    write_setting(&conn, "auto_update_check", if enabled { "true" } else { "false" })
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
