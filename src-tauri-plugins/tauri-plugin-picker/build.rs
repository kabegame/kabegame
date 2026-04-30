const COMMANDS: &[&str] = &[
    "pickFolder",
    "pickImages",
    "pickVideos",
    "pickKgpgFile",
    "openImage",
    "openVideo",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
