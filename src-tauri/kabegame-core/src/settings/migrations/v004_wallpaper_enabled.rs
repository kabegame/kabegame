//! 「关闭壁纸」`wallpaperDisabled`（默认 false）换成「打开壁纸」`wallpaperEnabled`（默认 true）：取反后删掉旧键。
//!
//! 旧键在就以旧键为准：降级到旧版本时旧版本只认 `wallpaperDisabled`，保存时又把 `schemaVersion` 写回 3，再升级会重跑本迁移，
//! 这时旧键是用户最后一次的选择。不是布尔的旧值按旧版的解析（`as_bool().unwrap_or(false)`）当作没关。
//! 旧键不在时不写新键，读取时按默认值开启。

use serde_json::Value;

pub fn up(json: &mut Value) -> Result<(), String> {
    let Value::Object(map) = json else {
        return Ok(());
    };
    if let Some(disabled) = map.remove("wallpaperDisabled") {
        let enabled = !disabled.as_bool().unwrap_or(false);
        map.insert("wallpaperEnabled".into(), Value::Bool(enabled));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn inverts_old_key_and_drops_it() {
        let mut v = json!({ "wallpaperDisabled": true, "x": 1 });
        super::up(&mut v).unwrap();
        assert_eq!(v, json!({ "wallpaperEnabled": false, "x": 1 }));

        let mut v = json!({ "wallpaperDisabled": false });
        super::up(&mut v).unwrap();
        assert_eq!(v, json!({ "wallpaperEnabled": true }));
    }

    #[test]
    fn non_bool_old_value_means_enabled() {
        let mut v = json!({ "wallpaperDisabled": "yes" });
        super::up(&mut v).unwrap();
        assert_eq!(v, json!({ "wallpaperEnabled": true }));
    }

    #[test]
    fn missing_old_key_writes_nothing() {
        let mut v = json!({ "x": 1 });
        super::up(&mut v).unwrap();
        assert_eq!(v, json!({ "x": 1 }));
    }

    #[test]
    fn old_key_wins_over_new_key() {
        let mut v = json!({ "wallpaperDisabled": true, "wallpaperEnabled": true });
        super::up(&mut v).unwrap();
        assert_eq!(v, json!({ "wallpaperEnabled": false }));
    }

    #[test]
    fn idempotent() {
        let mut v = json!({ "wallpaperDisabled": true });
        super::up(&mut v).unwrap();
        let once = v.clone();
        super::up(&mut v).unwrap();
        assert_eq!(v, once);
    }
}
