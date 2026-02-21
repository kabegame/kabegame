const COMMANDS: &[&str] = &["pickFolder", "pickImages", "pickKgpgFile", "extractBundledPlugins"];

fn main() {
  tauri_plugin::Builder::new(COMMANDS)
    .android_path("android")
    .build();
}
