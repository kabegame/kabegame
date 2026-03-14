const COMMANDS: &[&str] = &["compressVideoForPreview", "extractVideoFrames"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
