//! 命令处理器模块
//!
//! 将不同类型的 IPC 请求分发到对应的处理器

pub mod events;
pub mod gallery;
pub mod plugin;
pub mod settings;
pub mod storage;

use kabegame_core::crawler::TaskScheduler;
use kabegame_core::emitter::GlobalEmitter;
use kabegame_core::ipc::ipc::{IpcRequest, IpcResponse, IPC_PROTOCOL_VERSION};
use kabegame_core::settings::Settings;
#[cfg(not(target_os = "android"))]
use kabegame_core::storage::organize::OrganizeService;
use kabegame_core::storage::Storage;
#[cfg(feature = "standard")]
use kabegame_core::virtual_driver::VirtualDriveService;
use std::sync::Arc;
#[cfg(not(feature = "web"))]
use tauri::{AppHandle, Emitter, Runtime};

/// 分发 IPC 请求到对应的处理器（app_handle 由 start_ipc_server 传入，仅需发事件的请求使用）
///
/// Web 模式没有 Tauri runtime：`app_handle` 与 `R` 一起被 cfg 掉（与
/// `startup::start_ipc_server` 的签名一致）。
pub async fn dispatch_request<#[cfg(not(feature = "web"))] R: Runtime>(
    req: IpcRequest,
    #[cfg(not(feature = "web"))] app_handle: AppHandle<R>,
) -> IpcResponse {
    // 获取s tatus
    if matches!(req, IpcRequest::Status) {
        return handle_status();
    }

    #[cfg(not(feature = "web"))]
    if matches!(req, IpcRequest::AppShowWindow) {
        return handle_app_show_window(app_handle).await;
    }

    #[cfg(not(feature = "web"))]
    if let IpcRequest::AppImportPlugin { kgpg_path } = req {
        return handle_app_import_plugin(kgpg_path, app_handle).await;
    }

    if let IpcRequest::PluginRun { params } = req {
        return handle_plugin_run(params).await;
    }

    // TaskStart / TaskCancel：应用后端调度
    if let IpcRequest::TaskStart { params } = req {
        return handle_task_start(params).await;
    }
    if let IpcRequest::TaskCancel { task_id } = req {
        return handle_task_cancel(task_id).await;
    }
    if let IpcRequest::TaskRetryFailedImage { failed_id } = req {
        return handle_task_retry_failed_image(failed_id).await;
    }
    if let IpcRequest::TaskDeleteFailedImage { failed_id } = req {
        return handle_task_delete_failed_image(failed_id).await;
    }
    if matches!(req, IpcRequest::GetActiveDownloads) {
        return handle_get_active_downloads().await;
    }
    if let IpcRequest::OrganizeStart {
        dedupe,
        dedupe_keep_new,
        remove_missing,
        regen_thumbnails,
        remove_unrecognized,
        range_start,
        range_end,
        delete_source_files,
    } = req
    {
        return handle_organize_start(
            dedupe,
            dedupe_keep_new,
            remove_missing,
            regen_thumbnails,
            remove_unrecognized,
            range_start,
            range_end,
            delete_source_files,
        )
        .await;
    }
    if matches!(req, IpcRequest::OrganizeCancel) {
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
    #[cfg(feature = "standard")]
    {
        if matches!(req, IpcRequest::VdMount) {
            return handle_vd_mount().await;
        }
        if matches!(req, IpcRequest::VdUnmount) {
            return handle_vd_unmount().await;
        }
        if matches!(req, IpcRequest::VdStatus) {
            return handle_vd_status().await;
        }
    }

    // 未知请求
    IpcResponse::err(format!("Unknown request: {:?}", req))
}

async fn handle_task_start(params: serde_json::Value) -> IpcResponse {
    match kabegame_core::commands::task::start_task(params).await {
        Ok(task_id) => {
            let mut resp = IpcResponse::ok("queued");
            resp.task_id = Some(task_id);
            resp
        }
        Err(error) => IpcResponse::err(error),
    }
}

async fn handle_task_cancel(task_id: String) -> IpcResponse {
    TaskScheduler::global().cancel_task(&task_id).await;
    #[cfg(all(not(target_os = "android"), not(feature = "web")))]
    crate::commands::crawl_cancel_for_task(&task_id).await;
    IpcResponse::ok("ok")
}

async fn handle_task_retry_failed_image(failed_id: i64) -> IpcResponse {
    match TaskScheduler::global().retry_failed_image(failed_id).await {
        Ok(()) => IpcResponse::ok("ok"),
        Err(e) => IpcResponse::err(e),
    }
}

async fn handle_task_delete_failed_image(failed_id: i64) -> IpcResponse {
    let storage = Storage::global();
    let task_id = match Storage::get_task_failed_image_by_id(failed_id) {
        Ok(item) => item.map(|item| item.task_id),
        Err(e) => return IpcResponse::err(e),
    };
    match storage.delete_task_failed_image(failed_id) {
        Ok(()) => {
            if let Some(task_id) = task_id {
                GlobalEmitter::global().emit_failed_image_removed(&task_id, failed_id);
            }
            IpcResponse::ok("ok")
        }
        Err(e) => IpcResponse::err(e),
    }
}

async fn handle_get_active_downloads() -> IpcResponse {
    match TaskScheduler::global().get_active_downloads().await {
        Ok(downloads) => {
            IpcResponse::ok_with_data("ok", serde_json::to_value(downloads).unwrap_or_default())
        }
        Err(e) => IpcResponse::err(e),
    }
}

async fn handle_organize_start(
    dedupe: bool,
    dedupe_keep_new: bool,
    remove_missing: bool,
    regen_thumbnails: bool,
    remove_unrecognized: bool,
    range_start: Option<usize>,
    range_end: Option<usize>,
    delete_source_files: bool,
) -> IpcResponse {
    use kabegame_core::storage::organize::OrganizeOptions;
    let (offset, limit) = match (range_start, range_end) {
        (Some(s), Some(e)) if e > s => (Some(s), Some(e - s)),
        _ => (None, None),
    };
    match OrganizeService::global()
        .clone()
        .start(
            Arc::new(Storage::global().clone()),
            OrganizeOptions {
                dedupe,
                dedupe_keep_new,
                remove_missing,
                remove_unrecognized,
                regen_thumbnails,
                regen_compatible: false,
                backfill_native_metadata: false,
                delete_source_files,
                offset,
                limit,
            },
        )
        .await
    {
        Ok(()) => IpcResponse::ok("ok"),
        Err(e) => IpcResponse::err(e),
    }
}

async fn handle_organize_cancel() -> IpcResponse {
    match OrganizeService::global().cancel() {
        Ok(v) => IpcResponse::ok_with_data("ok", serde_json::Value::Bool(v)),
        Err(e) => IpcResponse::err(e),
    }
}

async fn handle_plugin_run(params: kabegame_core::commands::task::PluginRunParams) -> IpcResponse {
    match kabegame_core::commands::task::run_plugin(params, cfg!(not(target_os = "android"))).await
    {
        Ok(output) => {
            let task_id = output.task_id.clone();
            match serde_json::to_value(output) {
                Ok(data) => {
                    let mut resp = IpcResponse::ok_with_data("ok", data);
                    resp.task_id = task_id;
                    resp
                }
                Err(error) => IpcResponse::err(error.to_string()),
            }
        }
        Err(error) => IpcResponse::err(error),
    }
}

#[cfg(not(feature = "web"))]
async fn handle_app_show_window<R: Runtime>(app_handle: AppHandle<R>) -> IpcResponse {
    match crate::startup::ensure_main_window(app_handle.clone()) {
        Ok(()) => {
            let _ = app_handle.emit("app-show-window", ());
            IpcResponse::ok("window-shown")
        }
        Err(e) => IpcResponse::err(format!("显示窗口失败: {}", e)),
    }
}

#[cfg(not(feature = "web"))]
async fn handle_app_import_plugin<R: Runtime>(
    kgpg_path: String,
    app_handle: AppHandle<R>,
) -> IpcResponse {
    let path = std::path::PathBuf::from(&kgpg_path);
    if !path.is_file() {
        return IpcResponse::err(format!("File not found: {}", kgpg_path));
    }
    if path.extension().and_then(|s| s.to_str()) != Some("kgpg") {
        return IpcResponse::err(format!("Not a .kgpg file: {}", kgpg_path));
    }

    let _ = app_handle.emit(
        "app-import-plugin",
        serde_json::json!({
            "kgpgPath": kgpg_path
        }),
    );

    IpcResponse::ok("import-request-sent")
}

// TODO: 将此json结构体化
fn handle_status() -> IpcResponse {
    let mut resp = IpcResponse::ok("ok");
    resp.info = Some(serde_json::json!({
        "name": "kabegame-app",
        "version": env!("CARGO_PKG_VERSION"),
        "dataDir": kabegame_core::app_paths::AppPaths::global().data_dir.to_string_lossy(),
        "ipcProtocol": IPC_PROTOCOL_VERSION,
        "features": {
            "storage": true,
            "plugin": true,
            "settings": true,
            "events": true,
            "pluginRun": true,
            "virtualDrive": cfg!(feature = "standard")
        }
    }));
    resp
}

#[cfg(feature = "standard")]
async fn handle_vd_mount() -> IpcResponse {
    use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;

    if !cfg!(target_os = "windows") {
        return IpcResponse::err("Virtual drive is not available".to_string());
    }

    let path = Settings::global().get_album_drive_mount_point();

    let vd_service = VirtualDriveService::global().clone();

    // 检查是否已挂载（幂等处理）
    if vd_service.current_mount_point().is_some() {
        return IpcResponse::ok("Already mounted");
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
        Err(e) => return IpcResponse::err(format!("Spawn blocking error: {}", e)),
    };

    match mount_result {
        Ok(()) => {
            // 挂载成功后，设置 enabled 为 true（会自动发送 SettingChange 事件）
            let settings = Settings::global();
            if let Err(e) = settings.set_album_drive_enabled(true) {
                return IpcResponse::err(format!("Failed to set enabled: {}", e));
            }

            IpcResponse::ok("Mount successful")
        }
        Err(e) => IpcResponse::err(e),
    }
}

#[cfg(feature = "standard")]
async fn handle_vd_unmount() -> IpcResponse {
    use kabegame_core::virtual_driver::driver_service::VirtualDriveServiceTrait;

    if !cfg!(target_os = "windows") {
        return IpcResponse::err("Virtual drive is not available".to_string());
    }

    let vd_service = VirtualDriveService::global().clone();

    // 检查是否已卸载（幂等处理）
    if vd_service.current_mount_point().is_none() {
        return IpcResponse::ok("Already unmounted");
    }

    // 执行卸载（使用 spawn_blocking 避免阻塞 tokio worker）
    let unmount_result = match tokio::task::spawn_blocking({
        let vd_service = vd_service.clone();
        move || vd_service.unmount()
    })
    .await
    {
        Ok(result) => result,
        Err(e) => return IpcResponse::err(format!("Spawn blocking error: {}", e)),
    };

    match unmount_result {
        Ok(true) => {
            // 卸载成功后，设置 enabled 为 false（会自动发送 SettingChange 事件）
            let settings = Settings::global();
            if let Err(e) = settings.set_album_drive_enabled(false) {
                return IpcResponse::err(format!("Failed to set enabled: {}", e));
            }

            IpcResponse::ok("Unmount successful")
        }
        Ok(false) => {
            // 卸载失败但可能已经卸载，返回成功（幂等）
            IpcResponse::ok("Already unmounted")
        }
        Err(e) => IpcResponse::err(e),
    }
}

#[cfg(feature = "standard")]
async fn handle_vd_status() -> IpcResponse {
    let enabled = cfg!(target_os = "windows");
    let mut resp = IpcResponse::ok("ok");
    resp.info = Some(serde_json::json!({
        "status": if enabled { "ready" } else { "disabled" },
        "virtualDrive": enabled
    }));
    resp
}
