//! 主机 SQL 函数 (sqlite scalar functions): 把业务侧元数据 (PluginManager / albums / tasks
//! 等) 暴露给 DSL 的 SQL 上下文。注册由 [`super::Storage::new`] 在打开 connection +
//! schema migration 完成后调用。
//!
//! 当前提供:
//! - [`get_plugin`](plugin_id [, locale]) → JSON_TEXT
//!   返回 `{"id","name","description","baseUrl"}`; plugin 不存在 → `"null"`。
//!   name / description 按 locale 解析 (locale 缺省走 [`kabegame_i18n::current_vd_locale`])。
//! - `vd_display_name(canonical)` → 当前 VD locale 下的路径显示名。
//! - `crawled_at_seconds(timestamp)` → 规整秒/毫秒时间戳。
//! - `name_language_bucket(name)` / `name_language_rank(bucket)` → 名称语言分桶与排序。
//! - `kb_rand(seed, id)` → 基于 SplitMix64 finalizer 的确定性随机排序值。
//! - `is_search_dummy_url(url)` → url 搜索维度的占位/本地 url 判定。
//! - `kb_palette_distance(palette, hex)` → 色盘到参考色的距离（`media::palette::distance_to` 的 SQL 外壳）。
//!
//! 约束: host SQL function 不得访问当前 Storage/SQLite 连接。数据库中可查的数据应直接写
//! SQL；否则会在 `KabegameSqlExecutor` 持有连接 mutex 期间重入同一把锁。

use rusqlite::functions::FunctionFlags;
use rusqlite::types::ValueRef;
use rusqlite::Connection;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use crate::media::palette::{distance_to_lab, srgb_to_oklab, Oklab, Palette};
use crate::plugin::{manifest_value_display_for_locale, PluginManager};

static GET_PLUGIN_PROFILE_CALLS: AtomicU64 = AtomicU64::new(0);
static GET_PLUGIN_PROFILE_MICROS: AtomicU64 = AtomicU64::new(0);

fn get_plugin_profile_enabled() -> bool {
    let Ok(filter) = std::env::var("PATHQL_PROFILE") else {
        return false;
    };
    let filter = filter.trim();
    if filter.is_empty() || matches!(filter, "0" | "false" | "off") {
        return false;
    }
    matches!(filter, "1" | "true" | "all")
        || filter.contains("plugin")
        || filter.contains("get_plugin")
}

fn profile_get_plugin_call(plugin_id: &str, locale: Option<&str>, started: Instant, result: &str) {
    if !get_plugin_profile_enabled() {
        return;
    }

    let last_us = started.elapsed().as_micros() as u64;
    let calls = GET_PLUGIN_PROFILE_CALLS.fetch_add(1, Ordering::Relaxed) + 1;
    let total_us = GET_PLUGIN_PROFILE_MICROS.fetch_add(last_us, Ordering::Relaxed) + last_us;
    if calls <= 20 || calls % 100 == 0 {
        tracing::debug!(
            "host_fn=get_plugin calls={calls} last_us={last_us} total_ms={} plugin_id={plugin_id:?} locale={locale:?} result_null={}",
            total_us / 1000,
            result == "null",
        );
    }
}

/// 在给定 connection 上注册所有 DSL 主机 SQL 函数。
/// connection-scoped — 写连接和读池中的每条连接都要独立注册。
pub(crate) fn register_dsl_functions(conn: &Connection) -> Result<(), rusqlite::Error> {
    register_kb_rand(conn)?;
    register_get_plugin(conn)?;
    register_crawled_at_seconds(conn)?;
    register_vd_display_name(conn)?;
    register_name_language_functions(conn)?;
    register_is_search_dummy_url(conn)?;
    register_kb_palette_distance(conn)?;
    Ok(())
}

/// 六位十六进制（大小写均可，可带 `0x` 前缀）→ `0xRRGGBB`。其它写法（位数不对、带符号、非十六进制）为 `None`。
fn parse_color_hex(hex: &str) -> Option<u32> {
    let hex = hex.strip_prefix("0x").unwrap_or(hex);
    if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    u32::from_str_radix(hex, 16).ok()
}

/// `kb_palette_distance` 的第二个参数 → 参考色（OKLab）。
fn palette_reference_color(value: ValueRef<'_>) -> Result<Oklab, String> {
    let ValueRef::Text(bytes) = value else {
        return Err("kb_palette_distance: argument 2 must be a 6-digit hex color".to_string());
    };
    std::str::from_utf8(bytes)
        .ok()
        .and_then(parse_color_hex)
        .map(srgb_to_oklab)
        .ok_or_else(|| {
            format!(
                "kb_palette_distance: argument 2 must be a 6-digit hex color, got {:?}",
                String::from_utf8_lossy(bytes)
            )
        })
}

/// `kb_palette_distance(palette, hex)` → INTEGER
///
/// palette：`images.palette` 的 JSON 文本；hex：六位十六进制文本，可带 `0x` 前缀（`ff0000` / `0xff0000`）。
/// DSL 里传的是带前缀的写法：不带前缀的纯数字颜色在属性求值时会被转成整数、丢前导零。
/// 返回 [`distance_to_lab`] 的结果；palette 为 NULL 或解析不了时与它对 `None` 的返回值相同
/// （[`crate::media::palette::NO_PALETTE_DISTANCE`]，比任何有色盘的距离都大）。
/// hex 不合法时报错（路由的正则已保证合法，报错只会出现在手写 SQL 里）。
///
/// 只做纯计算、不访问数据库连接。入库与回填写进关系表的距离是同一段代码（`distance_to`），
/// 所以按它现算排序与按关系表排序同序。单独公开是给 DSL e2e 的测试连接用。
pub fn register_kb_palette_distance(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.create_scalar_function(
        "kb_palette_distance",
        2,
        FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_INNOCUOUS,
        |ctx| -> rusqlite::Result<i64> {
            // 第二个参数整条查询里不变（字面量或绑定参数）：用 auxdata 缓存换算好的参考色，不逐行重算。
            // 先取它，hex 不合法时即使 palette 是 NULL 也报错。
            let reference = ctx.get_or_create_aux(1, palette_reference_color)?;
            // 必须用 get_raw：ctx.get::<String>(0) 遇 NULL 会直接报错。
            let palette = match ctx.get_raw(0) {
                ValueRef::Text(bytes) => {
                    std::str::from_utf8(bytes).ok().and_then(Palette::from_json)
                }
                _ => None,
            };
            Ok(i64::from(distance_to_lab(palette.as_ref(), *reference)))
        },
    )
}

/// `is_search_dummy_url(url)` — url 搜索维度的占位/本地 url 判定。
/// 1 = dummy（应排除），0 = 真实来源 url。**NULL 也判 1**，让 DSL 侧一句
/// `is_search_dummy_url(x) = 0` 同时吃掉 NULL 与占位值，不必再写 IS NOT NULL。
fn register_is_search_dummy_url(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.create_scalar_function(
        "is_search_dummy_url",
        1,
        FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_INNOCUOUS,
        |ctx| -> rusqlite::Result<i64> {
            // 必须用 get_raw：ctx.get::<String>(0) 遇 NULL 会直接报错。
            let ValueRef::Text(bytes) = ctx.get_raw(0) else {
                return Ok(1);
            };
            let url = String::from_utf8_lossy(bytes);
            Ok(crate::crawler::downloader::is_search_dummy_url(url.trim()) as i64)
        },
    )
}

/// 返回固定 seed 与 id 对应的确定性随机排序值。
pub fn kb_rand_value(seed: i64, id: i64) -> i64 {
    let mut z = (seed as u64) ^ (id as u64);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    (z ^ (z >> 31)) as i64
}

fn kb_rand_arg(ctx: &rusqlite::functions::Context<'_>, idx: usize) -> rusqlite::Result<i64> {
    match ctx.get_raw(idx) {
        ValueRef::Integer(value) => Ok(value),
        ValueRef::Text(value) => std::str::from_utf8(value)
            .ok()
            .and_then(|value| value.parse::<i64>().ok())
            .ok_or_else(|| {
                rusqlite::Error::UserFunctionError(
                    format!("kb_rand: argument {} must be an integer", idx + 1).into(),
                )
            }),
        _ => Err(rusqlite::Error::UserFunctionError(
            format!("kb_rand: argument {} must be an integer", idx + 1).into(),
        )),
    }
}

fn register_kb_rand(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.create_scalar_function(
        "kb_rand",
        2,
        FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_INNOCUOUS,
        |ctx| -> rusqlite::Result<i64> {
            let seed = kb_rand_arg(ctx, 0)?;
            let id = kb_rand_arg(ctx, 1)?;
            Ok(kb_rand_value(seed, id))
        },
    )
}

fn register_name_language_functions(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.create_scalar_function(
        "name_language_bucket",
        1,
        FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_INNOCUOUS,
        |ctx| -> rusqlite::Result<String> {
            let value: String = ctx.get(0)?;
            Ok(name_language_bucket(&value).to_string())
        },
    )?;
    conn.create_scalar_function(
        "name_language_rank",
        1,
        FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_INNOCUOUS,
        |ctx| -> rusqlite::Result<i64> {
            let bucket: String = ctx.get(0)?;
            Ok(name_language_rank(&bucket))
        },
    )
}

fn name_language_bucket(value: &str) -> &'static str {
    for ch in value.chars().filter(|ch| ch.is_alphabetic()) {
        let code = ch as u32;
        if (0xAC00..=0xD7AF).contains(&code) || (0x1100..=0x11FF).contains(&code) {
            return "korean";
        }
        if (0x3040..=0x30FF).contains(&code) {
            return "japanese";
        }
        if (0x4E00..=0x9FFF).contains(&code) || (0x3400..=0x4DBF).contains(&code) {
            return "chinese";
        }
        if ch.is_ascii_alphabetic() {
            return "english";
        }
    }
    "other"
}

fn name_language_rank(bucket: &str) -> i64 {
    match bucket {
        "english" => 0,
        "chinese" => 1,
        "japanese" => 2,
        "korean" => 3,
        _ => 4,
    }
}

/// `vd_display_name(canonical)` — 当前全局 locale 下 canonical 段名 (如
/// `'subAlbums'` / `'hidden-album'` / `'image'`) 的本地化字符串。读取 thread-local
/// `current_vd_locale()`, 与 programmatic 的 `kabegame_i18n::vd_display_name` 等价。
fn register_vd_display_name(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.create_scalar_function(
        "vd_display_name",
        1,
        FunctionFlags::SQLITE_UTF8,
        |ctx| -> rusqlite::Result<String> {
            let canonical: String = ctx.get(0)?;
            Ok(kabegame_i18n::vd_display_name(&canonical))
        },
    )
}

/// `crawled_at_seconds(t)` — 把 `images.crawled_at` (可能 ms 或 s 时间戳) 规整为秒。
/// 阈值 253402300799 (= 9999-12-31 23:59:59 unix epoch seconds): 大于此值视作毫秒
/// (除以 1000), 否则原样。用于替换全工程 4 处重复的 `CASE WHEN crawled_at > 253402300799 ...`
/// 表达式 (date 函数 / time filter / 等)。
fn register_crawled_at_seconds(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.create_scalar_function(
        "crawled_at_seconds",
        1,
        FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_INNOCUOUS,
        |ctx| -> rusqlite::Result<i64> {
            let v: i64 = ctx.get(0)?;
            Ok(if v > 253_402_300_799 { v / 1000 } else { v })
        },
    )
}

fn register_get_plugin(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.create_scalar_function(
        "get_plugin",
        -1, // 1-2 参数 (id, [locale])
        FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_UTF8,
        |ctx| -> rusqlite::Result<String> {
            let argc = ctx.len();
            if argc == 0 {
                return Err(rusqlite::Error::UserFunctionError(
                    "get_plugin: expected at least 1 argument (plugin_id)".into(),
                ));
            }
            let plugin_id: String = ctx.get(0)?;
            let locale: Option<String> = if argc >= 2 {
                let raw: rusqlite::types::Value = ctx.get(1)?;
                match raw {
                    rusqlite::types::Value::Text(s) => Some(s),
                    rusqlite::types::Value::Null => None,
                    _ => None,
                }
            } else {
                None
            };
            let started = Instant::now();
            let result = get_plugin_json(&plugin_id, locale.as_deref());
            profile_get_plugin_call(&plugin_id, locale.as_deref(), started, &result);
            Ok(result)
        },
    )
}

/// 返回 plugin 基础元数据 JSON 对象字符串; plugin 不存在时返回 `"null"`。
/// PluginManager 未初始化也走这个路径 — 测试期常见。
fn get_plugin_json(plugin_id: &str, locale: Option<&str>) -> String {
    let Some(pm) = PluginManager::global_opt() else {
        return "null".into();
    };
    let Some(plugin) = pm.get(plugin_id) else {
        return "null".into();
    };
    let locale_owned;
    let locale_str: &str = match locale {
        Some(l) => l,
        None => {
            locale_owned = kabegame_i18n::current_vd_locale().to_string();
            locale_owned.as_str()
        }
    };
    let name = resolve_i18n_text(&plugin.name, locale_str);
    let display_name = manifest_value_display_for_locale(&plugin.name, locale_str);
    let description = resolve_i18n_text(&plugin.description, locale_str);
    serde_json::json!({
        "id": plugin.id,
        "name": name,
        "displayName": display_name,
        "description": description,
        "baseUrl": plugin.base_url,
    })
    .to_string()
}

/// 解析多语言对象 (`{default, zh, en, ja, zhtw, ...}`) 为单字符串。
/// 优先级: 完整 locale → 前缀 (按 `_` 切) → `default` → `en` → 空串。
/// 标量字符串直接透传。
fn resolve_i18n_text(value: &serde_json::Value, locale: &str) -> String {
    if let Some(s) = value.as_str() {
        return s.to_string();
    }
    let Some(obj) = value.as_object() else {
        return String::new();
    };
    if let Some(s) = obj.get(locale).and_then(|v| v.as_str()) {
        return s.into();
    }
    if let Some(prefix) = locale.split('_').next() {
        if !prefix.is_empty() && prefix != locale {
            if let Some(s) = obj.get(prefix).and_then(|v| v.as_str()) {
                return s.into();
            }
        }
    }
    if let Some(s) = obj.get("default").and_then(|v| v.as_str()) {
        return s.into();
    }
    if let Some(s) = obj.get("en").and_then(|v| v.as_str()) {
        return s.into();
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn kb_rand_is_deterministic() {
        assert_eq!(kb_rand_value(42, 7), kb_rand_value(42, 7));
    }

    #[test]
    fn kb_rand_accepts_text_seed() {
        let conn = Connection::open_in_memory().unwrap();
        register_kb_rand(&conn).unwrap();
        let value: i64 = conn
            .query_row("SELECT kb_rand('42', 7)", [], |row| row.get(0))
            .unwrap();
        assert_eq!(value, kb_rand_value(42, 7));
    }

    #[test]
    fn kb_rand_changes_with_seed() {
        assert_ne!(kb_rand_value(42, 7), kb_rand_value(43, 7));
    }

    #[test]
    fn search_dummy_url_function_handles_null_placeholders_and_real_urls() {
        let conn = Connection::open_in_memory().unwrap();
        register_is_search_dummy_url(&conn).unwrap();
        let values: (i64, i64, i64, i64) = conn
            .query_row(
                "SELECT is_search_dummy_url(NULL), \
                        is_search_dummy_url('file:///a/b.png'), \
                        is_search_dummy_url('https://x/a.png'), \
                        is_search_dummy_url('blob:https://x/1')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(values, (1, 1, 0, 1));
    }

    fn palette_distance(conn: &Connection, palette: Option<&str>, hex: &str) -> i64 {
        conn.query_row(
            "SELECT kb_palette_distance(?1, ?2)",
            rusqlite::params![palette, hex],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[test]
    fn kb_palette_distance_matches_distance_to() {
        use crate::media::palette::{distance_to, PaletteColor};

        let conn = Connection::open_in_memory().unwrap();
        register_kb_palette_distance(&conn).unwrap();
        let palettes = [
            Palette::single([255, 0, 0]),
            Palette::single([0, 0, 0]),
            Palette(vec![
                PaletteColor {
                    rgb: 0x3a7bd5,
                    percent: 62,
                },
                PaletteColor {
                    rgb: 0xffffff,
                    percent: 33,
                },
                PaletteColor {
                    rgb: 0x102030,
                    percent: 5,
                },
            ]),
        ];
        for palette in &palettes {
            for rgb in [
                0xff0000_u32,
                0x00ff00,
                0x3a7bd5,
                0x000000,
                0xffffff,
                0x000001,
            ] {
                let hex = format!("{rgb:06x}");
                assert_eq!(
                    palette_distance(&conn, Some(&palette.to_json()), &hex),
                    i64::from(distance_to(Some(palette), rgb)),
                    "{palette:?} -> {hex}"
                );
            }
        }
        // 同色为 0；大写十六进制是同一个颜色
        let red = Palette::single([255, 0, 0]).to_json();
        assert_eq!(palette_distance(&conn, Some(&red), "ff0000"), 0);
        assert_eq!(palette_distance(&conn, Some(&red), "FF0000"), 0);
        // DSL 传的是带 `0x` 前缀的写法；纯数字的颜色也必须是文本
        for (prefixed, rgb) in [
            ("0xff0000", 0xff0000_u32),
            ("0x000000", 0),
            ("0x804000", 0x804000),
        ] {
            assert_eq!(
                palette_distance(&conn, Some(&red), prefixed),
                i64::from(distance_to(Some(&Palette::single([255, 0, 0])), rgb)),
                "{prefixed}"
            );
        }
    }

    #[test]
    fn kb_palette_distance_returns_the_sentinel_without_a_usable_palette() {
        use crate::media::palette::NO_PALETTE_DISTANCE;

        let conn = Connection::open_in_memory().unwrap();
        register_kb_palette_distance(&conn).unwrap();
        let none = i64::from(NO_PALETTE_DISTANCE);
        assert_eq!(palette_distance(&conn, None, "ff0000"), none);
        for bad in ["", "not json", "[]", "[[16777216,50]]", "[[255,0]]", "{}"] {
            assert_eq!(palette_distance(&conn, Some(bad), "ff0000"), none, "{bad}");
        }
        // 列里不是文本（整数、BLOB）同样当作没有色盘
        let odd: (i64, i64) = conn
            .query_row(
                "SELECT kb_palette_distance(7, 'ff0000'), kb_palette_distance(x'5b5d', 'ff0000')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(odd, (none, none));
    }

    #[test]
    fn kb_palette_distance_rejects_bad_hex() {
        let conn = Connection::open_in_memory().unwrap();
        register_kb_palette_distance(&conn).unwrap();
        let red = Palette::single([255, 0, 0]).to_json();
        for bad in [
            "ff000",
            "ff00000",
            "gg0000",
            "+f0000",
            "0xff00",
            "#ff000",
            "",
            "0x",
            "0xff000",
            "0xff00000",
            "0x0xff0000",
            "0XFF0000",
        ] {
            for palette in [Some(red.as_str()), None] {
                let result: Result<i64, _> = conn.query_row(
                    "SELECT kb_palette_distance(?1, ?2)",
                    rusqlite::params![palette, bad],
                    |row| row.get(0),
                );
                assert!(result.is_err(), "{bad:?} / {palette:?}");
            }
        }
        // 非文本的第二个参数（NULL、整数）也报错
        for sql in [
            "SELECT kb_palette_distance('[[255,100]]', NULL)",
            "SELECT kb_palette_distance('[[255,100]]', 16711680)",
        ] {
            let result: Result<i64, _> = conn.query_row(sql, [], |row| row.get(0));
            assert!(result.is_err(), "{sql}");
        }
    }

    /// 参考色按参数缓存：同一条语句里逐行求值、换一个参考色重新执行，结果都对。
    #[test]
    fn kb_palette_distance_is_correct_across_rows_and_rebinds() {
        use crate::media::palette::distance_to;

        let conn = Connection::open_in_memory().unwrap();
        register_kb_palette_distance(&conn).unwrap();
        conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, palette TEXT);")
            .unwrap();
        let palettes = [
            Some(Palette::single([255, 0, 0])),
            None,
            Some(Palette::single([0, 0, 255])),
            Some(Palette::single([10, 200, 30])),
        ];
        for palette in &palettes {
            conn.execute(
                "INSERT INTO t (palette) VALUES (?1)",
                [palette.as_ref().map(Palette::to_json)],
            )
            .unwrap();
        }
        let mut stmt = conn
            .prepare("SELECT kb_palette_distance(palette, ?1) FROM t ORDER BY id")
            .unwrap();
        for rgb in [0xff0000_u32, 0x0000ff, 0x808080] {
            let got: Vec<i64> = stmt
                .query_map([format!("{rgb:06x}")], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            let expected: Vec<i64> = palettes
                .iter()
                .map(|palette| i64::from(distance_to(palette.as_ref(), rgb)))
                .collect();
            assert_eq!(got, expected, "{rgb:06x}");
        }
    }

    #[test]
    fn parse_color_hex_accepts_exactly_six_hex_digits() {
        assert_eq!(parse_color_hex("ff8000"), Some(0xff8000));
        assert_eq!(parse_color_hex("000000"), Some(0));
        assert_eq!(parse_color_hex("ABCDEF"), Some(0xabcdef));
        assert_eq!(parse_color_hex("0xff8000"), Some(0xff8000));
        assert_eq!(parse_color_hex("0x000000"), Some(0));
        for bad in [
            "",
            "fff",
            "ff80000",
            "+f8000",
            "-f8000",
            "ff 000",
            "ｆf8000",
            "0x",
            "0xfff",
            "0xff80000",
            "0Xff8000",
        ] {
            assert_eq!(parse_color_hex(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn resolve_i18n_text_exact_locale_match() {
        let v = json!({"default":"foo","zh":"中文","en":"english"});
        assert_eq!(resolve_i18n_text(&v, "zh"), "中文");
        assert_eq!(resolve_i18n_text(&v, "en"), "english");
    }

    #[test]
    fn resolve_i18n_text_prefix_match() {
        let v = json!({"default":"foo","zh":"中文","en":"english"});
        assert_eq!(resolve_i18n_text(&v, "zh_CN"), "中文");
        assert_eq!(resolve_i18n_text(&v, "en_US"), "english");
    }

    #[test]
    fn resolve_i18n_text_falls_back_to_default() {
        let v = json!({"default":"foo","zh":"中文"});
        // "ja" not present + no "ja_" prefix collision → default
        assert_eq!(resolve_i18n_text(&v, "ja"), "foo");
    }

    #[test]
    fn resolve_i18n_text_falls_back_to_en_then_empty() {
        let v = json!({"en":"english"});
        assert_eq!(resolve_i18n_text(&v, "fr"), "english");

        let v2 = json!({"only-some-key":"x"});
        assert_eq!(resolve_i18n_text(&v2, "fr"), "");
    }

    #[test]
    fn resolve_i18n_text_string_passthrough() {
        let v = json!("plain string");
        assert_eq!(resolve_i18n_text(&v, "zh"), "plain string");
    }

    #[test]
    fn resolve_i18n_text_nonobject_nonstring_returns_empty() {
        let v = json!(42);
        assert_eq!(resolve_i18n_text(&v, "zh"), "");
        let v = json!(null);
        assert_eq!(resolve_i18n_text(&v, "zh"), "");
    }

    #[test]
    fn get_plugin_returns_null_for_unknown_id() {
        let conn = Connection::open_in_memory().unwrap();
        register_dsl_functions(&conn).unwrap();
        let result: String = conn
            .query_row("SELECT get_plugin('nonexistent_xyz')", [], |r| r.get(0))
            .unwrap();
        assert_eq!(result, "null");
    }

    #[test]
    fn get_plugin_returns_null_when_plugin_manager_uninit() {
        // 测试期 PluginManager::global_opt() 通常 None → "null"
        let conn = Connection::open_in_memory().unwrap();
        register_dsl_functions(&conn).unwrap();
        let result: String = conn
            .query_row("SELECT get_plugin('pixiv', 'en_US')", [], |r| r.get(0))
            .unwrap();
        assert_eq!(result, "null");
    }

    #[test]
    fn get_plugin_zero_args_errors() {
        let conn = Connection::open_in_memory().unwrap();
        register_dsl_functions(&conn).unwrap();
        let r: Result<String, _> = conn.query_row("SELECT get_plugin()", [], |r| r.get(0));
        assert!(r.is_err());
    }
}
