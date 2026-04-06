use kabegame_i18n::translate_vd_canonical;

use crate::providers::common::PaginationMode;

/// Provider 运行配置：用于在 provider 树中继承 locale 与分页模式。
#[derive(Debug, Clone, Copy)]
pub struct ProviderConfig {
    pub locale: Option<&'static str>,
    pub pagination_mode: PaginationMode,
}

impl ProviderConfig {
    pub const fn gallery_default() -> Self {
        Self {
            locale: None,
            pagination_mode: PaginationMode::SimplePage,
        }
    }

    pub const fn vd_with_locale(locale: &'static str) -> Self {
        Self {
            locale: Some(locale),
            pagination_mode: PaginationMode::Greedy,
        }
    }

    /// 把 canonical key（all/plugin/...）转为显示名（与 `kabegame-i18n` 中 `vd.*` 一致）。
    pub fn display_name(&self, canonical: &str) -> String {
        match self.locale {
            None => canonical.to_string(),
            Some(loc) => translate_vd_canonical(loc, canonical),
        }
    }

    /// 把用户输入（可能是翻译名）还原为 canonical key。
    pub fn canonical_name<'a>(&self, input: &'a str) -> &'a str {
        let name = input.trim();
        if name.is_empty() {
            return input;
        }
        for key in [
            "all",
            "plugin",
            "date",
            "date-range",
            "album",
            "task",
            "surf",
            "media-type",
            "wallpaper-order",
            "desc",
            "image",
            "video",
            "album-order",
            "image-only",
            "video-only",
            "tree",
        ] {
            if self.display_name(key) == name {
                return key;
            }
        }
        input
    }
}
