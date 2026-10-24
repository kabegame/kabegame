const COMMANDS: &[&str] = &["requestPermission", "updateNotifications"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
