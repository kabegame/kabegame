use tauri_plugin_dialog::DialogExt;

pub fn show_error(app: &tauri::AppHandle, msg: String) {
    app.dialog()
        .message(msg)
        .title("出错啦 😿")
        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
        .blocking_show();
}