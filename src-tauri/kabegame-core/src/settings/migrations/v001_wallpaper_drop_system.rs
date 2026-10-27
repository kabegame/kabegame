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

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn replaces_system_style_and_is_idempotent() {
        let mut v = json!({
            "wallpaperStyle": "system",
            "wallpaperStyleByMode": { "native": "system", "window": "fit" }
        });
        super::up(&mut v).unwrap();
        let once = v.clone();
        super::up(&mut v).unwrap();
        assert_eq!(v, once);
        assert_eq!(v["wallpaperStyle"], "fill");
        assert_eq!(v["wallpaperStyleByMode"]["native"], "fill");
        assert_eq!(v["wallpaperStyleByMode"]["window"], "fit");
    }
}
