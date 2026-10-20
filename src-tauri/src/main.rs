#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// شیرین حساب — بک‌اند Tauri v2
// پیاده‌سازی دستورها در db.rs است؛ فرانت (src/lib/api.ts) همین نام‌ها را صدا می‌زند.
mod db;

use db::DbState;
use std::sync::Mutex;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let db: DbState = Mutex::new(db::init_db(app.handle())?);
            app.manage(db);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::list_customers,
            db::add_customer,
            db::update_customer,
            db::delete_customer,
            db::list_products,
            db::add_product,
            db::update_product,
            db::delete_product,
            db::list_invoices,
            db::create_invoice,
            db::update_invoice,
            db::delete_invoice,
            db::record_payment,
            db::customer_summary,
            db::get_confectioner_info,
            db::set_confectioner_info,
            db::save_pdf_dialog,
            db::write_pdf_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
