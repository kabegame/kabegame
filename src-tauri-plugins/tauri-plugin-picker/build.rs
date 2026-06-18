const COMMANDS: &[&str] = &[
    "getHttpServerBase",
    "pickFolder",
    "pickImages",
    "pickVideos",
    "pickKgpgFile",
    "openImage",
    "openVideo",
    "getImageThumbnail",
    "computeHash",
    "getMimeType",
    "getDisplayName",
    "getContentSize",
    "getImageDimensions",
    "getVideoDimensions",
    "isDirectory",
    "listContentChildren",
    "readFileBytes",
    "takePersistablePermission",
    "copyImageToPictures",
    "copyExtractedImagesToPictures",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
