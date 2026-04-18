//! VdLocaleConfig：VD provider 使用的 locale 与 canonical 名转换工具。

use kabegame_i18n::translate_vd_canonical;

/// VD 使用的 locale 配置（替代旧 `ProviderConfig`）。
#[derive(Debug, Clone, Copy)]
pub struct VdLocaleConfig {
    pub locale: &'static str,
}

impl VdLocaleConfig {
    /// 把 canonical key 转为显示名。
    pub fn display_name(&self, canonical: &str) -> String {
        translate_vd_canonical(self.locale, canonical)
    }

    /// 把用户输入（可能是翻译名）还原为 canonical key。
    pub fn canonical_name<'a>(&self, input: &'a str) -> &'a str {
        let name = input.trim();
        if name.is_empty() {
            return input;
        }
        for key in VD_CANONICAL_KEYS {
            if self.display_name(key) == name {
                return key;
            }
        }
        input
    }
}

/// 当前 VD 所有顶层 canonical key（用于反查翻译名）。
const VD_CANONICAL_KEYS: &[&str] = &[
    "all",
    "task",
    "plugin",
    "surf",
    "album",
    "date",
    "mediaType",
    "subAlbums",
];

// ── 月份/日 i18n 工具（VD byTime 层使用）────────────────────────────────────

/// 月份 canonical keys（1-indexed）
const MONTH_CANONICAL: [&str; 12] = [
    "vd.month.jan", "vd.month.feb", "vd.month.mar",
    "vd.month.apr", "vd.month.may", "vd.month.jun",
    "vd.month.jul", "vd.month.aug", "vd.month.sep",
    "vd.month.oct", "vd.month.nov", "vd.month.dec",
];

/// 返回第 `month`（1-12）的 VD 显示名（带 locale）。
pub fn month_display_name(locale: &str, month: u32) -> String {
    if month < 1 || month > 12 {
        return month.to_string();
    }
    let key = MONTH_CANONICAL[(month - 1) as usize];
    kabegame_i18n::translate_vd_canonical(locale, key)
}

/// 反查月份 canonical index（1-12），失败返回 None。
pub fn month_canonical_from_display(locale: &str, name: &str) -> Option<u32> {
    for (i, &key) in MONTH_CANONICAL.iter().enumerate() {
        if kabegame_i18n::translate_vd_canonical(locale, key) == name {
            return Some((i + 1) as u32);
        }
    }
    // fallback: 尝试直接解析数字（纯数字月份名）
    name.parse::<u32>().ok().filter(|&m| m >= 1 && m <= 12)
}

/// 返回「日」的 VD 显示名（带 locale）。目前用 `{n}日`（zh）/ `{n}` 格式（en 等）。
pub fn day_display_name(locale: &str, day: u32) -> String {
    kabegame_i18n::translate_vd_canonical(locale, &format!("vd.day.{day}"))
}

/// 反查日 canonical index（1-31）。
pub fn day_canonical_from_display(locale: &str, name: &str) -> Option<u32> {
    for d in 1u32..=31 {
        if day_display_name(locale, d) == name {
            return Some(d);
        }
    }
    // fallback
    name.parse::<u32>().ok().filter(|&d| d >= 1 && d <= 31)
}
