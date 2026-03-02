const COMMANDS: &[&str] = &["pickFolder", "pickImages", "pickKgpgFile", "extractBundledPlugins", "openImage"];

fn main() {
  tauri_plugin::Builder::new(COMMANDS)
    .android_path("android")
    .build();
}
