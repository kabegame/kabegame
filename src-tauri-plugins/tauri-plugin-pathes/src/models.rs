use serde::{Deserialize, Serialize};

/// 应用数据目录（Android filesDir，用于 Kabegame 数据、设置等）
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AppDataDirResponse {
    pub dir: String,
}

/// 缓存路径（Android 内部/外部 cache 目录）
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CachePathsResponse {
    pub internal: String,
    pub external: Option<String>,
}

/// 外部存储数据目录（Android getExternalFilesDir）
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ExternalDataDirResponse {
    pub dir: String,
}

/// 预置插件复制参数（Android：APK assets → 用户插件目录）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedBundledPluginsArgs {
    pub target_dir: String,
}

/// 预置插件复制结果
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SeedBundledPluginsResponse {
    /// 当前安装包版本标记
    pub version: String,
    /// 标记与插件目录中记录的一致，未复制
    pub skipped: bool,
    pub copied: u32,
    #[serde(default)]
    pub failed: u32,
}
