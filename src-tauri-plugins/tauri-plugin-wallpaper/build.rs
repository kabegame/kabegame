const COMMANDS: &[&str] = &["setWallpaper"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
