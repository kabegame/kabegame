const COMMANDS: &[&str] = &[
    "getAppDataDir",
    "getCachePaths",
    "getExternalDataDir",
    "seedBundledPlugins",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
