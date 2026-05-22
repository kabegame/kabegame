const COMMANDS: &[&str] = &["getAppDataDir", "getCachePaths", "getExternalDataDir"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
