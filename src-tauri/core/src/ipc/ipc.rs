//! CLI daemon IPC（跨平台）
//!
//! - Windows：命名管道（\\.\pipe\...）
//! - Unix：Unix domain socket（临时目录）
//! - 协议：长度前缀帧 + CBOR payload（二进制）
//!
//! 设计目的：给 `kabegame-cli daemon` 提供一个轻量常驻后台入口，
//! 让外部（例如 KDE Plasma 壁纸插件）能触发"运行一次爬虫插件"并获取结果/状态。

use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use std::collections::HashMap;
use std::sync::OnceLock;

fn ipc_default_safe_delete() -> bool {
    true
}

pub fn ipc_debug_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| match std::env::var("KABEGAME_IPC_DEBUG") {
        Ok(v) => {
            let v = v.to_ascii_lowercase();
            v == "1" || v == "true" || v == "yes" || v == "on"
        }
        Err(_) => false,
    })
}

#[macro_export]
macro_rules! ipc_dbg {
    ($($arg:tt)*) => {
        if $crate::ipc::ipc::ipc_debug_enabled() {
            eprintln!($($arg)*);
        }
    };
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "kebab-case")]
pub enum IpcRequest {
    /// 探活
    Status,

    /// 虚拟盘：挂载（Windows + virtual-driver）
    #[cfg(kabegame_mode = "standard")]
    VdMount,

    /// 虚拟盘：卸载（Windows + virtual-driver）
    #[cfg(kabegame_mode = "standard")]
    VdUnmount,

    /// 虚拟盘：状态（Windows + virtual-driver）
    #[cfg(kabegame_mode = "standard")]
    VdStatus,

    /// 导入插件请求（从 .kgpg 文件）
    AppImportPlugin {
        /// .kgpg 文件路径
        kgpg_path: String,
    },

    /// 显示应用窗口（如果隐藏）
    AppShowWindow,

    /// 运行一次 Rhai 插件（等价于 `kabegame-cli plugin run`）
    PluginRun {
        /// 插件 ID（已安装的 .kgpg 文件名，不含扩展名）或插件文件路径（.kgpg）
        plugin: String,

        /// 输出目录（下载图片保存目录）。None 表示使用默认图片目录。
        #[serde(default)]
        output_dir: Option<String>,

        /// 任务 ID（用于进度与日志归档）。None 表示由 daemon 生成。
        #[serde(default)]
        task_id: Option<String>,

        /// 输出画册 ID（可选）
        #[serde(default)]
        output_album_id: Option<String>,

        /// 传给插件的参数（等价于 `--` 之后的 tokens）
        #[serde(default)]
        plugin_args: Vec<String>,

        /// 运行时 HTTP 头（用于 to/fetch_json/download_image 等请求）
        #[serde(default)]
        http_headers: Option<HashMap<String, String>>,
    },

    // ======== Storage 相关 ========
    /// 获取图片总数
    StorageGetImagesCount,

    /// 根据 ID 获取图片
    StorageGetImageById {
        image_id: String,
    },

    /// 根据本地路径查找图片（用于把“外部选择的壁纸路径”映射回 imageId）
    StorageFindImageByPath {
        path: String,
    },

    /// 删除图片
    StorageDeleteImage {
        image_id: String,
    },

    /// 仅从数据库移除图片（不删除本地文件）
    StorageRemoveImage {
        image_id: String,
    },

    /// 批量删除图片（删除本地文件 + DB）
    StorageBatchDeleteImages {
        image_ids: Vec<String>,
    },

    /// 批量仅移除图片（仅 DB）
    StorageBatchRemoveImages {
        image_ids: Vec<String>,
    },

    /// 收藏/取消收藏图片（收藏画册）
    StorageToggleImageFavorite {
        image_id: String,
        favorite: bool,
    },

    /// 获取所有画册
    StorageGetAlbums,

    /// 添加画册
    StorageAddAlbum {
        name: String,
    },

    /// 删除画册
    StorageDeleteAlbum {
        album_id: String,
    },

    /// 重命名画册
    StorageRenameAlbum {
        album_id: String,
        new_name: String,
    },

    /// 添加图片到画册
    StorageAddImagesToAlbum {
        album_id: String,
        image_ids: Vec<String>,
    },

    /// 从画册移除图片
    StorageRemoveImagesFromAlbum {
        album_id: String,
        image_ids: Vec<String>,
    },

    /// 获取画册图片
    StorageGetAlbumImages {
        album_id: String,
    },

    /// 获取画册预览图片（前 N 张）
    StorageGetAlbumPreview {
        album_id: String,
        limit: usize,
    },

    /// 获取各画册图片数量（用于侧边栏/列表徽标）
    StorageGetAlbumCounts,

    /// 更新画册内图片排序
    StorageUpdateAlbumImagesOrder {
        album_id: String,
        image_orders: Vec<(String, i64)>,
    },

    /// 获取画册图片 ID 列表
    StorageGetAlbumImageIds {
        album_id: String,
    },

    /// 获取所有任务
    StorageGetAllTasks,

    /// 根据 ID 获取任务
    StorageGetTask {
        task_id: String,
    },

    /// 添加任务
    StorageAddTask {
        task: serde_json::Value,
    },

    /// 更新任务
    StorageUpdateTask {
        task: serde_json::Value,
    },

    /// 删除任务
    StorageDeleteTask {
        task_id: String,
    },

    /// 获取任务失败图片
    StorageGetTaskFailedImages {
        task_id: String,
    },

    /// 获取所有任务失败图片
    StorageGetAllFailedImages,

    /// 清除所有已完成/失败/取消的任务
    StorageClearFinishedTasks,

    /// 获取运行配置列表
    StorageGetRunConfigs,

    /// 添加运行配置
    StorageAddRunConfig {
        config: serde_json::Value,
    },

    /// 更新运行配置
    StorageUpdateRunConfig {
        config: serde_json::Value,
    },

    /// 删除运行配置
    StorageDeleteRunConfig {
        config_id: String,
    },

    // ======== Storage - Gallery Query Helpers（供 app-main 组装画廊虚拟路径）========
    /// 获取“按时间”分组（yearMonth 列表）
    StorageGetGalleryDateGroups,

    /// 获取“按插件”分组（pluginId 列表）
    StorageGetGalleryPluginGroups,

    /// 获取“按任务”分组（只返回包含图片的任务）
    StorageGetTasksWithImages,

    /// 按 query 统计图片数量
    StorageGetImagesCountByQuery {
        query: serde_json::Value,
    },

    // ======== Task 调度（daemon 侧）========
    /// 入队一个任务（daemon 负责落库幂等 + 入队执行）
    TaskStart {
        task: serde_json::Value,
    },

    /// 取消任务
    TaskCancel {
        task_id: String,
    },

    /// 重试一条失败图片下载（task_failed_images.id）
    TaskRetryFailedImage {
        failed_id: i64,
    },

    /// 删除一条失败图片记录（task_failed_images.id）
    TaskDeleteFailedImage {
        failed_id: i64,
    },

    /// 获取正在下载的任务列表
    GetActiveDownloads,

    // ======== Organize（daemon 侧）========
    /// 启动整理任务
    OrganizeStart {
        dedupe: bool,
        remove_missing: bool,
        regen_thumbnails: bool,
        #[serde(default)]
        remove_unrecognized: bool,
        #[serde(default)]
        range_start: Option<usize>,
        #[serde(default)]
        range_end: Option<usize>,
        #[serde(default)]
        delete_source_files: bool,
        #[serde(default = "ipc_default_safe_delete")]
        safe_delete: bool,
    },

    /// 取消整理任务
    OrganizeCancel,

    // ======== Plugin 相关 ========
    /// 获取已安装插件列表
    PluginGetPlugins,

    /// 获取插件详情
    PluginGetDetail {
        plugin_id: String,
    },

    /// 删除插件
    PluginDelete {
        plugin_id: String,
    },

    /// 导入插件
    PluginImport {
        kgpg_path: String,
    },

    /// 获取插件源列表
    PluginGetPluginSources,

    /// 验证插件源 index.json
    PluginValidateSource {
        index_url: String,
    },

    /// 添加插件源
    PluginAddSource {
        id: Option<String>,
        name: String,
        index_url: String,
    },

    /// 更新插件源
    PluginUpdateSource {
        id: String,
        name: String,
        index_url: String,
    },

    /// 删除插件源
    PluginDeleteSource {
        id: String,
    },

    /// 获取商店插件列表（可选指定 source_id）
    PluginGetStorePlugins {
        #[serde(default)]
        source_id: Option<String>,
        #[serde(default)]
        force_refresh: bool,
        /// 非强制刷新时：若 index 缓存 `updated_at` 超过该秒数则重新拉取；`None` 表示不按时间失效
        #[serde(default)]
        revalidate_if_stale_after_secs: Option<u64>,
    },

    /// 预览导入插件（读取 .kgpg）
    PluginPreviewImport {
        zip_path: String,
    },

    /// 商店安装预览：从 source cache 查找下载信息 + ensure_plugin_cached + preview
    PluginPreviewStoreInstall {
        source_id: String,
        plugin_id: String,
    },

    /// KGPG v2：远程获取 icon（base64）
    PluginGetRemoteIconV2 {
        download_url: String,
        #[serde(default)]
        source_id: Option<String>,
        #[serde(default)]
        plugin_id: Option<String>,
    },

    // ======== Settings 相关 ========
    // 注意：整包 SettingsGet/Update/Key 已移除，改为细粒度 getter/setter

    // ======== Settings Getter（细粒度）========
    SettingsGetAutoLaunch,
    SettingsGetMaxConcurrentDownloads,
    SettingsGetMaxConcurrentTasks,
    SettingsGetNetworkRetryCount,
    SettingsGetImageClickAction,
    SettingsGetGalleryImageAspectRatio,
    SettingsGetAutoDeduplicate,
    SettingsGetDefaultDownloadDir,
    SettingsGetWallpaperEngineDir,
    SettingsGetWallpaperRotationEnabled,
    SettingsGetWallpaperRotationAlbumId,
    SettingsGetWallpaperRotationIncludeSubalbums,
    SettingsGetWallpaperRotationIntervalMinutes,
    SettingsGetWallpaperRotationMode,
    SettingsGetWallpaperStyle,
    SettingsGetWallpaperRotationTransition,
    SettingsGetWallpaperStyleByMode,
    SettingsGetWallpaperTransitionByMode,
    SettingsGetWallpaperMode,
    SettingsGetWallpaperVolume,
    SettingsGetWallpaperVideoPlaybackRate,
    SettingsGetWindowState,
    SettingsGetCurrentWallpaperImageId,
    SettingsGetDefaultImagesDir,
    #[cfg(kabegame_mode = "standard")]
    SettingsGetAlbumDriveEnabled,
    #[cfg(kabegame_mode = "standard")]
    SettingsGetAlbumDriveMountPoint,

    // ======== Settings Setter（保留 core::Settings 的校验逻辑）========
    SettingsSetGalleryImageAspectRatio {
        aspect_ratio: Option<String>,
    },
    SettingsSetWallpaperEngineDir {
        dir: Option<String>,
    },
    SettingsGetWallpaperEngineMyprojectsDir,
    SettingsSetWallpaperRotationEnabled {
        enabled: bool,
    },
    SettingsSetWallpaperRotationAlbumId {
        album_id: Option<String>,
    },
    SettingsSetWallpaperRotationIncludeSubalbums {
        include_subalbums: bool,
    },
    SettingsSetWallpaperRotationTransition {
        transition: String,
    },
    SettingsSetWallpaperStyle {
        style: String,
    },
    SettingsSetWallpaperMode {
        mode: String,
    },
    #[cfg(kabegame_mode = "standard")]
    SettingsSetAlbumDriveEnabled {
        enabled: bool,
    },
    #[cfg(kabegame_mode = "standard")]
    SettingsSetAlbumDriveMountPoint {
        mount_point: String,
    },
    SettingsSetAutoLaunch {
        enabled: bool,
    },
    SettingsSetMaxConcurrentDownloads {
        count: u32,
    },
    SettingsSetMaxConcurrentTasks {
        count: u32,
    },
    SettingsSetNetworkRetryCount {
        count: u32,
    },
    SettingsSetImageClickAction {
        action: String,
    },
    SettingsSetAutoDeduplicate {
        enabled: bool,
    },
    SettingsSetDefaultDownloadDir {
        dir: Option<String>,
    },
    SettingsSetWallpaperRotationIntervalMinutes {
        minutes: u32,
    },
    SettingsSetWallpaperRotationMode {
        mode: String,
    },
    SettingsSetCurrentWallpaperImageId {
        image_id: Option<String>,
    },
    SettingsSwapStyleTransitionForModeSwitch {
        old_mode: String,
        new_mode: String,
    },

    // ======== Gallery / Provider 相关 ========
    /// 浏览虚拟 Provider 路径（用于 Gallery/Album/Task 视图的虚拟目录树）
    GalleryBrowseProvider {
        path: String,
    },

    // ======== 事件订阅 ========
    /// 订阅事件（建立长连接，服务器会持续推送事件）
    SubscribeEvents {
        /// 感兴趣的事件类型列表（空=订阅全部，向后兼容）
        /// 事件类型字符串：taskLog, downloadState, taskStatus, taskProgress, taskError,
        /// downloadProgress, generic, connectionStatus, dedupeProgress, dedupeFinished,
        /// wallpaperUpdateImage, imagesChange, wallpaperUpdateStyle, wallpaperUpdateTransition,
        /// settingChange, albumAdded
        #[serde(default)]
        kinds: Vec<String>,
    },
}

/// IPC 请求信封（用于携带 request_id）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcEnvelope<T> {
    pub request_id: u64,
    #[serde(flatten)]
    pub payload: T,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct IpcResponse {
    pub ok: bool,
    #[serde(default)]
    pub message: Option<String>,

    /// 请求 ID（用于匹配请求-响应）
    #[serde(default)]
    pub request_id: Option<u64>,

    /// 对 PluginRun：实际使用的 task_id（若请求未提供则由 daemon 生成）
    #[serde(default)]
    pub task_id: Option<String>,

    /// 对 VD：是否已挂载
    #[serde(default)]
    #[cfg(kabegame_mode = "standard")]
    pub mounted: Option<bool>,

    /// 对 VD：当前挂载点
    #[serde(default)]
    #[cfg(kabegame_mode = "standard")]
    pub mount_point: Option<String>,

    /// 对 Status：daemon 版本/能力信息（可选，后续扩展）
    #[serde(default)]
    pub info: Option<serde_json::Value>,

    /// 通用数据载荷（用于返回 Storage/Plugin/Settings 查询结果）
    /// 可以是：图片列表、画册列表、任务列表、插件列表、设置对象等
    /// 默认为 `null`，表示无数据
    #[serde(default)]
    pub data: serde_json::Value,

    /// 二进制载荷（用于图片等二进制数据）
    #[serde(default)]
    pub bytes: Option<ByteBuf>,

    /// 二进制载荷的 MIME 类型（例如 "image/png"）
    #[serde(default)]
    pub bytes_mime: Option<String>,
}

impl IpcResponse {
    pub fn ok(message: impl Into<String>) -> Self {
        Self {
            ok: true,
            message: Some(message.into()),
            request_id: None,
            task_id: None,
            #[cfg(kabegame_mode = "standard")]
            mounted: None,
            #[cfg(kabegame_mode = "standard")]
            mount_point: None,
            info: None,
            data: serde_json::Value::Null,
            bytes: None,
            bytes_mime: None,
        }
    }

    pub fn err(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            message: Some(message.into()),
            request_id: None,
            task_id: None,
            #[cfg(kabegame_mode = "standard")]
            mounted: None,
            #[cfg(kabegame_mode = "standard")]
            mount_point: None,
            info: None,
            data: serde_json::Value::Null,
            bytes: None,
            bytes_mime: None,
        }
    }

    pub fn ok_with_data(message: impl Into<String>, data: serde_json::Value) -> Self {
        Self {
            ok: true,
            message: Some(message.into()),
            request_id: None,
            task_id: None,
            #[cfg(kabegame_mode = "standard")]
            mounted: None,
            #[cfg(kabegame_mode = "standard")]
            mount_point: None,
            info: None,
            data: data,
            bytes: None,
            bytes_mime: None,
        }
    }

    pub fn ok_with_bytes(
        message: impl Into<String>,
        mime: impl Into<String>,
        bytes: Vec<u8>,
    ) -> Self {
        Self {
            ok: true,
            message: Some(message.into()),
            request_id: None,
            task_id: None,
            #[cfg(kabegame_mode = "standard")]
            mounted: None,
            #[cfg(kabegame_mode = "standard")]
            mount_point: None,
            info: None,
            data: serde_json::Value::Null,
            bytes: Some(ByteBuf::from(bytes)),
            bytes_mime: Some(mime.into()),
        }
    }
}

/// 编码 CBOR 帧（长度前缀 + CBOR payload）
pub fn encode_frame<T: Serialize>(v: &T) -> Result<Vec<u8>, String> {
    let payload = serde_cbor::to_vec(v).map_err(|e| format!("ipc cbor encode failed: {}", e))?;

    if payload.len() > 64 * 1024 * 1024 {
        return Err("ipc frame payload too large (max 64MB)".to_string());
    }

    let len = payload.len() as u32;
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&len.to_le_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

/// 解码 CBOR 帧
pub fn decode_frame<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> Result<T, String> {
    serde_cbor::from_slice(bytes).map_err(|e| format!("ipc cbor decode failed: {}", e))
}

/// 读取一个 CBOR 帧（长度前缀 + payload）
pub async fn read_one_frame<R>(mut r: R) -> Result<Vec<u8>, String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;

    // 读取长度前缀（4 bytes, little-endian）
    let mut len_bytes = [0u8; 4];
    r.read_exact(&mut len_bytes)
        .await
        .map_err(|e| format!("ipc read frame length failed: {}", e))?;

    let len = u32::from_le_bytes(len_bytes) as usize;

    // 限制最大帧大小（64MB）
    if len > 64 * 1024 * 1024 {
        return Err(format!("ipc frame too large: {} bytes (max 64MB)", len));
    }

    // 读取 payload
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)
        .await
        .map_err(|e| format!("ipc read frame payload failed: {}", e))?;

    Ok(payload)
}

pub async fn write_all<W>(mut w: W, bytes: &[u8]) -> Result<(), String>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::AsyncWriteExt;
    w.write_all(bytes)
        .await
        .map_err(|e| format!("ipc write failed: {}", e))?;
    w.flush()
        .await
        .map_err(|e| format!("ipc flush failed: {}", e))?;
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn windows_pipe_name() -> &'static str {
    r"\\.\pipe\kabegame-daemon"
}

/// daemon IPC 使用的 Unix socket 文件名（路径在桌面为 temp_dir/Kabegame，此处仅文件名）
#[cfg(any(target_os = "linux", target_os = "macos"))]
const DAEMON_SOCKET_NAME: &str = "kabegame.sock";

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub fn unix_socket_path() -> std::path::PathBuf {
    std::env::temp_dir()
        .join("Kabegame")
        .join(DAEMON_SOCKET_NAME)
}

#[cfg(feature = "ipc-client")]
/// 客户端：发送一次请求并等待响应。
pub async fn request(req: IpcRequest) -> Result<IpcResponse, String> {
    #[cfg(target_os = "windows")]
    {
        use tokio::net::windows::named_pipe::ClientOptions;

        let mut client = ClientOptions::new()
            .open(windows_pipe_name())
            .map_err(|e| format!("ipc open pipe failed: {}", e))?;

        let bytes = encode_frame(&req)?;
        write_all(&mut client, &bytes).await?;
        let payload = read_one_frame(&mut client).await?;
        let resp: IpcResponse = decode_frame(&payload)?;
        return Ok(resp);
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        use tokio::net::UnixStream;
        let path = unix_socket_path();
        let mut s = UnixStream::connect(&path)
            .await
            .map_err(|e| format!("ipc connect failed ({}): {}", path.display(), e))?;
        let bytes = encode_frame(&req)?;
        write_all(&mut s, &bytes).await?;
        let payload = read_one_frame(&mut s).await?;
        let resp: IpcResponse = decode_frame(&payload)?;
        return Ok(resp);
    }

    return Err("ipc request failed: not supported platform".to_string());
}
