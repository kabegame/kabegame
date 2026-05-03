use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};

use serde::Deserialize;
use serde_json::Value;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

#[derive(Debug, Clone)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
}

impl RpcError {
    pub fn internal(msg: impl ToString) -> Self {
        RpcError {
            code: -32000,
            message: msg.to_string(),
        }
    }
    pub fn invalid_params(msg: impl ToString) -> Self {
        RpcError {
            code: -32602,
            message: msg.to_string(),
        }
    }
    pub fn not_found() -> Self {
        RpcError {
            code: -32601,
            message: "method not found".into(),
        }
    }
    pub fn forbidden() -> Self {
        RpcError {
            code: -32001,
            message: "forbidden".into(),
        }
    }
}

type HandlerFn = Arc<dyn Fn(Value) -> BoxFuture<Result<Value, RpcError>> + Send + Sync>;

pub struct MethodEntry {
    pub requires_super: bool,
    pub handler: HandlerFn,
}

static REGISTRY: OnceLock<HashMap<&'static str, MethodEntry>> = OnceLock::new();

fn registry() -> &'static HashMap<&'static str, MethodEntry> {
    REGISTRY
        .get()
        .expect("RPC registry not initialized; call init_registry() first")
}

#[derive(Deserialize)]
pub struct JsonRpcRequest {
    pub id: Option<Value>,
    pub method: String,
    pub params: Option<Value>,
}

pub fn init_registry() {
    let mut map: HashMap<&'static str, MethodEntry> = HashMap::new();

    // ── read (no super required) ──────────────────────────────────────────────

    map.insert(
        "get_albums",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    crate::commands_core::album::get_albums()
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_album_counts",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    crate::commands_core::album::get_album_counts()
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_album_preview",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        album_id: String,
                        limit: usize,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::album::get_album_preview(args.album_id, args.limit)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_album_image_ids",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        album_id: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::album::get_album_image_ids(args.album_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "browse_gallery_provider",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        path: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::image::browse_gallery_provider(args.path)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "list_provider_children",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        path: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::image::list_provider_children(args.path)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "query_provider",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        path: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::image::query_provider(args.path)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_images_count",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    crate::commands_core::image::get_images_count()
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_gallery_plugin_groups",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    crate::commands_core::image::get_gallery_plugin_groups()
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_gallery_media_type_counts",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    crate::commands_core::image::get_gallery_media_type_counts()
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_album_media_type_counts",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        album_id: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::image::get_album_media_type_counts(args.album_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_gallery_time_filter_data",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    crate::commands_core::image::get_gallery_time_filter_data()
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_image_by_id",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        image_id: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::image::get_image_by_id(args.image_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_image_metadata",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        image_id: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::image::get_image_metadata(args.image_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_image_metadata_by_metadata_id",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        metadata_id: i64,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::image::get_image_metadata_by_metadata_id(args.metadata_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_all_tasks",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    crate::commands_core::task::get_all_tasks()
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_run_configs",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    crate::commands_core::task::get_run_configs()
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_run_config",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        config_id: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::task::get_run_config(args.config_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_missed_runs",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    crate::commands_core::task::get_missed_runs()
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_tasks_page",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        limit: u32,
                        offset: u32,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::task::get_tasks_page(args.limit, args.offset)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_task",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        task_id: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::task::get_task(args.task_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_active_downloads",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    crate::commands_core::task::get_active_downloads()
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_task_logs",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        task_id: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::task::get_task_logs(args.task_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_task_failed_images",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        task_id: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::task::get_task_failed_images(args.task_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_all_failed_images",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    crate::commands_core::task::get_all_failed_images()
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_build_mode",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    crate::commands_core::misc::get_build_mode().map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_supported_image_types",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    crate::commands_core::misc::get_supported_image_types()
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_plugins",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    crate::commands_core::plugin::get_plugins()
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_plugin_detail",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        plugin_id: String,
                        source_id: Option<String>,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::plugin::get_plugin_detail(args.plugin_id, args.source_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_plugin_sources",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    crate::commands_core::plugin::get_plugin_sources()
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_plugin_data",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        plugin_id: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::plugin::get_plugin_data(args.plugin_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_store_plugins",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        source_id: Option<String>,
                        force_refresh: Option<bool>,
                        revalidate_if_stale_after_secs: Option<u64>,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::plugin::get_store_plugins(
                        args.source_id,
                        args.force_refresh.unwrap_or(false),
                        args.revalidate_if_stale_after_secs,
                    )
                    .await
                    .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_remote_plugin_icon",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        download_url: String,
                        source_id: Option<String>,
                        plugin_id: Option<String>,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::plugin::get_remote_plugin_icon(
                        args.download_url,
                        args.source_id,
                        args.plugin_id,
                    )
                    .await
                    .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "proxy_fetch",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    struct Args {
                        url: String,
                        #[serde(default)]
                        headers: Option<HashMap<String, String>>,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::proxy::proxy_fetch(args.url, args.headers)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_favorite_album_id",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    crate::commands_core::settings::get_favorite_album_id()
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_import_recommended_schedule_enabled",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    crate::commands_core::settings::get_import_recommended_schedule_enabled()
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_max_concurrent_downloads",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    crate::commands_core::settings::get_max_concurrent_downloads()
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_max_concurrent_tasks",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    crate::commands_core::settings::get_max_concurrent_tasks()
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_download_interval_ms",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    crate::commands_core::settings::get_download_interval_ms()
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_network_retry_count",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    crate::commands_core::settings::get_network_retry_count()
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_auto_deduplicate",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    crate::commands_core::settings::get_auto_deduplicate()
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    // ── write (super required) ────────────────────────────────────────────────

    map.insert(
        "start_task",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    struct Args {
                        task: Value,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::task::start_task(args.task)
                        .await
                        .map_err(RpcError::internal)?;
                    Ok(Value::Null)
                })
            }),
        },
    );

    map.insert(
        "rename_album",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        album_id: String,
                        new_name: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::album::rename_album(args.album_id, args.new_name)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "delete_album",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        album_id: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::album::delete_album(args.album_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "toggle_image_favorite",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        image_id: String,
                        favorite: bool,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::image::toggle_image_favorite(args.image_id, args.favorite)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "refresh_plugins",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    crate::commands_core::plugin::refresh_plugins()
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_plugin_default_config",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        plugin_id: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::plugin::get_plugin_default_config(args.plugin_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "ensure_plugin_default_config",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        plugin_id: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::plugin::ensure_plugin_default_config(args.plugin_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "save_plugin_default_config",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        plugin_id: String,
                        config: serde_json::Value,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::plugin::save_plugin_default_config(
                        args.plugin_id,
                        args.config,
                    )
                    .await
                    .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "reset_plugin_default_config",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        plugin_id: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::plugin::reset_plugin_default_config(args.plugin_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    // ── image/album mutations ─────────────────────────────────────────────────

    map.insert(
        "delete_image",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        image_id: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::image::delete_image(args.image_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "batch_delete_images",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        image_ids: Vec<String>,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::image::batch_delete_images(args.image_ids)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "batch_remove_images",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        image_ids: Vec<String>,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::image::batch_remove_images(args.image_ids)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "remove_image",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        image_id: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::image::remove_image(args.image_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "move_album",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        album_id: String,
                        new_parent_id: Option<String>,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::album::move_album(args.album_id, args.new_parent_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "add_album",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        name: String,
                        parent_id: Option<String>,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::album::add_album(args.name, args.parent_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "add_images_to_album",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        album_id: String,
                        image_ids: Vec<String>,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::album::add_images_to_album(args.album_id, args.image_ids)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "add_task_images_to_album",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        task_id: String,
                        album_id: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::album::add_task_images_to_album(
                        args.task_id,
                        args.album_id,
                    )
                    .await
                    .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "remove_images_from_album",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        album_id: String,
                        image_ids: Vec<String>,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::album::remove_images_from_album(
                        args.album_id,
                        args.image_ids,
                    )
                    .await
                    .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "update_album_images_order",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        album_id: String,
                        image_orders: Vec<(String, i64)>,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::album::update_album_images_order(
                        args.album_id,
                        args.image_orders,
                    )
                    .await
                    .map_err(RpcError::internal)
                })
            }),
        },
    );

    // ── task mutations ────────────────────────────────────────────────────────

    map.insert(
        "cancel_task",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        task_id: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::task::cancel_task(args.task_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "delete_task",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        task_id: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::task::delete_task(args.task_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "add_task",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    struct Args {
                        task: Value,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::task::add_task(args.task)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "update_task",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    struct Args {
                        task: Value,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::task::update_task(args.task)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "clear_finished_tasks",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    crate::commands_core::task::clear_finished_tasks()
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "copy_run_config",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        config_id: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::task::copy_run_config(args.config_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    // ── failed images ────────────────────────────────────────────────────────

    map.insert(
        "retry_task_failed_image",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        failed_id: i64,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::task::retry_task_failed_image(args.failed_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "retry_failed_images",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    struct Args {
                        ids: Vec<i64>,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::task::retry_failed_images(args.ids)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "cancel_retry_failed_image",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        failed_id: i64,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::task::cancel_retry_failed_image(args.failed_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "cancel_retry_failed_images",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    struct Args {
                        ids: Vec<i64>,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::task::cancel_retry_failed_images(args.ids)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "delete_failed_images",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    struct Args {
                        ids: Vec<i64>,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::task::delete_failed_images(args.ids)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "delete_task_failed_image",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        failed_id: i64,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::task::delete_task_failed_image(args.failed_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    // ── scheduling (run configs) ──────────────────────────────────────────────

    map.insert(
        "add_run_config",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    struct Args {
                        config: Value,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::task::add_run_config(args.config)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "update_run_config",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    struct Args {
                        config: Value,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::task::update_run_config(args.config)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "delete_run_config",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        config_id: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::task::delete_run_config(args.config_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "run_missed_configs",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        config_ids: Vec<String>,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::task::run_missed_configs(args.config_ids)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "dismiss_missed_configs",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        config_ids: Vec<String>,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::task::dismiss_missed_configs(args.config_ids)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    // ── plugin mutations ─────────────────────────────────────────────────────

    map.insert(
        "delete_plugin",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        plugin_id: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::plugin::delete_plugin(args.plugin_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "install_from_store",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        source_id: String,
                        plugin_id: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::plugin::install_from_store(args.source_id, args.plugin_id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "import_plugin_from_zip",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        zip_path: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::plugin::import_plugin_from_zip(args.zip_path)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "validate_plugin_source",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        index_url: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::plugin::validate_plugin_source(args.index_url)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "update_plugin_source",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        id: String,
                        name: String,
                        index_url: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::plugin::update_plugin_source(
                        args.id,
                        args.name,
                        args.index_url,
                    )
                    .await
                    .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "delete_plugin_source",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    struct Args {
                        id: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::plugin::delete_plugin_source(args.id)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "add_plugin_source",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        id: Option<String>,
                        name: String,
                        index_url: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::plugin::add_plugin_source(
                        args.id,
                        args.name,
                        args.index_url,
                    )
                    .await
                    .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "preview_import_plugin",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        zip_path: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::plugin::preview_import_plugin(args.zip_path)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "preview_store_install",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        source_id: String,
                        plugin_id: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::plugin::preview_store_install(
                        args.source_id,
                        args.plugin_id,
                    )
                    .await
                    .map_err(RpcError::internal)
                })
            }),
        },
    );

    // ── surf records ─────────────────────────────────────────────────────────

    map.insert(
        "surf_delete_record",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    struct Args {
                        host: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::surf::surf_delete_record(args.host)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "surf_update_name",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    struct Args {
                        host: String,
                        name: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::surf::surf_update_name(args.host, args.name)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "surf_update_root_url",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        host: String,
                        root_url: String,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::surf::surf_update_root_url(args.host, args.root_url)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    // ── settings setters (global, admin-only) ───────────────────────────────

    map.insert(
        "set_max_concurrent_downloads",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    struct Args {
                        count: u32,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::settings::set_max_concurrent_downloads(args.count)
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "set_max_concurrent_tasks",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    struct Args {
                        count: u32,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::settings::set_max_concurrent_tasks(args.count)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "set_download_interval_ms",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        interval_ms: u32,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::settings::set_download_interval_ms(args.interval_ms)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "set_network_retry_count",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    struct Args {
                        count: u32,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::settings::set_network_retry_count(args.count)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "set_auto_deduplicate",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    struct Args {
                        enabled: bool,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::settings::set_auto_deduplicate(args.enabled)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "set_import_recommended_schedule_enabled",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    struct Args {
                        enabled: bool,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    crate::commands_core::settings::set_import_recommended_schedule_enabled(
                        args.enabled,
                    )
                    .await
                    .map_err(RpcError::internal)
                })
            }),
        },
    );

    // ── organize ─────────────────────────────────────────────────────────────

    map.insert(
        "start_organize",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    // Tauri invoke wraps typed args under a named key matching the Rust param name ("args").
                    // Extract that inner value before deserializing.
                    let inner = p.get("args").cloned().unwrap_or(p);
                    let args: crate::commands_core::organize::StartOrganizeArgs =
                        serde_json::from_value(inner).map_err(RpcError::invalid_params)?;
                    crate::commands_core::organize::start_organize(args)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    REGISTRY.set(map).ok();
}

pub async fn dispatch(req: JsonRpcRequest, is_super: bool) -> Value {
    let id = req.id.clone().unwrap_or(Value::Null);
    let params = req.params.unwrap_or(Value::Null);

    let entry = match registry().get(req.method.as_str()) {
        Some(e) => e,
        None => return rpc_error(id, -32601, "method not found"),
    };

    if entry.requires_super && !is_super {
        return rpc_error(id, -32001, "forbidden");
    }

    match (entry.handler)(params).await {
        Ok(mut result) => {
            if !is_super {
                strip_http_headers_in_place(&mut result);
            }
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": result,
            })
        }
        Err(e) => rpc_error(id, e.code, e.message),
    }
}

// Why: 非 super 读路径（get_task / get_run_config / get_plugin_default_config 等）
// 返回的任务参数、自动运行、插件默认配置里带明文爬虫凭证；统一在 dispatch 出口清洗，
// 避免每条命令各自处理。数组首元素探测 + 仅扫顶层，绕开 userConfig 深层嵌套的无谓遍历。
fn strip_http_headers_in_place(v: &mut Value) {
    match v {
        Value::Object(map) => {
            if let Some(slot) = map.get_mut("httpHeaders") {
                *slot = Value::Object(serde_json::Map::new());
            }
        }
        Value::Array(items) => {
            let needs_strip = items
                .first()
                .and_then(|first| first.as_object())
                .map(|obj| obj.contains_key("httpHeaders"))
                .unwrap_or(false);
            if needs_strip {
                for item in items.iter_mut() {
                    if let Some(obj) = item.as_object_mut() {
                        if let Some(slot) = obj.get_mut("httpHeaders") {
                            *slot = Value::Object(serde_json::Map::new());
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

fn rpc_error(id: Value, code: i32, message: impl Into<String>) -> Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message.into() }
    })
}
