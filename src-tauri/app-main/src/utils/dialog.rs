use kabegame_i18n::t;
use tauri_plugin_dialog::DialogExt;

pub fn show_error(app: &tauri::AppHandle, msg: String) {
    app.dialog()
        .message(msg)
        .title(t!("dialog.errorTitle"))
        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
        .blocking_show();
}
