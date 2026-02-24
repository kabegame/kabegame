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

/// 归档解压输出目录
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ArchiveExtractDirResponse {
    pub dir: String,
}
