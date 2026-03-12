const COMMANDS: &[&str] = &["compressVideoForPreview"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
