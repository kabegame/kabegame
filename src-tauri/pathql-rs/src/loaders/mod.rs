//! 输入侧适配器（Loader trait 实现）。
//!
//! 每个子模块对应一种外部输入格式，feature 开关控制编译。
//! 把字节流 / 字符串反序列化为 `ProviderDef` AST。

#[cfg(feature = "json5")]
pub mod json5;
#[cfg(feature = "yaml")]
pub mod yaml;

#[cfg(feature = "json5")]
pub use json5::Json5Loader;
#[cfg(feature = "yaml")]
pub use yaml::YamlLoader;

#[cfg(any(feature = "json5", feature = "yaml"))]
use crate::ast::ProviderDef;
#[cfg(any(feature = "json5", feature = "yaml"))]
use crate::loader::{LoadError, Loader, Source};
#[cfg(any(feature = "json5", feature = "yaml"))]
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoaderType {
    #[cfg(feature = "json5")]
    JSON5,
    #[cfg(feature = "yaml")]
    YAML,
}

impl LoaderType {
    /// 按文件扩展名（不区分大小写，不含点）选择 loader：
    /// `json` / `json5` → JSON5（json 是 json5 的子集），`yaml` / `yml` → YAML。
    /// 对应 feature 未开启或扩展名未知时返回 `None`。
    pub fn from_extension(ext: &str) -> Option<Self> {
        let ext = ext.to_ascii_lowercase();
        match ext.as_str() {
            #[cfg(feature = "json5")]
            "json" | "json5" => Some(Self::JSON5),
            #[cfg(feature = "yaml")]
            "yaml" | "yml" => Some(Self::YAML),
            _ => None,
        }
    }

    /// 按路径（`/` 或 `\` 分隔均可）的扩展名选择 loader，规则同 [`Self::from_extension`]。
    pub fn from_path(path: &str) -> Option<Self> {
        let file = path.rsplit(['/', '\\']).next().unwrap_or(path);
        let (_, ext) = file.rsplit_once('.')?;
        Self::from_extension(ext)
    }

    /// 用该格式的 loader 解析一份 provider 定义。
    #[cfg(any(feature = "json5", feature = "yaml"))]
    pub fn load(self, source: Source<'_>) -> Result<ProviderDef, LoadError> {
        match self {
            #[cfg(feature = "json5")]
            Self::JSON5 => Json5Loader.load(source),
            #[cfg(feature = "yaml")]
            Self::YAML => YamlLoader.load(source),
        }
    }
}

/// 各文本格式 loader 共用：把 [`Source`] 读成 UTF-8 文本，Path 来源同时带回路径供报错定位。
#[cfg(any(feature = "json5", feature = "yaml"))]
pub(crate) fn read_source_text(source: Source<'_>) -> Result<(String, Option<PathBuf>), LoadError> {
    match source {
        Source::Path(p) => {
            let text = std::fs::read_to_string(p).map_err(|e| LoadError::Io {
                path: p.to_path_buf(),
                source: e,
            })?;
            Ok((text, Some(p.to_path_buf())))
        }
        Source::Str(s) => Ok((s.to_string(), None)),
        Source::Bytes(b) => {
            let text = std::str::from_utf8(b)
                .map_err(|e| LoadError::Type {
                    path: None,
                    msg: format!("invalid utf-8: {}", e),
                })?
                .to_string();
            Ok((text, None))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(feature = "json5")]
    fn from_path_picks_json5() {
        assert_eq!(LoaderType::from_path("a/b.json5"), Some(LoaderType::JSON5));
        assert_eq!(LoaderType::from_path("a\\b.JSON"), Some(LoaderType::JSON5));
    }

    #[test]
    #[cfg(feature = "yaml")]
    fn from_path_picks_yaml() {
        assert_eq!(
            LoaderType::from_path("providers/x.yaml"),
            Some(LoaderType::YAML)
        );
        assert_eq!(
            LoaderType::from_path("providers/x.YML"),
            Some(LoaderType::YAML)
        );
    }

    #[test]
    fn from_path_rejects_unknown() {
        assert_eq!(LoaderType::from_path("a/b.txt"), None);
        assert_eq!(LoaderType::from_path("a.dir/noext"), None);
        assert_eq!(LoaderType::from_path(""), None);
    }
}
