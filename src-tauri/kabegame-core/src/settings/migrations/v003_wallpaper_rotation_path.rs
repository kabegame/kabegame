//! 轮播来源从「画册 id + 是否含子画册 + 随机/顺序」三个设置收敛为一个 PathQL 路径
//! `wallpaperRotationPath` 与位置 `wallpaperRotationPosition`。
//!
//! 映射：
//! - 画册（含子画册）→ `images://gallery/hide/album-tree/<id>`，否则 `…/album/<id>`；
//! - 画廊 → `images://gallery/hide/all`；
//! - 随机追加 `/sort/random-<seed>`；画册顺序追加 `/sort/by-album-order`（旧顺序模式按画册内顺序），
//!   子画册树与画廊顺序沿用默认的收录时间升序。
//!
//! 启用状态、间隔、样式、过渡与 `currentWallpaperImageId` 原样保留；位置从 0 开始。

use crate::wallpaper_rotation::new_random_seed;
use serde_json::Value;

const OLD_KEYS: [&str; 3] = [
    "wallpaperRotationAlbumId",
    "wallpaperRotationIncludeSubalbums",
    "wallpaperRotationMode",
];

pub fn up(json: &mut Value) -> Result<(), String> {
    let Value::Object(map) = json else {
        return Ok(());
    };

    let has_path = map
        .get("wallpaperRotationPath")
        .is_some_and(|v| v.as_str().is_some_and(|s| !s.trim().is_empty()));
    if !has_path {
        let album_id = map
            .get("wallpaperRotationAlbumId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let include_subalbums = map
            .get("wallpaperRotationIncludeSubalbums")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let random = map.get("wallpaperRotationMode").and_then(Value::as_str) != Some("sequential");

        let path = match (album_id, random) {
            (Some(id), random) => {
                let base = if include_subalbums {
                    format!("images://gallery/hide/album-tree/{id}")
                } else {
                    format!("images://gallery/hide/album/{id}")
                };
                if random {
                    format!("{base}/sort/random-{}", new_random_seed())
                } else if include_subalbums {
                    base
                } else {
                    format!("{base}/sort/by-album-order")
                }
            }
            (None, true) => format!("images://gallery/hide/sort/random-{}", new_random_seed()),
            (None, false) => "images://gallery/hide/all".to_string(),
        };
        map.insert("wallpaperRotationPath".into(), Value::from(path));
        map.insert("wallpaperRotationPosition".into(), Value::from(0));
    }
    map.entry("wallpaperRotationPosition")
        .or_insert(Value::from(0));

    for key in OLD_KEYS {
        map.remove(key);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    const ID: &str = "11111111-1111-1111-1111-111111111111";

    fn migrate(v: Value) -> Value {
        let mut v = v;
        super::up(&mut v).unwrap();
        v
    }

    fn path(v: &Value) -> &str {
        v["wallpaperRotationPath"].as_str().unwrap()
    }

    #[test]
    fn album_with_subalbums_random() {
        let v = migrate(json!({
            "wallpaperRotationAlbumId": ID,
            "wallpaperRotationIncludeSubalbums": true,
            "wallpaperRotationMode": "random",
            "wallpaperRotationEnabled": true
        }));
        assert!(path(&v).starts_with(&format!(
            "images://gallery/hide/album-tree/{ID}/sort/random-"
        )));
        assert_eq!(v["wallpaperRotationEnabled"], true);
        assert_eq!(v["wallpaperRotationPosition"], 0);
        assert!(v.get("wallpaperRotationAlbumId").is_none());
        assert!(v.get("wallpaperRotationIncludeSubalbums").is_none());
        assert!(v.get("wallpaperRotationMode").is_none());
    }

    #[test]
    fn album_with_subalbums_sequential() {
        let v = migrate(json!({
            "wallpaperRotationAlbumId": ID,
            "wallpaperRotationMode": "sequential"
        }));
        assert_eq!(path(&v), format!("images://gallery/hide/album-tree/{ID}"));
    }

    #[test]
    fn album_only_random() {
        let v = migrate(json!({
            "wallpaperRotationAlbumId": ID,
            "wallpaperRotationIncludeSubalbums": false
        }));
        assert!(path(&v).starts_with(&format!("images://gallery/hide/album/{ID}/sort/random-")));
    }

    #[test]
    fn album_only_sequential_keeps_album_order() {
        let v = migrate(json!({
            "wallpaperRotationAlbumId": ID,
            "wallpaperRotationIncludeSubalbums": false,
            "wallpaperRotationMode": "sequential"
        }));
        assert_eq!(
            path(&v),
            format!("images://gallery/hide/album/{ID}/sort/by-album-order")
        );
    }

    #[test]
    fn gallery_random_and_sequential() {
        let random = migrate(json!({ "wallpaperRotationAlbumId": "" }));
        assert!(path(&random).starts_with("images://gallery/hide/sort/random-"));
        let seq = migrate(
            json!({ "wallpaperRotationAlbumId": null, "wallpaperRotationMode": "sequential" }),
        );
        assert_eq!(path(&seq), "images://gallery/hide/all");
    }

    #[test]
    fn idempotent_and_keeps_existing_path() {
        let v = migrate(json!({
            "wallpaperRotationPath": "images://gallery/hide/plugin/pixiv",
            "wallpaperRotationPosition": 7,
            "wallpaperRotationAlbumId": ID
        }));
        assert_eq!(path(&v), "images://gallery/hide/plugin/pixiv");
        assert_eq!(v["wallpaperRotationPosition"], 7);
        let again = migrate(v.clone());
        assert_eq!(again, v);
    }
}
