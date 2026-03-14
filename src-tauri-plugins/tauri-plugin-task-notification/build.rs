const COMMANDS: &[&str] = &["updateTaskNotification", "clearTaskNotification"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
