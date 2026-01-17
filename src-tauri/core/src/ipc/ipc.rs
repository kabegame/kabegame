//! CLI daemon IPC（跨平台）
//!
//! - Windows：命名管道（\\.\pipe\...）
//! - Unix：Unix domain socket（临时目录）
//! - 协议：单行 JSON（request/response 各一行）
//!
//! 设计目的：给 `kabegame-cli daemon` 提供一个轻量常驻后台入口，
//! 让外部（例如 KDE Plasma 壁纸插件）能触发“运行一次爬虫插件”并获取结果/状态。

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::broadcast;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase")]
pub enum CliIpcRequest {
    /// 探活
    Status,

    /// 虚拟盘：挂载（Windows + virtual-drive）
    VdMount {
        mount_point: String,
        #[serde(default)]
        no_wait: bool,
    },

    /// 虚拟盘：卸载（Windows + virtual-drive）
    VdUnmount { mount_point: String },

    /// 虚拟盘：状态（Windows + virtual-drive）
    VdStatus,

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
    },

    // ======== Storage 相关 ========
    /// 获取所有图片
    StorageGetImages,

    /// 分页获取图片
    StorageGetImagesPaginated { page: usize, page_size: usize },

    /// 获取图片总数
    StorageGetImagesCount,

    /// 根据 ID 获取图片
    StorageGetImageById { image_id: String },

    /// 根据本地路径查找图片（用于把“外部选择的壁纸路径”映射回 imageId）
    StorageFindImageByPath { path: String },

    // ==================== Wallpaper Engine Export ====================

    /// 导出选中的图片路径到 Wallpaper Engine Web 工程目录
    WeExportImagesToProject {
        image_paths: Vec<String>,
        title: Option<String>,
        output_parent_dir: String,
        /// 透传 options（由 daemon 反序列化为 WeExportOptions）
        options: Option<serde_json::Value>,
    },

    /// 导出画册到 Wallpaper Engine Web 工程目录
    WeExportAlbumToProject {
        album_id: String,
        album_name: String,
        output_parent_dir: String,
        options: Option<serde_json::Value>,
    },

    /// 删除图片
    StorageDeleteImage { image_id: String },

    /// 仅从数据库移除图片（不删除本地文件）
    StorageRemoveImage { image_id: String },

    /// 批量删除图片（删除本地文件 + DB）
    StorageBatchDeleteImages { image_ids: Vec<String> },

    /// 批量仅移除图片（仅 DB）
    StorageBatchRemoveImages { image_ids: Vec<String> },

    /// 收藏/取消收藏图片（收藏画册）
    StorageToggleImageFavorite { image_id: String, favorite: bool },

    /// 获取所有画册
    StorageGetAlbums,

    /// 添加画册
    StorageAddAlbum { name: String },

    /// 删除画册
    StorageDeleteAlbum { album_id: String },

    /// 重命名画册
    StorageRenameAlbum { album_id: String, new_name: String },

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
    StorageGetAlbumImages { album_id: String },

    /// 获取画册预览图片（前 N 张）
    StorageGetAlbumPreview { album_id: String, limit: usize },

    /// 获取各画册图片数量（用于侧边栏/列表徽标）
    StorageGetAlbumCounts,

    /// 更新画册内图片排序
    StorageUpdateAlbumImagesOrder {
        album_id: String,
        image_orders: Vec<(String, i64)>,
    },

    /// 获取画册图片 ID 列表
    StorageGetAlbumImageIds { album_id: String },

    /// 获取所有任务
    StorageGetAllTasks,

    /// 根据 ID 获取任务
    StorageGetTask { task_id: String },

    /// 添加任务
    StorageAddTask { task: serde_json::Value },

    /// 更新任务
    StorageUpdateTask { task: serde_json::Value },

    /// 删除任务
    StorageDeleteTask { task_id: String },

    /// 获取任务图片
    StorageGetTaskImages { task_id: String },

    /// 获取任务图片 id 列表
    StorageGetTaskImageIds { task_id: String },

    /// 获取任务图片分页
    StorageGetTaskImagesPaginated {
        task_id: String,
        offset: usize,
        limit: usize,
    },

    /// 获取任务失败图片
    StorageGetTaskFailedImages { task_id: String },

    /// 确认（已读）任务 Rhai dump
    StorageConfirmTaskRhaiDump { task_id: String },

    /// 清除所有已完成/失败/取消的任务
    StorageClearFinishedTasks,

    /// 获取运行配置列表
    StorageGetRunConfigs,

    /// 添加运行配置
    StorageAddRunConfig { config: serde_json::Value },

    /// 更新运行配置
    StorageUpdateRunConfig { config: serde_json::Value },

    /// 删除运行配置
    StorageDeleteRunConfig { config_id: String },

    // ======== Storage - Gallery Query Helpers（供 app-main 组装画廊虚拟路径）========
    /// 获取“按时间”分组（yearMonth 列表）
    StorageGetGalleryDateGroups,

    /// 获取“按插件”分组（pluginId 列表）
    StorageGetGalleryPluginGroups,

    /// 获取“按任务”分组（只返回包含图片的任务）
    StorageGetTasksWithImages,

    /// 按 query 统计图片数量
    StorageGetImagesCountByQuery { query: serde_json::Value },

    /// 按 query 获取图片范围
    StorageGetImagesRangeByQuery {
        query: serde_json::Value,
        offset: usize,
        limit: usize,
    },

    // ======== Task 调度（daemon 侧）========
    /// 入队一个任务（daemon 负责落库幂等 + 入队执行）
    TaskStart { task: serde_json::Value },

    /// 取消任务
    TaskCancel { task_id: String },

    /// 重试一条失败图片下载（task_failed_images.id）
    TaskRetryFailedImage { failed_id: i64 },

    /// 获取正在下载的任务列表
    GetActiveDownloads,

    // ======== Dedupe（daemon 侧）========
    /// 启动“分批按 hash 去重”
    DedupeStartGalleryByHashBatched {
        delete_files: bool,
        #[serde(default)]
        batch_size: Option<usize>,
    },

    /// 取消“分批按 hash 去重”
    DedupeCancelGalleryByHashBatched,

    // ======== Plugin 相关 ========
    /// 获取已安装插件列表
    PluginGetPlugins,

    /// 获取插件详情
    PluginGetDetail { plugin_id: String },

    /// 删除插件
    PluginDelete { plugin_id: String },

    /// 导入插件
    PluginImport { kgpg_path: String },

    /// 获取插件变量定义
    PluginGetVars { plugin_id: String },

    /// 获取浏览器插件列表
    PluginGetBrowserPlugins,

    /// 获取插件源列表
    PluginGetPluginSources,

    /// 验证插件源 index.json
    PluginValidateSource { index_url: String },

    /// 保存插件源列表
    PluginSavePluginSources { sources: serde_json::Value },

    /// 安装浏览器插件（从商店下载并安装）
    PluginInstallBrowserPlugin { plugin_id: String },

    /// 获取商店插件列表（可选指定 source_id）
    PluginGetStorePlugins {
        #[serde(default)]
        source_id: Option<String>,
        #[serde(default)]
        force_refresh: bool,
    },

    /// 统一插件详情入口（本地已安装 or 远程商店源）
    PluginGetDetailForUi {
        plugin_id: String,
        #[serde(default)]
        download_url: Option<String>,
        #[serde(default)]
        sha256: Option<String>,
        #[serde(default)]
        size_bytes: Option<u64>,
    },

    /// 预览导入插件（读取 .kgpg）
    PluginPreviewImport { zip_path: String },

    /// 商店安装预览：下载到临时文件 + preview_import_from_zip
    PluginPreviewStoreInstall {
        download_url: String,
        #[serde(default)]
        sha256: Option<String>,
        #[serde(default)]
        size_bytes: Option<u64>,
    },

    /// 获取已安装插件 icon（base64）
    PluginGetIcon { plugin_id: String },

    /// KGPG v2：远程获取 icon（base64）
    PluginGetRemoteIconV2 { download_url: String },

    /// 详情页文档图片：本地已安装/远程商店源统一入口（base64）
    PluginGetImageForDetail {
        plugin_id: String,
        image_path: String,
        #[serde(default)]
        download_url: Option<String>,
        #[serde(default)]
        sha256: Option<String>,
        #[serde(default)]
        size_bytes: Option<u64>,
    },

    // ======== Settings 相关 ========
    /// 获取所有设置
    SettingsGet,

    /// 获取单个设置
    SettingsGetKey { key: String },

    /// 更新设置
    SettingsUpdate { settings: serde_json::Value },

    /// 更新单个设置
    SettingsUpdateKey {
        key: String,
        value: serde_json::Value,
    },

    // ======== Settings 专用（保留 core::Settings 的校验逻辑）========
    SettingsSetGalleryImageAspectRatio { aspect_ratio: Option<String> },
    SettingsSetWallpaperEngineDir { dir: Option<String> },
    SettingsGetWallpaperEngineMyprojectsDir,
    SettingsSetWallpaperRotationEnabled { enabled: bool },
    SettingsSetWallpaperRotationAlbumId { album_id: Option<String> },
    SettingsSetWallpaperRotationTransition { transition: String },
    SettingsSetWallpaperStyle { style: String },
    SettingsSetWallpaperMode { mode: String },
    SettingsSetAlbumDriveEnabled { enabled: bool },
    SettingsSetAlbumDriveMountPoint { mount_point: String },
    SettingsSetAutoLaunch { enabled: bool },
    SettingsSetMaxConcurrentDownloads { count: u32 },
    SettingsSetNetworkRetryCount { count: u32 },
    SettingsSetImageClickAction { action: String },
    SettingsSetGalleryImageAspectRatioMatchWindow { enabled: bool },
    SettingsSetAutoDeduplicate { enabled: bool },
    SettingsSetDefaultDownloadDir { dir: Option<String> },
    SettingsSetWallpaperRotationIntervalMinutes { minutes: u32 },
    SettingsSetWallpaperRotationMode { mode: String },
    SettingsSetCurrentWallpaperImageId { image_id: Option<String> },
    SettingsSwapStyleTransitionForModeSwitch { old_mode: String, new_mode: String },

    // ======== Gallery / Provider 相关 ========
    /// 浏览虚拟 Provider 路径（用于 Gallery/Album/Task 视图的虚拟目录树）
    GalleryBrowseProvider { path: String },

    // ======== 事件订阅 ========
    /// 订阅事件（建立长连接，服务器会持续推送事件）
    SubscribeEvents,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliIpcResponse {
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
    pub mounted: Option<bool>,

    /// 对 VD：当前挂载点
    #[serde(default)]
    pub mount_point: Option<String>,

    /// 对 Status：daemon 版本/能力信息（可选，后续扩展）
    #[serde(default)]
    pub info: Option<serde_json::Value>,

    /// 通用数据载荷（用于返回 Storage/Plugin/Settings 查询结果）
    /// 可以是：图片列表、画册列表、任务列表、插件列表、设置对象等
    #[serde(default)]
    pub data: Option<serde_json::Value>,

}

impl CliIpcResponse {
    pub fn ok(message: impl Into<String>) -> Self {
        Self {
            ok: true,
            message: Some(message.into()),
            request_id: None,
            task_id: None,
            mounted: None,
            mount_point: None,
            info: None,
            data: None,
        }
    }

    pub fn err(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            message: Some(message.into()),
            request_id: None,
            task_id: None,
            mounted: None,
            mount_point: None,
            info: None,
            data: None,
        }
    }

    pub fn ok_with_data(message: impl Into<String>, data: serde_json::Value) -> Self {
        Self {
            ok: true,
            message: Some(message.into()),
            request_id: None,
            task_id: None,
            mounted: None,
            mount_point: None,
            info: None,
            data: Some(data),
        }
    }

}

pub(crate) fn encode_line<T: Serialize>(v: &T) -> Result<Vec<u8>, String> {
    let mut s = serde_json::to_string(v).map_err(|e| format!("ipc json encode failed: {}", e))?;
    s.push('\n');
    Ok(s.into_bytes())
}

pub(crate) fn decode_line<T: for<'de> Deserialize<'de>>(line: &str) -> Result<T, String> {
    serde_json::from_str(line).map_err(|e| format!("ipc json decode failed: {}", e))
}

pub(crate) async fn read_one_line<R>(mut r: R) -> Result<String, String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;
    let mut buf = Vec::with_capacity(1024);
    let mut tmp = [0u8; 1];
    loop {
        let n = r
            .read(&mut tmp)
            .await
            .map_err(|e| format!("ipc read failed: {}", e))?;
        if n == 0 {
            break;
        }
        if tmp[0] == b'\n' {
            break;
        }
        buf.push(tmp[0]);
        if buf.len() > 256 * 1024 {
            return Err("ipc line too long".to_string());
        }
    }
    Ok(String::from_utf8_lossy(&buf).to_string())
}

pub(crate) async fn write_all<W>(mut w: W, bytes: &[u8]) -> Result<(), String>
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
pub(crate) fn windows_pipe_name() -> &'static str {
    r"\\.\pipe\kabegame-cli"
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn unix_socket_path() -> std::path::PathBuf {
    std::env::temp_dir().join("kabegame-cli.sock")
}

/// 客户端：发送一次请求并等待响应。
pub async fn request(req: CliIpcRequest) -> Result<CliIpcResponse, String> {
    #[cfg(target_os = "windows")]
    {
        use tokio::net::windows::named_pipe::ClientOptions;

        let mut client = ClientOptions::new()
            .open(windows_pipe_name())
            .map_err(|e| format!("ipc open pipe failed: {}", e))?;

        let bytes = encode_line(&req)?;
        write_all(&mut client, &bytes).await?;
        let line = read_one_line(&mut client).await?;
        let resp: CliIpcResponse = decode_line(&line)?;
        return Ok(resp);
    }

    #[cfg(not(target_os = "windows"))]
    {
        use tokio::net::UnixStream;
        let path = unix_socket_path();
        let mut s = UnixStream::connect(&path)
            .await
            .map_err(|e| format!("ipc connect failed ({}): {}", path.display(), e))?;
        let bytes = encode_line(&req)?;
        write_all(&mut s, &bytes).await?;
        let line = read_one_line(&mut s).await?;
        let resp: CliIpcResponse = decode_line(&line)?;
        return Ok(resp);
    }
}

/// 服务端：循环处理请求（每个连接只处理一次 request/response）。
/// 
/// 对于 `SubscribeEvents` 请求，需要额外提供一个 `EventBroadcaster` 来推送事件。
pub async fn serve<F, Fut>(handler: F) -> Result<(), String>
where
    F: Fn(CliIpcRequest) -> Fut + Send + Sync + Clone + 'static,
    Fut: std::future::Future<Output = CliIpcResponse> + Send,
{
    // 注意：此函数不支持长连接事件推送
    // 如需支持 SubscribeEvents，请使用 `serve_with_events`
    serve_impl(handler, None).await
}

/// 服务端：循环处理请求，支持长连接事件推送
pub async fn serve_with_events<F, Fut>(
    handler: F,
    broadcaster: Option<Arc<dyn std::any::Any + Send + Sync>>,
) -> Result<(), String>
where
    F: Fn(CliIpcRequest) -> Fut + Send + Sync + Clone + 'static,
    Fut: std::future::Future<Output = CliIpcResponse> + Send,
{
    serve_impl(handler, broadcaster).await
}

async fn serve_impl<F, Fut>(
    handler: F,
    broadcaster: Option<Arc<dyn std::any::Any + Send + Sync>>,
) -> Result<(), String>
where
    F: Fn(CliIpcRequest) -> Fut + Send + Sync + Clone + 'static,
    Fut: std::future::Future<Output = CliIpcResponse> + Send,
{
    #[cfg(target_os = "windows")]
    {
        use tokio::net::windows::named_pipe::ServerOptions;
        use windows_sys::Win32::Foundation::{LocalFree, BOOL};
        use windows_sys::Win32::Security::{
            Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW, SECURITY_ATTRIBUTES,
        };

        fn sddl_to_security_attributes(
            sddl: &str,
        ) -> Result<(SECURITY_ATTRIBUTES, *mut core::ffi::c_void), String> {
            use std::ffi::OsStr;
            use std::os::windows::ffi::OsStrExt;

            let sddl_w: Vec<u16> = OsStr::new(sddl).encode_wide().chain(Some(0)).collect();
            let mut sd_ptr: *mut core::ffi::c_void = core::ptr::null_mut();
            let mut sd_len: u32 = 0;

            let ok: BOOL = unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl_w.as_ptr(),
                    1,
                    &mut sd_ptr as *mut _ as *mut _,
                    &mut sd_len,
                )
            };
            if ok == 0 || sd_ptr.is_null() {
                return Err(format!(
                    "ConvertStringSecurityDescriptorToSecurityDescriptorW failed: {}",
                    std::io::Error::last_os_error()
                ));
            }

            let attrs = SECURITY_ATTRIBUTES {
                nLength: core::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: sd_ptr as *mut _,
                bInheritHandle: 0,
            };
            Ok((attrs, sd_ptr))
        }

        fn create_secure_server(
        ) -> Result<tokio::net::windows::named_pipe::NamedPipeServer, String> {
            // SY=LocalSystem, BA=Built-in Administrators, AU=Authenticated Users
            // 允许普通用户连接（仅本机 pipe）
            let sddl = "D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;AU)";
            let (attrs, sd_ptr) = sddl_to_security_attributes(sddl)?;
            let server = unsafe {
                ServerOptions::new().create_with_security_attributes_raw(
                    windows_pipe_name(),
                    &attrs as *const _ as *mut _,
                )
            }
            .map_err(|e| format!("ipc create pipe failed: {}", e))?;

            unsafe { LocalFree(sd_ptr as _) };
            Ok(server)
        }

        let mut server = create_secure_server()?;
        loop {
            server
                .connect()
                .await
                .map_err(|e| format!("ipc pipe connect failed: {}", e))?;

            let connected = server;
            server = create_secure_server()?;

            let mut connected = connected;
            let line = match read_one_line(&mut connected).await {
                Ok(line) => {
                    eprintln!("[DEBUG] IPC 服务器读取请求成功: {}", line);
                    line
                },
                Err(e) => {
                    eprintln!("[DEBUG] IPC 服务器读取请求失败: {}", e);
                    continue;
                }
            };
            let req: CliIpcRequest = match decode_line(&line) {
                Ok(req) => {
                    eprintln!("[DEBUG] IPC 服务器解析请求成功: {:?}", req);
                    req
                },
                Err(e) => {
                    eprintln!("[DEBUG] IPC 服务器解析请求失败: {}", e);
                    continue;
                }
            };
            
            // 检查是否是 SubscribeEvents 请求（需要长连接）
            if matches!(req, CliIpcRequest::SubscribeEvents) {
                eprintln!("[DEBUG] IPC 服务器接受新连接（SubscribeEvents 长连接）");
                eprintln!("[DEBUG] IPC 服务器收到 SubscribeEvents 请求，准备建立长连接");
                // 对于 SubscribeEvents，需要特殊处理
                // 先调用 handler 获取初始响应
                let resp = handler(req).await;
                let bytes = match encode_line(&resp) {
                    Ok(bytes) => bytes,
                    Err(e) => {
                        eprintln!("[DEBUG] IPC 服务器编码响应失败: {}", e);
                        continue;
                    }
                };
                if let Err(e) = write_all(&mut connected, &bytes).await {
                    eprintln!("[DEBUG] IPC 服务器写入响应失败: {}", e);
                    continue;
                }
                eprintln!("[DEBUG] IPC 服务器已发送 SubscribeEvents 响应，开始推送事件");
                
                // 如果有 broadcaster，启动事件推送任务
                if let Some(broadcaster) = &broadcaster {
                    if let Ok(broadcaster) = broadcaster.clone().downcast::<super::EventBroadcaster>() {
                        let mut rx = broadcaster.subscribe();
                        eprintln!("[DEBUG] IPC 服务器已订阅 EventBroadcaster，开始监听事件");
                        // Spawn 任务持续推送事件到连接
                        tokio::spawn(async move {
                            use tokio::io::AsyncWriteExt;
                            let mut stream = connected;
                            loop {
                                match rx.recv().await {
                                    Ok((id, event)) => {
                                        eprintln!("[DEBUG] IPC 服务器收到事件: id={}, event={:?}", id, event);
                                        // 序列化事件为 JSON
                                        match serde_json::to_string(&event) {
                                            Ok(json) => {
                                                eprintln!("[DEBUG] IPC 服务器序列化事件成功: {}", json);
                                                let line = format!("{}\n", json);
                                                if let Err(e) = stream.write_all(line.as_bytes()).await {
                                                    eprintln!("[DEBUG] IPC 服务器写入事件失败: {}", e);
                                                    break;
                                                }
                                                if let Err(e) = stream.flush().await {
                                                    eprintln!("[DEBUG] IPC 服务器刷新流失败: {}", e);
                                                    break;
                                                }
                                                eprintln!("[DEBUG] IPC 服务器已推送事件到连接: id={}", id);
                                            },
                                            Err(e) => {
                                                eprintln!("[DEBUG] IPC 服务器序列化事件失败: {}", e);
                                                // 继续处理下一个事件
                                            }
                                        }
                                    },
                                    Err(broadcast::error::RecvError::Closed) => {
                                        eprintln!("[DEBUG] IPC 服务器 EventBroadcaster channel 已关闭");
                                        break;
                                    },
                                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                                        eprintln!("[DEBUG] IPC 服务器事件接收滞后: {} 个事件被跳过", skipped);
                                        // 继续接收
                                    }
                                }
                            }
                        });
                        // 连接由 spawn 的任务持有，不在这里关闭
                        continue;
                    }
                }
                
                // 如果没有 broadcaster，保持连接打开但不推送事件
                continue;
            }
            
            // 普通请求：处理并关闭连接
            let resp = handler(req).await;
            let bytes = encode_line(&resp)?;
            eprintln!("[DEBUG] IPC 服务器发送响应（Windows Named Pipe）");
            let _ = write_all(&mut connected, &bytes).await;
        }
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        use tokio::net::UnixListener;
        use tokio::io::BufReader;
        use tokio::io::AsyncBufReadExt;
        
        let path = unix_socket_path();
        let _ = std::fs::remove_file(&path);
        let listener =
            UnixListener::bind(&path).map_err(|e| format!("ipc bind failed ({}): {}", path.display(), e))?;

        loop {
            let (stream, _) = listener
                .accept()
                .await
                .map_err(|e| format!("ipc accept failed: {}", e))?;
            
            eprintln!("[DEBUG] IPC 服务器接受新连接（持久连接模式）");
            
            // 为每个连接 spawn 一个任务来处理多个请求
            let handler = handler.clone();
            let broadcaster = broadcaster.clone();
            
            tokio::spawn(async move {
                use tokio::io::AsyncWriteExt;
                
                let (read_half, mut write_half) = tokio::io::split(stream);
                let mut reader = BufReader::new(read_half);
                let mut line = String::new();
                
                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) => {
                            eprintln!("[DEBUG] IPC 服务器连接关闭 (EOF)");
                            break;
                        }
                        Ok(_) => {
                            let line_trimmed = line.trim();
                            if line_trimmed.is_empty() {
                                continue;
                            }
                            
                            eprintln!("[DEBUG] IPC 服务器读取请求: {}", line_trimmed);
                            
                            // 解析为 JSON
                            let value: serde_json::Value = match serde_json::from_str(line_trimmed) {
                                Ok(v) => v,
                                Err(e) => {
                                    eprintln!("[DEBUG] IPC 服务器解析 JSON 失败: {}", e);
                                    continue;
                                }
                            };
                            
                            // 提取 request_id
                            let request_id = value.get("request_id").and_then(|v| v.as_u64());
                            
                            // 解析为 CliIpcRequest
                            let req: CliIpcRequest = match serde_json::from_value(value.clone()) {
                                Ok(req) => {
                                    eprintln!("[DEBUG] IPC 服务器解析请求: {:?}, request_id={:?}", req, request_id);
                                    req
                                },
                                Err(e) => {
                                    eprintln!("[DEBUG] IPC 服务器解析请求失败: {}", e);
                                    continue;
                                }
                            };
                            
                            // 检查是否是 SubscribeEvents 请求
                            if matches!(req, CliIpcRequest::SubscribeEvents) {
                                eprintln!("[DEBUG] IPC 服务器收到 SubscribeEvents 请求");
                                
                                // 发送初始响应
                                let mut resp = handler(req).await;
                                resp.request_id = request_id;
                                
                                let bytes = match encode_line(&resp) {
                                    Ok(b) => b,
                                    Err(e) => {
                                        eprintln!("[DEBUG] IPC 服务器编码响应失败: {}", e);
                                        break;
                                    }
                                };
                                
                                if let Err(e) = write_half.write_all(&bytes).await {
                                    eprintln!("[DEBUG] IPC 服务器写入响应失败: {}", e);
                                    break;
                                }
                                let _ = write_half.flush().await;
                                
                                // 如果有 broadcaster，在这个连接上推送事件
                                if let Some(ref broadcaster) = broadcaster {
                                    if let Ok(broadcaster) = broadcaster.clone().downcast::<super::EventBroadcaster>() {
                                        let mut rx = broadcaster.subscribe();
                                        eprintln!("[DEBUG] IPC 服务器开始推送事件");
                                        
                                        loop {
                                            match rx.recv().await {
                                                Ok((id, event)) => {
                                                    match serde_json::to_string(&event) {
                                                        Ok(json) => {
                                                            let event_line = format!("{}\n", json);
                                                            if let Err(e) = write_half.write_all(event_line.as_bytes()).await {
                                                                eprintln!("[DEBUG] IPC 服务器写入事件失败: {}", e);
                                                                break;
                                                            }
                                                            let _ = write_half.flush().await;
                                                            eprintln!("[DEBUG] IPC 服务器已推送事件: id={}", id);
                                                        },
                                                        Err(e) => {
                                                            eprintln!("[DEBUG] IPC 服务器序列化事件失败: {}", e);
                                                        }
                                                    }
                                                },
                                                Err(broadcast::error::RecvError::Closed) => {
                                                    eprintln!("[DEBUG] IPC 服务器事件 channel 已关闭");
                                                    break;
                                                },
                                                Err(broadcast::error::RecvError::Lagged(n)) => {
                                                    eprintln!("[DEBUG] IPC 服务器事件滞后: {} 个被跳过", n);
                                                }
                                            }
                                        }
                                    }
                                }
                                break; // SubscribeEvents 后结束请求循环
                            }
                            
                            // 普通请求：处理并发送响应（保持连接）
                            let mut resp = handler(req).await;
                            resp.request_id = request_id;
                            
                            let bytes = match encode_line(&resp) {
                                Ok(b) => b,
                                Err(e) => {
                                    eprintln!("[DEBUG] IPC 服务器编码响应失败: {}", e);
                                    continue;
                                }
                            };
                            
                            if let Err(e) = write_half.write_all(&bytes).await {
                                eprintln!("[DEBUG] IPC 服务器写入响应失败: {}", e);
                                break;
                            }
                            if let Err(e) = write_half.flush().await {
                                eprintln!("[DEBUG] IPC 服务器刷新失败: {}", e);
                                break;
                            }
                            
                            eprintln!("[DEBUG] IPC 服务器已发送响应, request_id={:?}", request_id);
                        }
                        Err(e) => {
                            eprintln!("[DEBUG] IPC 服务器读取失败: {}", e);
                            break;
                        }
                    }
                }
                
                eprintln!("[DEBUG] IPC 服务器连接处理完成");
            });
        }
    }
}

