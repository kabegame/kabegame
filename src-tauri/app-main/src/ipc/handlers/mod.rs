//! 命令处理器模块
//!
//! 将不同类型的 IPC 请求分发到对应的处理器

pub mod events;
pub mod gallery;
pub mod plugin;
pub mod settings;
pub mod storage;

use kabegame_core::crawler::{CrawlTaskRequest, TaskScheduler};
use kabegame_core::emitter::GlobalEmitter;
use kabegame_core::ipc::ipc::{CliIpcRequest, CliIpcResponse};
#[cfg(not(target_os = "android"))]
use kabegame_core::ipc::server::EventBroadcaster;
use kabegame_core::plugin::PluginManager;
use kabegame_core::settings::Settings;
#[cfg(not(target_os = "android"))]
use kabegame_core::storage::organize::OrganizeService;
use kabegame_core::storage::tasks::TaskInfo;
use kabegame_core::storage::Storage;
#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
use kabegame_core::virtual_driver::VirtualDriveService;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

/// 分发 IPC 请求到对应的处理器（app_handle 由 start_ipc_server 传入，仅需发事件的请求使用）
pub async fn dispatch_request(req: CliIpcRequest, app_handle: AppHandle) -> CliIpcResponse {
    // 获取s tatus
    if matches!(req, CliIpcRequest::Status) {
        return handle_status();
    }

    if matches!(req, CliIpcRequest::AppShowWindow) {
        return handle_app_show_window(app_handle).await;
    }

    if let CliIpcRequest::AppImportPlugin { kgpg_path } = req {
        return handle_app_import_plugin(kgpg_path, app_handle).await;
    }

    // PluginRun：daemon 侧实现（入队执行）
    if let CliIpcRequest::PluginRun {
        plugin,
        output_dir,
        task_id,
        output_album_id,
        plugin_args,
        http_headers,
    } = req
    {
        return handle_plugin_run(
            plugin,
            output_dir,
            task_id,
            output_album_id,
            plugin_args,
            http_headers,
        )
        .await;
    }

    // TaskStart / TaskCancel：daemon 侧调度
    if let CliIpcRequest::TaskStart { task } = req {
        return handle_task_start(task).await;
    }
    if let CliIpcRequest::TaskCancel { task_id } = req {
        return handle_task_cancel(task_id).await;
    }
    if let CliIpcRequest::TaskRetryFailedImage { failed_id } = req {
        return handle_task_retry_failed_image(failed_id).await;
    }
    if let CliIpcRequest::TaskDeleteFailedImage { failed_id } = req {
        return handle_task_delete_failed_image(failed_id).await;
    }
    if matches!(req, CliIpcRequest::GetActiveDownloads) {
        return handle_get_active_downloads().await;
    }
    if let CliIpcRequest::OrganizeStart {
        dedupe,
        remove_missing,
        regen_thumbnails,
    } = req
    {
        return handle_organize_start(dedupe, remove_missing, regen_thumbnails).await;
    }
    if matches!(req, CliIpcRequest::OrganizeCancel) {
        return handle_organize_cancel().await;
    }

    // 尝试各个处理器
    if let Some(resp) = storage::handle_storage_request(&req).await {
        return resp;
    }

    if let Some(resp) = plugin::handle_plugin_request(&req).await {
        return resp;
    }

    if let Some(resp) = settings::handle_settings_request(&req).await {
        return resp;
    }

    if let Some(resp) = events::handle_events_request(&req).await {
        return resp;
    }

    if let Some(resp) = gallery::handle_gallery_request(&req).await {
        return resp;
    }
    #[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
    {
        if matches!(req, CliIpcRequest::VdMount) {
            return handle_vd_mount().await;
        }
        if matches!(req, CliIpcRequest::VdUnmount) {
            return handle_vd_unmount().await;
        }
        if matches!(req, CliIpcRequest::VdStatus) {
            return handle_vd_status().await;
        }
    }

    // 未知请求
    CliIpcResponse::err(format!("Unknown request: {:?}", req))
}

async fn handle_task_start(task: serde_json::Value) -> CliIpcResponse {
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
        run_config_id: t.run_config_id.clone(),
        trigger_source: t.trigger_source.clone(),
    };

    if let Err(e) = TaskScheduler::global().enqueue(req) {
        return CliIpcResponse::err(e);
    }

    let mut resp = CliIpcResponse::ok("queued");
    resp.task_id = Some(t.id);
    resp
}

async fn handle_task_cancel(task_id: String) -> CliIpcResponse {
    TaskScheduler::global().cancel_task(&task_id).await;
    #[cfg(not(target_os = "android"))]
    crate::commands::crawl_exit_with_status("canceled", Some(&task_id)).await;
    CliIpcResponse::ok("ok")
}

async fn handle_task_retry_failed_image(failed_id: i64) -> CliIpcResponse {
    match TaskScheduler::global().retry_failed_image(failed_id).await {
        Ok(()) => CliIpcResponse::ok("ok"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn handle_task_delete_failed_image(failed_id: i64) -> CliIpcResponse {
    let storage = Storage::global();
    let task_id = match storage.get_task_failed_image_by_id(failed_id) {
        Ok(item) => item.map(|item| item.task_id),
        Err(e) => return CliIpcResponse::err(e),
    };
    match storage.delete_task_failed_image(failed_id) {
        Ok(()) => {
            if let Some(task_id) = task_id {
                GlobalEmitter::global().emit_failed_image_removed(&task_id, failed_id);
            }
            CliIpcResponse::ok("ok")
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn handle_get_active_downloads() -> CliIpcResponse {
    match TaskScheduler::global().get_active_downloads().await {
        Ok(downloads) => {
            CliIpcResponse::ok_with_data("ok", serde_json::to_value(downloads).unwrap_or_default())
        }
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn handle_organize_start(
    dedupe: bool,
    remove_missing: bool,
    regen_thumbnails: bool,
) -> CliIpcResponse {
    use kabegame_core::storage::organize::OrganizeOptions;
    match OrganizeService::global()
        .clone()
        .start(
            Arc::new(Storage::global().clone()),
            OrganizeOptions {
                dedupe,
                remove_missing,
                regen_thumbnails,
            },
        )
        .await
    {
        Ok(()) => CliIpcResponse::ok("ok"),
        Err(e) => CliIpcResponse::err(e),
    }
}

async fn handle_organize_cancel() -> CliIpcResponse {
    match OrganizeService::global().cancel() {
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
    http_headers: Option<std::collections::HashMap<String, String>>,
) -> CliIpcResponse {
    // resolve plugin：支持 id 或 .kgpg 路径
    let plugin_manager = PluginManager::global();
    let (plugin_obj, plugin_file_path, var_defs) =
        match plugin_manager.resolve_plugin_for_cli_run(&plugin).await {
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
                http_headers: http_headers.clone(),
                output_album_id: output_album_id.clone(),
                run_config_id: None,
                trigger_source: "manual".to_string(),
                status: "pending".to_string(),
                progress: 0.0,
                deleted_count: 0,
                dedup_count: 0,
                success_count: 0,
                failed_count: 0,
                start_time: None,
                end_time: None,
                error: None,
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
        http_headers,
        output_album_id,
        plugin_file_path: plugin_file_path.map(|p| p.to_string_lossy().to_string()),
        run_config_id: None,
        trigger_source: "manual".to_string(),
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
            "string" | "date" => Ok(serde_json::Value::String(raw.trim().to_string())),
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
                            VarOption::Item { name, variable, .. } => {
                                let name_matches = name.values().any(|v| v.as_str() == raw_trim);
                                if name_matches || variable == raw_trim {
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

async fn handle_app_show_window(app_handle: AppHandle) -> CliIpcResponse {
    match crate::startup::ensure_main_window(app_handle.clone()) {
        Ok(()) => {
            let _ = app_handle.emit("app-show-window", ());
            CliIpcResponse::ok("window-shown")
        }
        Err(e) => CliIpcResponse::err(format!("显示窗口失败: {}", e)),
    }
}

async fn handle_app_import_plugin(kgpg_path: String, app_handle: AppHandle) -> CliIpcResponse {
    let path = std::path::PathBuf::from(&kgpg_path);
    if !path.is_file() {
        return CliIpcResponse::err(format!("File not found: {}", kgpg_path));
    }
    if path.extension().and_then(|s| s.to_str()) != Some("kgpg") {
        return CliIpcResponse::err(format!("Not a .kgpg file: {}", kgpg_path));
    }

    let _ = app_handle.emit(
        "app-import-plugin",
        serde_json::json!({
            "kgpgPath": kgpg_path
        }),
    );

    CliIpcResponse::ok("import-request-sent")
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
            "virtualDrive": cfg!(all(not(kabegame_mode = "light"), not(target_os = "android")))
        }
    }));
    resp
}

#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
async fn handle_vd_mount() -> CliIpcResponse {
    use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;

    if !cfg!(all(
        not(kabegame_mode = "light"),
        not(target_os = "android"),
        target_os = "windows"
    )) {
        return CliIpcResponse::err("Virtual drive is not available".to_string());
    }

    let path = Settings::global()
        .get_album_drive_mount_point()
        .await
        .unwrap_or_default();

    let vd_service = VirtualDriveService::global().clone();

    // 检查是否已挂载（幂等处理）
    if vd_service.current_mount_point().is_some() {
        return CliIpcResponse::ok("Already mounted");
    }

    // 执行挂载（使用 spawn_blocking 避免阻塞 tokio worker）
    let mount_result = match tokio::task::spawn_blocking({
        let vd_service = vd_service.clone();
        let path = path.clone();
        move || vd_service.mount(path.as_str())
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

#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
async fn handle_vd_unmount() -> CliIpcResponse {
    use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;

    if !cfg!(all(
        not(kabegame_mode = "light"),
        not(target_os = "android"),
        target_os = "windows"
    )) {
        return CliIpcResponse::err("Virtual drive is not available".to_string());
    }

    let vd_service = VirtualDriveService::global().clone();

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

#[cfg(all(not(kabegame_mode = "light"), not(target_os = "android")))]
async fn handle_vd_status() -> CliIpcResponse {
    let enabled = cfg!(all(
        not(kabegame_mode = "light"),
        not(target_os = "android"),
        target_os = "windows"
    ));
    let mut resp = CliIpcResponse::ok("ok");
    resp.info = Some(serde_json::json!({
        "status": if enabled { "ready" } else { "disabled" },
        "virtualDrive": enabled
    }));
    resp
}
