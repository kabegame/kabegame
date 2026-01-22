//! 命令处理器模块
//!
//! 将不同类型的 IPC 请求分发到对应的处理器

pub mod events;
pub mod gallery;
pub mod plugin;
pub mod settings;
pub mod storage;

use crate::dedupe_service::DedupeService;
use kabegame_core::crawler::{CrawlTaskRequest, TaskScheduler};
use kabegame_core::ipc::ipc::{CliIpcRequest, CliIpcResponse};
use kabegame_core::ipc::{EventBroadcaster, SubscriptionManager};
use kabegame_core::plugin::PluginManager;
use kabegame_core::settings::Settings;
use kabegame_core::storage::tasks::TaskInfo;
use kabegame_core::storage::Storage;
use kabegame_core::virtual_driver::VirtualDriveService;
use std::sync::Arc;

/// 全局状态
pub struct Store {
    // PluginManager 现在是全局单例，不再需要存储在这里
    // Storage 现在是全局单例，不再需要存储在这里
    // TaskScheduler 现在是全局单例，不再需要存储在这里
    pub broadcaster: Arc<EventBroadcaster>,
    pub subscription_manager: Arc<SubscriptionManager>,
    pub dedupe_service: Arc<DedupeService>,
    pub virtual_drive_service: Arc<VirtualDriveService>,
}

/// 分发 IPC 请求到对应的处理器
pub async fn dispatch_request(req: CliIpcRequest, ctx: Arc<Store>) -> CliIpcResponse {
    // 特殊请求：Status
    if matches!(req, CliIpcRequest::Status) {
        return handle_status();
    }

    // PluginRun：daemon 侧实现（入队执行）
    if let CliIpcRequest::PluginRun {
        plugin,
        output_dir,
        task_id,
        output_album_id,
        plugin_args,
    } = req
    {
        return handle_plugin_run(
            plugin,
            output_dir,
            task_id,
            output_album_id,
            plugin_args,
            ctx,
        )
        .await;
    }

    // TaskStart / TaskCancel：daemon 侧调度
    if let CliIpcRequest::TaskStart { task } = req {
        return handle_task_start(task, ctx).await;
    }
    if let CliIpcRequest::TaskCancel { task_id } = req {
        return handle_task_cancel(task_id, ctx).await;
    }
    if let CliIpcRequest::TaskRetryFailedImage { failed_id } = req {
        return handle_task_retry_failed_image(failed_id, ctx).await;
    }
    if matches!(req, CliIpcRequest::GetActiveDownloads) {
        return handle_get_active_downloads(ctx).await;
    }
    if let CliIpcRequest::DedupeStartGalleryByHashBatched {
        delete_files,
        batch_size,
    } = req
    {
        return handle_dedupe_start(delete_files, batch_size, ctx).await;
    }
    if matches!(req, CliIpcRequest::DedupeCancelGalleryByHashBatched) {
        return handle_dedupe_cancel(ctx).await;
    }

    // 尝试各个处理器
    if let Some(resp) = storage::handle_storage_request(&req, ctx.broadcaster.clone()).await {
        return resp;
    }

    if let Some(resp) = plugin::handle_plugin_request(&req).await {
        return resp;
    }

    if let Some(resp) = settings::handle_settings_request(&req, ctx.clone()).await {
        return resp;
    }

    if let Some(resp) = events::handle_events_request(&req).await {
        return resp;
    }

    if let Some(resp) = gallery::handle_gallery_request(&req).await {
        return resp;
    }

    if matches!(req, CliIpcRequest::VdMount) {
        return handle_vd_mount(ctx).await;
    }
    if matches!(req, CliIpcRequest::VdUnmount) {
        return handle_vd_unmount(ctx).await;
    }
    if matches!(req, CliIpcRequest::VdStatus) {
        return handle_vd_status(ctx).await;
    }

    // 未知请求
    CliIpcResponse::err(format!("Unknown request: {:?}", req))
}

async fn handle_task_start(task: serde_json::Value, _ctx: Arc<Store>) -> CliIpcResponse {
    let t: TaskInfo = match serde_json::from_value(task) {
        Ok(t) => t,
        Err(e) => return CliIpcResponse::err(format!("Invalid task data: {e}")),
    };

    // 确保任务在 DB 中存在（幂等）
    match Storage::global().get_task(&t.id) {
        Ok(Some(_)) => {}
        Ok(None) => {
            if let Err(e) = Storage::global().add_task(t.clone()) {
                return CliIpcResponse::err(e);
            }
        }
        Err(e) => return CliIpcResponse::err(e),
    }

    let req = CrawlTaskRequest {
        plugin_id: t.plugin_id.clone(),
        task_id: t.id.clone(),
        output_dir: t.output_dir.clone(),
        user_config: t.user_config.clone(),
        http_headers: t.http_headers.clone(),
        output_album_id: t.output_album_id.clone(),
        plugin_file_path: None,
    };

    if let Err(e) = TaskScheduler::global().enqueue(req) {
        return CliIpcResponse::err(e);
    }

    let mut resp = CliIpcResponse::ok("queued");
    resp.task_id = Some(t.id);
    resp
}

async fn handle_task_cancel(task_id: String, _ctx: Arc<Store>) -> CliIpcResponse {
    match TaskScheduler::global().cancel_task(&task_id) {
        Ok(()) => CliIpcResponse::ok("ok"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn handle_task_retry_failed_image(failed_id: i64, _ctx: Arc<Store>) -> CliIpcResponse {
    match TaskScheduler::global().retry_failed_image(failed_id) {
        Ok(()) => CliIpcResponse::ok("ok"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn handle_get_active_downloads(_ctx: Arc<Store>) -> CliIpcResponse {
    match TaskScheduler::global().get_active_downloads() {
        Ok(downloads) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(downloads).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn handle_dedupe_start(
    delete_files: bool,
    batch_size: Option<usize>,
    ctx: Arc<Store>,
) -> CliIpcResponse {
    let bs = batch_size.unwrap_or(10_000).max(1);
    match ctx
        .dedupe_service
        .clone()
        .start_batched(
            Arc::new(Storage::global().clone()),
            ctx.broadcaster.clone(),
            delete_files,
            bs,
        )
        .await
    {
        Ok(()) => CliIpcResponse::ok("ok"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn handle_dedupe_cancel(ctx: Arc<Store>) -> CliIpcResponse {
    match ctx.dedupe_service.cancel() {
        Ok(v) => CliIpcResponse::ok_with_data("ok", serde_json::Value::Bool(v)),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn handle_plugin_run(
    plugin: String,
    output_dir: Option<String>,
    task_id: Option<String>,
    output_album_id: Option<String>,
    plugin_args: Vec<String>,
    _ctx: Arc<Store>,
) -> CliIpcResponse {
    // resolve plugin：支持 id 或 .kgpg 路径
    let plugin_manager = PluginManager::global();
    let (plugin_obj, plugin_file_path, var_defs) =
        match plugin_manager.resolve_plugin_for_cli_run(&plugin) {
            Ok(x) => x,
            Err(e) => return CliIpcResponse::err(e),
        };

    // task_id：若未提供则生成
    let task_id = task_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // 解析 CLI plugin_args -> user_config（再由调度器用 var_defs 统一 normalize + 默认值合并）
    let user_cfg = match parse_plugin_args_to_user_config(&var_defs, &plugin_args) {
        Ok(m) => m,
        Err(e) => return CliIpcResponse::err(e),
    };
    let user_config = if user_cfg.is_empty() {
        None
    } else {
        Some(user_cfg)
    };

    // 确保任务在 DB 中存在（否则调度器的 update/persist 是 no-op）
    match Storage::global().get_task(&task_id) {
        Ok(Some(_)) => {}
        Ok(None) => {
            let t = TaskInfo {
                id: task_id.clone(),
                plugin_id: plugin_obj.id.clone(),
                output_dir: output_dir.clone(),
                user_config: user_config.clone(),
                http_headers: None,
                output_album_id: output_album_id.clone(),
                status: "pending".to_string(),
                progress: 0.0,
                deleted_count: 0,
                start_time: None,
                end_time: None,
                error: None,
                rhai_dump_present: false,
                rhai_dump_confirmed: false,
                rhai_dump_created_at: None,
            };
            if let Err(e) = Storage::global().add_task(t) {
                return CliIpcResponse::err(e);
            }
        }
        Err(e) => return CliIpcResponse::err(e),
    }

    // 入队执行
    let req = CrawlTaskRequest {
        plugin_id: plugin_obj.id,
        task_id: task_id.clone(),
        output_dir,
        user_config,
        http_headers: None,
        output_album_id,
        plugin_file_path: plugin_file_path.map(|p| p.to_string_lossy().to_string()),
    };

    if let Err(e) = TaskScheduler::global().enqueue(req) {
        return CliIpcResponse::err(e);
    }

    let mut resp = CliIpcResponse::ok("queued");
    resp.task_id = Some(task_id);
    resp
}

fn parse_plugin_args_to_user_config(
    var_defs: &[kabegame_core::plugin::VarDefinition],
    plugin_args: &[String],
) -> Result<std::collections::HashMap<String, serde_json::Value>, String> {
    use kabegame_core::plugin::{VarDefinition, VarOption};
    use std::collections::HashMap;

    fn parse_one(def: &VarDefinition, raw: &str) -> Result<serde_json::Value, String> {
        let t = def.var_type.trim().to_ascii_lowercase();
        match t.as_str() {
            "int" => raw
                .trim()
                .parse::<i64>()
                .map(serde_json::Value::from)
                .map_err(|e| format!("参数 {} 解析为 int 失败: {raw} ({e})", def.key)),
            "float" => raw
                .trim()
                .parse::<f64>()
                .ok()
                .and_then(serde_json::Number::from_f64)
                .map(serde_json::Value::Number)
                .ok_or_else(|| format!("参数 {} 解析为 float 失败: {raw}", def.key)),
            "boolean" => {
                let v = match raw.trim().to_ascii_lowercase().as_str() {
                    "1" | "true" | "yes" | "y" | "on" => true,
                    "0" | "false" | "no" | "n" | "off" => false,
                    _ => return Err(format!("参数 {} 解析为 boolean 失败: {raw}", def.key)),
                };
                Ok(serde_json::Value::Bool(v))
            }
            "list" => {
                // 约定：用逗号分隔（也兼容单个值）
                let items: Vec<serde_json::Value> = raw
                    .split(',')
                    .map(|s| serde_json::Value::String(s.trim().to_string()))
                    .filter(|s| !s.as_str().unwrap_or("").is_empty())
                    .collect();
                Ok(serde_json::Value::Array(items))
            }
            "options" => {
                // 直接接受 raw（variable/name 都行；normalize_var_value 会做进一步规范化）
                // 若提供了 options 列表，优先把 name 映射到 variable
                if let Some(opts) = def.options.as_ref() {
                    let raw_trim = raw.trim();
                    for o in opts {
                        match o {
                            VarOption::String(s) => {
                                if s == raw_trim {
                                    return Ok(serde_json::Value::String(raw_trim.to_string()));
                                }
                            }
                            VarOption::Item { name, variable } => {
                                if name == raw_trim || variable == raw_trim {
                                    return Ok(serde_json::Value::String(variable.clone()));
                                }
                            }
                        }
                    }
                }
                Ok(serde_json::Value::String(raw.trim().to_string()))
            }
            _ => Ok(serde_json::Value::String(raw.trim().to_string())),
        }
    }

    let mut out: HashMap<String, serde_json::Value> = HashMap::new();
    let mut next_positional = 0usize;

    for arg in plugin_args {
        let a = arg.trim();
        if a.is_empty() {
            continue;
        }

        // key=value / --key=value
        if let Some((k, v)) = a.split_once('=') {
            let key = k.trim_start_matches('-').trim();
            if key.is_empty() {
                return Err(format!("无效参数: {a}"));
            }
            let def = var_defs.iter().find(|d| d.key == key);
            if let Some(def) = def {
                out.insert(key.to_string(), parse_one(def, v)?);
            } else {
                // 未在 var_defs 中声明的键：允许直接注入
                out.insert(
                    key.to_string(),
                    serde_json::Value::String(v.trim().to_string()),
                );
            }
            continue;
        }

        // positional：按 var_defs 顺序填充
        let def = var_defs
            .get(next_positional)
            .ok_or_else(|| format!("多余的 positional 参数: {a}"))?;
        out.insert(def.key.clone(), parse_one(def, a)?);
        next_positional += 1;
    }

    Ok(out)
}

// TODO: 将此json结构体化
fn handle_status() -> CliIpcResponse {
    let mut resp = CliIpcResponse::ok("ok");
    resp.info = Some(serde_json::json!({
        "name": "kabegame-daemon",
        "version": env!("CARGO_PKG_VERSION"),
        "features": {
            "storage": true,
            "plugin": true,
            "settings": true,
            "events": true,
            "pluginRun": false,  // 暂未实现
            "virtualDrive": cfg!(all(feature="virtual-driver", target_os="windows"))
        }
    }));
    resp
}

async fn handle_vd_mount(ctx: Arc<Store>) -> CliIpcResponse {
    use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;

    let path = Settings::global()
        .get_album_drive_mount_point()
        .await
        .unwrap_or_default();

    let vd_service = ctx.virtual_drive_service.clone();

    // 检查是否已挂载（幂等处理）
    if vd_service.current_mount_point().is_some() {
        return CliIpcResponse::ok("Already mounted");
    }

    // 执行挂载（使用 spawn_blocking 避免阻塞 tokio worker）
    let mount_result = match tokio::task::spawn_blocking({
        let vd_service = vd_service.clone();
        let path = path.clone();
        move || vd_service.mount(path.as_str(), Storage::global().clone())
    })
    .await
    {
        Ok(result) => result,
        Err(e) => return CliIpcResponse::err(format!("Spawn blocking error: {}", e)),
    };

    match mount_result {
        Ok(()) => {
            // 挂载成功后，设置 enabled 为 true（会自动发送 SettingChange 事件）
            let settings = Settings::global();
            if let Err(e) = settings.set_album_drive_enabled(true).await {
                return CliIpcResponse::err(format!("Failed to set enabled: {}", e));
            }

            CliIpcResponse::ok("Mount successful")
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn handle_vd_unmount(ctx: Arc<Store>) -> CliIpcResponse {
    use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;

    let vd_service = ctx.virtual_drive_service.clone();

    // 检查是否已卸载（幂等处理）
    if vd_service.current_mount_point().is_none() {
        return CliIpcResponse::ok("Already unmounted");
    }

    // 执行卸载（使用 spawn_blocking 避免阻塞 tokio worker）
    let unmount_result = match tokio::task::spawn_blocking({
        let vd_service = vd_service.clone();
        move || vd_service.unmount()
    })
    .await
    {
        Ok(result) => result,
        Err(e) => return CliIpcResponse::err(format!("Spawn blocking error: {}", e)),
    };

    match unmount_result {
        Ok(true) => {
            // 卸载成功后，设置 enabled 为 false（会自动发送 SettingChange 事件）
            let settings = Settings::global();
            if let Err(e) = settings.set_album_drive_enabled(false).await {
                return CliIpcResponse::err(format!("Failed to set enabled: {}", e));
            }

            CliIpcResponse::ok("Unmount successful")
        }
        Ok(false) => {
            // 卸载失败但可能已经卸载，返回成功（幂等）
            CliIpcResponse::ok("Already unmounted")
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn handle_vd_status(_ctx: Arc<Store>) -> CliIpcResponse {
    let mut resp = CliIpcResponse::ok("ok");
    resp.info = Some(serde_json::json!({
        "status": "ready",
        "virtualDrive": true
    }));
    resp
}
