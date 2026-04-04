const COMMANDS: &[&str] = &["shareFile", "copyImageToClipboard"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
