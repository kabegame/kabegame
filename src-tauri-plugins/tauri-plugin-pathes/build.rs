const COMMANDS: &[&str] = &["getAppDataDir", "getCachePaths", "getExternalDataDir", "getArchiveExtractDir"];

fn main() {
  tauri_plugin::Builder::new(COMMANDS)
    .android_path("android")
    .build();
}
