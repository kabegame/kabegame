const COMMANDS: &[&str] = &["pickFolder", "pickImages", "pickVideos", "pickKgpgFile", "extractBundledPlugins", "openImage", "openVideo"];

fn main() {
  tauri_plugin::Builder::new(COMMANDS)
    .android_path("android")
    .build();
}
