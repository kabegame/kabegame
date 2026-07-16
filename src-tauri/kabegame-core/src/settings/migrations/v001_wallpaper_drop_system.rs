use serde_json::Value;

pub fn up(json: &mut Value) -> Result<(), String> {
    let Value::Object(map) = json else {
        return Ok(());
    };

    if map.get("wallpaperStyle").and_then(|v| v.as_str()) == Some("system") {
        map.insert("wallpaperStyle".into(), Value::from("fill"));
    }

    for key in ["wallpaperStyleByMode", "wallpaper_style_by_mode"] {
        if let Some(Value::Object(by_mode)) = map.get_mut(key) {
            for (_mode, value) in by_mode.iter_mut() {
                if value.as_str() == Some("system") {
                    *value = Value::from("fill");
                }
            }
        }
    }

    Ok(())
}
