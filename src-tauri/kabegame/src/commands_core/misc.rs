use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportedImageTypes {
    extensions: Vec<String>,
    mime_by_ext: std::collections::HashMap<String, String>,
}

pub fn get_build_mode() -> Result<Value, String> {
    let mode = if cfg!(feature = "web") {
        "web"
    } else if cfg!(feature = "android") {
        "android"
    } else if cfg!(feature = "standard") {
        "standard"
    } else if cfg!(feature = "light") {
        "light"
    } else {
        "unknown"
    };
    Ok(Value::String(mode.to_string()))
}

pub fn get_supported_image_types() -> Result<Value, String> {
    let payload = SupportedImageTypes {
        extensions: kabegame_core::image_type::supported_media_extensions(),
        mime_by_ext: kabegame_core::image_type::mime_by_ext(),
    };
    serde_json::to_value(payload).map_err(|e| e.to_string())
}
