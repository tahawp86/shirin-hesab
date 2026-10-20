#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// شیرین حساب — بک‌اند Tauri v2
// پیاده‌سازی دستورها در db.rs است؛ فرانت (src/lib/api.ts) همین نام‌ها را صدا می‌زند.
mod db;
mod updater;

use db::DbState;
use std::sync::Mutex;
use tauri::Manager;

fn main() {
    // مد موتور آپدیت: قبل از هر چیز (بدون پنجره/Tauri/دیتابیس)
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|a| a == "--apply-update").unwrap_or(false) {
        updater::run_apply_update(&args[2..]);
    }
    // پاک‌سازی فایل‌های .old باقی‌مانده از آپدیت قبلی
    updater::cleanup_old_files();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(updater::UpdateDlState::default())
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
            db::get_setting,
            db::set_setting,
            db::save_pdf_dialog,
            db::write_pdf_file,
            db::get_auto_update_check,
            db::set_auto_update_check,
            db::get_update_notified_version,
            db::set_update_notified_version,
            updater::check_update,
            updater::open_update_file_dialog,
            updater::apply_local_update,
            updater::download_and_apply_update,
            updater::cancel_update_download,
            updater::get_update_report,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
