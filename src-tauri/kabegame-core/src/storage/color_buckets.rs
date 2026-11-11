//! 色桶表 `color_buckets` 的写操作：把一个颜色保存成色桶、删除用户保存的色桶。
//!
//! 关系表 `image_color_distances` 的不变量是「每张图对每个色桶恒有一行」。保存色桶时色桶行与它对
//! 全库图片的距离在同一个事务里写；距离用宿主函数 `kb_palette_distance` 算（现算排序用的同一个函数，
//! 见 [`super::dsl_funcs`]），所以存表的距离与现算的距离逐行相同，没有色盘的图得到
//! `NO_PALETTE_DISTANCE`。
//! 入库一侧见 [`super::images::write_color_distances`]：它在自己的事务里现读色桶列表，两边靠
//! 写连接的同一把锁互斥，不会互相漏行。
//!
//! 读不走这里：前端观察 `color_buckets://`。只有这两个函数会改色桶表。

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;

use super::Storage;

/// 用户保存的色桶的上限。每个色桶在关系表里每张图占一行。
pub const MAX_CUSTOM_COLOR_BUCKETS: usize = 24;

/// rgb 超出 `0xffffff`。
pub const ERR_INVALID: &str = "color-bucket:invalid";
/// 这个颜色已经是色桶（基本色桶或用户保存的）。
pub const ERR_EXISTS: &str = "color-bucket:exists";
/// 用户保存的色桶已到上限。
pub const ERR_LIMIT: &str = "color-bucket:limit";
/// 基本色桶不能删。
pub const ERR_BUILTIN: &str = "color-bucket:builtin";
/// 没有这个色桶。
pub const ERR_NOT_FOUND: &str = "color-bucket:not-found";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorBucket {
    /// 0xRRGGBB，色桶主键。
    pub rgb: u32,
    /// 基本色桶的名称键；用户保存的为 None。
    pub key: Option<String>,
    /// 显示顺序。
    pub position: i64,
}

fn begin(conn: &Connection) -> Result<Transaction<'_>, String> {
    // 一开始就拿写锁：先读后写时不必再升级。出错提前返回时 Transaction 析构即回滚。
    Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
        .map_err(|e| format!("Failed to start color bucket transaction: {e}"))
}

/// 把一个颜色保存成色桶，并在同一个事务里写它对全部图片的距离。
///
/// 连接上必须已登记 `kb_palette_distance`（[`super::dsl_funcs::register_dsl_functions`]）。
/// 错误码（错误文本以它开头）：[`ERR_INVALID`]、[`ERR_EXISTS`]、[`ERR_LIMIT`]；失败时两张表都不变。
pub fn add_color_bucket_in(conn: &Connection, rgb: u32) -> Result<ColorBucket, String> {
    if rgb > 0x00ff_ffff {
        return Err(format!("{ERR_INVALID}: rgb {rgb:#x} 超出 0xffffff"));
    }
    let started = std::time::Instant::now();
    let tx = begin(conn)?;

    let exists: bool = tx
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM color_buckets WHERE rgb = ?1)",
            params![rgb],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to query color bucket: {e}"))?;
    if exists {
        return Err(format!("{ERR_EXISTS}: #{rgb:06x} 已经是色桶"));
    }
    let custom: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM color_buckets WHERE key IS NULL",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to count custom color buckets: {e}"))?;
    if custom >= MAX_CUSTOM_COLOR_BUCKETS as i64 {
        return Err(format!(
            "{ERR_LIMIT}: 最多保存 {MAX_CUSTOM_COLOR_BUCKETS} 个色桶"
        ));
    }

    let position: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM color_buckets",
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("Failed to query color bucket position: {e}"))?;
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0);
    tx.execute(
        "INSERT INTO color_buckets (rgb, key, position, created_at) VALUES (?1, NULL, ?2, ?3)",
        params![rgb, position, created_at],
    )
    .map_err(|e| format!("Failed to add color bucket: {e}"))?;

    // 全库距离一条语句补齐。按 id 升序：主键上逐张图追加，二级索引上是这个色桶自己的一片。
    let rows = tx
        .execute(
            "INSERT INTO image_color_distances (image_id, bucket_rgb, distance)
             SELECT id, ?1, kb_palette_distance(palette, ?2) FROM images ORDER BY id",
            params![rgb, format!("{rgb:06x}")],
        )
        .map_err(|e| format!("Failed to fill color bucket distances: {e}"))?;

    tx.commit()
        .map_err(|e| format!("Failed to commit color bucket: {e}"))?;
    tracing::info!(
        "保存色桶 #{rgb:06x}：{rows} 行距离，{} ms",
        started.elapsed().as_millis()
    );
    Ok(ColorBucket {
        rgb,
        key: None,
        position,
    })
}

/// 删一个用户保存的色桶及其关系行。基本色桶返回 [`ERR_BUILTIN`]，不存在返回 [`ERR_NOT_FOUND`]。
pub fn delete_color_bucket_in(conn: &Connection, rgb: u32) -> Result<(), String> {
    let tx = begin(conn)?;
    let key: Option<Option<String>> = tx
        .query_row(
            "SELECT key FROM color_buckets WHERE rgb = ?1",
            params![rgb],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("Failed to query color bucket: {e}"))?;
    match key {
        None => return Err(format!("{ERR_NOT_FOUND}: 没有色桶 #{rgb:06x}")),
        Some(Some(key)) => return Err(format!("{ERR_BUILTIN}: 基本色桶 {key} 不能删除")),
        Some(None) => {}
    }
    // 关系行显式删除（走 idx_image_color_distances_bucket 取这个色桶的一片），外键级联只是兜底
    let rows = tx
        .execute(
            "DELETE FROM image_color_distances WHERE bucket_rgb = ?1",
            params![rgb],
        )
        .map_err(|e| format!("Failed to delete color bucket distances: {e}"))?;
    tx.execute(
        "DELETE FROM color_buckets WHERE rgb = ?1 AND key IS NULL",
        params![rgb],
    )
    .map_err(|e| format!("Failed to delete color bucket: {e}"))?;
    tx.commit()
        .map_err(|e| format!("Failed to commit color bucket deletion: {e}"))?;
    tracing::info!("删除色桶 #{rgb:06x}：{rows} 行距离");
    Ok(())
}

impl Storage {
    /// 把一个颜色保存成色桶，见 [`add_color_bucket_in`]。事务期间持有写连接的锁，入库等写操作排队等它结束。
    pub fn add_color_bucket(&self, rgb: u32) -> Result<ColorBucket, String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        add_color_bucket_in(&conn, rgb)
    }

    /// 删一个用户保存的色桶及其关系行，见 [`delete_color_bucket_in`]。
    pub fn delete_color_bucket(&self, rgb: u32) -> Result<(), String> {
        let conn = self.db.lock().map_err(|e| format!("Lock error: {e}"))?;
        delete_color_bucket_in(&conn, rgb)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::palette::{distance_to, Palette, PaletteColor, NO_PALETTE_DISTANCE};
    use crate::storage::migrations::BUILTIN_COLOR_BUCKETS;
    use crate::storage::ImageInfo;

    /// 完整 schema 的内存库（含 12 个基本色桶），写连接上登记了宿主函数。
    fn storage(foreign_keys: bool) -> Storage {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", foreign_keys)
            .unwrap();
        crate::storage::migrations::init::create_all_tables(&conn);
        crate::storage::dsl_funcs::register_dsl_functions(&conn).unwrap();
        Storage::from_test_connection(conn)
    }

    fn image(local_path: &str, palette: Option<&Palette>) -> ImageInfo {
        ImageInfo {
            id: String::new(),
            url: None,
            local_path: local_path.to_string(),
            plugin_id: Some("test".to_string()),
            task_id: None,
            surf_record_id: None,
            crawled_at: 1,
            metadata_id: None,
            image_metadata_id: None,
            thumbnail_path: String::new(),
            favorite: false,
            is_hidden: false,
            local_exists: true,
            hash: String::new(),
            width: None,
            height: None,
            display_name: "row".to_string(),
            media_type: Some("image/png".to_string()),
            last_set_wallpaper_at: None,
            size: None,
            album_order: None,
            compatible_path: None,
            post_url: None,
            palette: palette.map(Palette::to_json),
        }
    }

    fn mixed() -> Palette {
        Palette(vec![
            PaletteColor {
                rgb: 0x3a7bd5,
                percent: 60,
            },
            PaletteColor {
                rgb: 0xf0e0d0,
                percent: 40,
            },
        ])
    }

    /// 三张有色盘的图加一张没有的；返回 `(id, 色盘)`。
    fn seed_images(storage: &Storage) -> Vec<(i64, Option<Palette>)> {
        [
            Some(Palette::single([255, 0, 0])),
            Some(mixed()),
            None,
            Some(Palette::single([0x32, 0xfe, 0x98])),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, palette)| {
            let row = storage
                .add_image(image(&format!("/lib/{index}.png"), palette.as_ref()))
                .unwrap();
            (row.id.parse().unwrap(), palette)
        })
        .collect()
    }

    /// 两张表的全部内容，用来断言「失败时不变」。
    fn snapshot(storage: &Storage) -> (Vec<(i64, Option<String>, i64)>, Vec<(i64, i64, i64)>) {
        let conn = storage.db.lock().unwrap();
        let buckets = conn
            .prepare("SELECT rgb, key, position FROM color_buckets ORDER BY rgb")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let distances = conn
            .prepare(
                "SELECT image_id, bucket_rgb, distance FROM image_color_distances
                  ORDER BY image_id, bucket_rgb",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        (buckets, distances)
    }

    /// 某个色桶的关系行 `(image_id, distance)`，按图片 id。
    fn bucket_rows(storage: &Storage, rgb: u32) -> Vec<(i64, i64)> {
        let conn = storage.db.lock().unwrap();
        let rows = conn
            .prepare(
                "SELECT image_id, distance FROM image_color_distances
                  WHERE bucket_rgb = ?1 ORDER BY image_id",
            )
            .unwrap()
            .query_map([rgb], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        rows
    }

    fn code(error: &str) -> &str {
        error.split(": ").next().unwrap()
    }

    #[test]
    fn add_writes_the_bucket_and_one_distance_per_image() {
        const RGB: u32 = 0x3a7bd5;
        let storage = storage(true);
        let images = seed_images(&storage);
        let before = snapshot(&storage);
        assert_eq!(before.1.len(), images.len() * 12);

        let bucket = storage.add_color_bucket(RGB).unwrap();
        // 排在 12 个基本色桶之后，没有名称键
        assert_eq!(
            bucket,
            ColorBucket {
                rgb: RGB,
                key: None,
                position: 12
            }
        );
        // 命令的返回值：camelCase 三个字段
        assert_eq!(
            serde_json::to_value(&bucket).unwrap(),
            serde_json::json!({ "rgb": RGB, "key": null, "position": 12 })
        );

        let after = snapshot(&storage);
        assert_eq!(after.0.len(), 13);
        assert!(after.0.contains(&(i64::from(RGB), None, 12)));
        // 每张图恰好多一行，原有的行不变
        assert_eq!(after.1.len(), before.1.len() + images.len());
        let untouched: Vec<_> = after
            .1
            .iter()
            .copied()
            .filter(|(_, bucket_rgb, _)| *bucket_rgb != i64::from(RGB))
            .collect();
        assert_eq!(untouched, before.1);

        // 有色盘的图距离等于 distance_to，没有色盘的是 NO_PALETTE_DISTANCE
        let expected: Vec<(i64, i64)> = images
            .iter()
            .map(|(id, palette)| (*id, i64::from(distance_to(palette.as_ref(), RGB))))
            .collect();
        assert_eq!(bucket_rows(&storage, RGB), expected);
        assert_eq!(expected[2].1, i64::from(NO_PALETTE_DISTANCE));
        assert_eq!(expected[1].1, i64::from(distance_to(Some(&mixed()), RGB)));
        assert!(expected[1].1 < i64::from(NO_PALETTE_DISTANCE));

        // 再存一个：显示顺序接着往后排
        assert_eq!(storage.add_color_bucket(0x000001).unwrap().position, 13);
    }

    #[test]
    fn add_on_an_empty_library_only_writes_the_bucket() {
        let storage = storage(true);
        let bucket = storage.add_color_bucket(0x123456).unwrap();
        assert_eq!(bucket.position, 12);
        let (buckets, distances) = snapshot(&storage);
        assert_eq!(buckets.len(), 13);
        assert!(distances.is_empty());
    }

    #[test]
    fn add_rejects_invalid_duplicate_and_over_limit_without_changes() {
        let storage = storage(true);
        seed_images(&storage);

        // 超出 24 位
        let before = snapshot(&storage);
        let error = storage.add_color_bucket(0x0100_0000).unwrap_err();
        assert_eq!(code(&error), ERR_INVALID, "{error}");
        assert_eq!(snapshot(&storage), before);

        // 已经是基本色桶
        let (_, red) = BUILTIN_COLOR_BUCKETS[0];
        let error = storage.add_color_bucket(red).unwrap_err();
        assert_eq!(code(&error), ERR_EXISTS, "{error}");
        assert_eq!(snapshot(&storage), before);

        // 已经是用户色桶
        storage.add_color_bucket(0x000100).unwrap();
        let before = snapshot(&storage);
        let error = storage.add_color_bucket(0x000100).unwrap_err();
        assert_eq!(code(&error), ERR_EXISTS, "{error}");
        assert_eq!(snapshot(&storage), before);

        // 存到上限：基本色桶不占名额
        for index in 1..MAX_CUSTOM_COLOR_BUCKETS as u32 {
            storage.add_color_bucket(0x000100 + index).unwrap();
        }
        let before = snapshot(&storage);
        assert_eq!(before.0.len(), 12 + MAX_CUSTOM_COLOR_BUCKETS);
        let error = storage.add_color_bucket(0x00ff01).unwrap_err();
        assert_eq!(code(&error), ERR_LIMIT, "{error}");
        assert_eq!(snapshot(&storage), before);

        // 删掉一个之后又能存
        storage.delete_color_bucket(0x000100).unwrap();
        storage.add_color_bucket(0x00ff01).unwrap();
    }

    /// 色桶行已经插入、补距离时失败：整个事务回滚，色桶行不留下。
    #[test]
    fn add_rolls_back_the_bucket_row_when_filling_distances_fails() {
        let conn = Connection::open_in_memory().unwrap();
        crate::storage::migrations::init::create_all_tables(&conn);
        // 故意不登记宿主函数：INSERT … SELECT kb_palette_distance(…) 在色桶行之后失败
        conn.execute(
            "INSERT INTO images (local_path, crawled_at, type) VALUES ('/lib/a.png', 1, 'image/png')",
            [],
        )
        .unwrap();
        let storage = Storage::from_test_connection(conn);
        let before = snapshot(&storage);

        let error = storage.add_color_bucket(0x123456).unwrap_err();
        assert!(!error.starts_with("color-bucket:"), "{error}");
        assert_eq!(snapshot(&storage), before);
        // 连接没有停在事务里
        assert!(storage.db.lock().unwrap().is_autocommit());
    }

    #[test]
    fn delete_removes_a_user_bucket_and_its_distance_rows() {
        const RGB: u32 = 0x32fe98;
        // 关掉外键：关系行靠显式删除清掉，不是靠级联
        let storage = storage(false);
        let images = seed_images(&storage);
        let before = snapshot(&storage);

        storage.add_color_bucket(RGB).unwrap();
        assert_eq!(bucket_rows(&storage, RGB).len(), images.len());

        storage.delete_color_bucket(RGB).unwrap();
        assert_eq!(snapshot(&storage), before);

        // 已经不在了
        let error = storage.delete_color_bucket(RGB).unwrap_err();
        assert_eq!(code(&error), ERR_NOT_FOUND, "{error}");
        assert_eq!(snapshot(&storage), before);
    }

    #[test]
    fn delete_rejects_builtin_and_unknown_buckets_without_changes() {
        let storage = storage(true);
        seed_images(&storage);
        storage.add_color_bucket(0x112233).unwrap();
        let before = snapshot(&storage);

        for (key, rgb) in BUILTIN_COLOR_BUCKETS {
            let error = storage.delete_color_bucket(rgb).unwrap_err();
            assert_eq!(code(&error), ERR_BUILTIN, "{key}: {error}");
        }
        for rgb in [0x445566, 0x0100_0000, u32::MAX] {
            let error = storage.delete_color_bucket(rgb).unwrap_err();
            assert_eq!(code(&error), ERR_NOT_FOUND, "{rgb:#x}: {error}");
        }
        assert_eq!(snapshot(&storage), before);
    }

    /// 保存色桶之后入库的新图对新色桶也有一行（`add_image` 现读色桶列表），
    /// 而且与保存时补算的是同一个值：两张色盘相同的图，一张在保存前入库、一张在保存后。
    #[test]
    fn images_added_after_saving_a_bucket_get_a_row_for_it() {
        const RGB: u32 = 0x3a7bd5;
        let storage = storage(true);
        let palette = mixed();
        let earlier: i64 = storage
            .add_image(image("/lib/earlier.png", Some(&palette)))
            .unwrap()
            .id
            .parse()
            .unwrap();

        storage.add_color_bucket(RGB).unwrap();

        let later: i64 = storage
            .add_image(image("/lib/later.png", Some(&palette)))
            .unwrap()
            .id
            .parse()
            .unwrap();
        let bare: i64 = storage
            .add_image(image("/lib/bare.png", None))
            .unwrap()
            .id
            .parse()
            .unwrap();

        let distance = i64::from(distance_to(Some(&palette), RGB));
        assert_eq!(
            bucket_rows(&storage, RGB),
            [
                (earlier, distance),
                (later, distance),
                (bare, i64::from(NO_PALETTE_DISTANCE))
            ]
        );
        // 不变量：图片数 × 色桶数
        let (buckets, distances) = snapshot(&storage);
        assert_eq!(distances.len(), 3 * buckets.len());

        // 删掉色桶后再入库：不再为它写行
        storage.delete_color_bucket(RGB).unwrap();
        storage
            .add_image(image("/lib/after-delete.png", Some(&palette)))
            .unwrap();
        assert!(bucket_rows(&storage, RGB).is_empty());
        let (buckets, distances) = snapshot(&storage);
        assert_eq!(buckets.len(), 12);
        assert_eq!(distances.len(), 4 * 12);
    }
}
