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
                    kabegame_core::commands::album::get_albums()
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
                    let mut result =
                        kabegame_core::commands::album::get_album_preview(args.album_id, args.limit)
                            .map_err(RpcError::internal)?;
                    crate::web::image_rewrite::rewrite_image_value(&mut result);
                    Ok(result)
                })
            }),
        },
    );

    map.insert(
        "pathql_entry",
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
                    kabegame_core::commands::image::pathql_entry(args.path)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "pathql_list",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        path: String,
                        #[serde(default)]
                        with_count: bool,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    kabegame_core::commands::image::pathql_list(args.path, args.with_count)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "pathql_fetch",
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
                    let mut result = kabegame_core::commands::image::pathql_fetch(args.path)
                        .await
                        .map_err(RpcError::internal)?;
                    crate::web::image_rewrite::rewrite_image_value(&mut result);
                    Ok(result)
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
                    kabegame_core::commands::image::get_images_count()
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
                    kabegame_core::commands::image::get_gallery_plugin_groups()
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
                    kabegame_core::commands::image::get_gallery_media_type_counts()
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
                    kabegame_core::commands::image::get_album_media_type_counts(args.album_id)
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
                    kabegame_core::commands::image::get_gallery_time_filter_data()
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
                    let mut result = kabegame_core::commands::image::get_image_by_id(args.image_id)
                        .map_err(RpcError::internal)?;
                    crate::web::image_rewrite::rewrite_image_value(&mut result);
                    Ok(result)
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
                    kabegame_core::commands::image::get_image_metadata(args.image_id)
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_image_metadata_full",
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
                    kabegame_core::commands::image::get_image_metadata_full(args.image_id)
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
                    kabegame_core::commands::task::get_all_tasks()
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
                    kabegame_core::commands::task::get_run_configs()
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
                    kabegame_core::commands::task::get_run_config(args.config_id)
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
                    kabegame_core::commands::task::get_missed_runs()
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
                    kabegame_core::commands::task::get_tasks_page(args.limit, args.offset)
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
                    kabegame_core::commands::task::get_task(args.task_id)
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
                    kabegame_core::commands::task::get_active_downloads()
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
                    kabegame_core::commands::task::get_task_logs(args.task_id)
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
                    kabegame_core::commands::task::get_task_failed_images(args.task_id)
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
                    kabegame_core::commands::task::get_all_failed_images()
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
                    crate::build_mode::get_build_mode().map_err(RpcError::internal)
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
                    kabegame_core::commands::misc::get_supported_image_types()
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
                    web_get_plugins().await
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
                    kabegame_core::commands::plugin::get_plugin_detail(args.plugin_id, args.source_id)
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
                    kabegame_core::commands::plugin::get_plugin_sources()
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
                    kabegame_core::commands::plugin::get_plugin_data(args.plugin_id)
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
                    kabegame_core::commands::plugin::get_store_plugins(
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
                    kabegame_core::commands::plugin::get_remote_plugin_icon(
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
                    kabegame_core::commands::proxy::proxy_fetch(args.url, args.headers)
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
                    kabegame_core::commands::settings::get_favorite_album_id()
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_settings",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    struct Args {
                        keys: Vec<String>,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    kabegame_core::commands::settings::get_settings(args.keys)
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
                    kabegame_core::commands::settings::get_import_recommended_schedule_enabled()
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
                    kabegame_core::commands::settings::get_max_concurrent_downloads()
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
                    kabegame_core::commands::settings::get_max_concurrent_tasks()
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
                    kabegame_core::commands::settings::get_download_interval_ms()
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
                    kabegame_core::commands::settings::get_network_retry_count()
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
                    kabegame_core::commands::settings::get_auto_deduplicate()
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
                    let task_id = kabegame_core::commands::task::start_task(args.task)
                        .await
                        .map_err(RpcError::internal)?;
                    Ok(Value::String(task_id))
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
                    kabegame_core::commands::album::rename_album(args.album_id, args.new_name)
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
                    kabegame_core::commands::album::delete_album(args.album_id)
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
                    kabegame_core::commands::image::toggle_image_favorite(args.image_id, args.favorite)
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
                    web_refresh_plugins().await
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
                    kabegame_core::commands::plugin::get_plugin_default_config(args.plugin_id)
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
                    kabegame_core::commands::plugin::ensure_plugin_default_config(args.plugin_id)
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
                    kabegame_core::commands::plugin::save_plugin_default_config(
                        args.plugin_id,
                        args.config,
                    )
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
                    kabegame_core::commands::plugin::reset_plugin_default_config(args.plugin_id)
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
                    kabegame_core::commands::image::delete_image(args.image_id)
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
                    kabegame_core::commands::image::batch_delete_images(args.image_ids)
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
                    kabegame_core::commands::image::batch_remove_images(args.image_ids)
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
                    kabegame_core::commands::image::remove_image(args.image_id)
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
                    kabegame_core::commands::album::move_album(args.album_id, args.new_parent_id)
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
                    kabegame_core::commands::album::add_album(args.name, args.parent_id)
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "sync_local_folder_album",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        album_id: String,
                        recursive: Option<bool>,
                        create_missing_albums: Option<bool>,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    kabegame_core::commands::album::sync_local_folder_album(
                        args.album_id,
                        args.recursive,
                        args.create_missing_albums,
                    )
                    .await
                    .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "sync_local_folder_albums",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|p| {
                Box::pin(async move {
                    #[derive(Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args {
                        album_ids: Vec<String>,
                    }
                    let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
                    kabegame_core::commands::album::sync_local_folder_albums(args.album_ids)
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
                    kabegame_core::commands::album::add_images_to_album(args.album_id, args.image_ids)
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
                    kabegame_core::commands::album::add_task_images_to_album(
                        args.task_id,
                        args.album_id,
                    )
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
                    kabegame_core::commands::album::remove_images_from_album(
                        args.album_id,
                        args.image_ids,
                    )
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
                    kabegame_core::commands::album::update_album_images_order(
                        args.album_id,
                        args.image_orders,
                    )
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
                    kabegame_core::commands::task::cancel_task(args.task_id)
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
                    kabegame_core::commands::task::delete_task(args.task_id)
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
                    kabegame_core::commands::task::add_task(args.task)
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
                    kabegame_core::commands::task::clear_finished_tasks()
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
                    kabegame_core::commands::task::copy_run_config(args.config_id)
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
                    kabegame_core::commands::task::retry_task_failed_image(args.failed_id)
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
                    kabegame_core::commands::task::retry_failed_images(args.ids)
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
                    kabegame_core::commands::task::cancel_retry_failed_image(args.failed_id)
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
                    kabegame_core::commands::task::cancel_retry_failed_images(args.ids)
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
                    kabegame_core::commands::task::delete_failed_images(args.ids)
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
                    kabegame_core::commands::task::delete_task_failed_image(args.failed_id)
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
                    kabegame_core::commands::task::add_run_config(args.config)
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
                    kabegame_core::commands::task::update_run_config(args.config)
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
                    kabegame_core::commands::task::delete_run_config(args.config_id)
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
                    kabegame_core::commands::task::run_missed_configs(args.config_ids)
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
                    kabegame_core::commands::task::dismiss_missed_configs(args.config_ids)
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
                    kabegame_core::commands::plugin::delete_plugin(args.plugin_id)
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
                    kabegame_core::commands::plugin::install_from_store(args.source_id, args.plugin_id)
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
                    kabegame_core::commands::plugin::import_plugin_from_zip(args.zip_path)
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
                    kabegame_core::commands::plugin::validate_plugin_source(args.index_url)
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
                    kabegame_core::commands::plugin::update_plugin_source(
                        args.id,
                        args.name,
                        args.index_url,
                    )
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
                    kabegame_core::commands::plugin::delete_plugin_source(args.id)
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
                    kabegame_core::commands::plugin::add_plugin_source(
                        args.id,
                        args.name,
                        args.index_url,
                    )
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
                    kabegame_core::commands::plugin::preview_import_plugin(args.zip_path)
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
                    kabegame_core::commands::plugin::preview_store_install(
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
                    kabegame_core::commands::surf::surf_delete_record(args.host)
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
                    kabegame_core::commands::surf::surf_update_name(args.host, args.name)
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
                    kabegame_core::commands::surf::surf_update_root_url(args.host, args.root_url)
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
                    kabegame_core::commands::settings::set_max_concurrent_downloads(args.count)
                        .await
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
                    kabegame_core::commands::settings::set_max_concurrent_tasks(args.count)
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
                    kabegame_core::commands::settings::set_download_interval_ms(args.interval_ms)
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
                    kabegame_core::commands::settings::set_network_retry_count(args.count)
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
                    kabegame_core::commands::settings::set_auto_deduplicate(args.enabled)
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
                    kabegame_core::commands::settings::set_import_recommended_schedule_enabled(
                        args.enabled,
                    )
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
                    let args: kabegame_core::commands::organize::StartOrganizeArgs =
                        serde_json::from_value(inner).map_err(RpcError::invalid_params)?;
                    kabegame_core::commands::organize::start_organize(args)
                        .await
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_organize_total_count",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    kabegame_core::commands::organize::get_organize_total_count()
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "get_organize_run_state",
        MethodEntry {
            requires_super: false,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    kabegame_core::commands::organize::get_organize_run_state()
                        .map_err(RpcError::internal)
                })
            }),
        },
    );

    map.insert(
        "cancel_organize",
        MethodEntry {
            requires_super: true,
            handler: Arc::new(|_p| {
                Box::pin(async move {
                    kabegame_core::commands::organize::cancel_organize().map_err(RpcError::internal)
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

// Web 专属：只回 `{id, version}` 索引（详情体积大，web 客户端按需 `get_plugin_detail`
// 单取）。桌面走 `commands::plugin::get_plugins` 回整份列表——两端形状不同，故各自实现，
// 不下沉到 feature-agnostic 的 core commands 层。
async fn web_get_plugins() -> Result<Value, RpcError> {
    let pm = kabegame_core::plugin::PluginManager::global();
    pm.ensure_installed_cache_initialized()
        .await
        .map_err(RpcError::internal)?;
    let plugins = pm.get_all().map_err(RpcError::internal)?;
    let index: Vec<Value> = plugins
        .iter()
        .map(|p| serde_json::json!({ "id": p.id, "version": p.version }))
        .collect();
    Ok(Value::Array(index))
}

async fn web_refresh_plugins() -> Result<Value, RpcError> {
    kabegame_core::plugin::PluginManager::global()
        .refresh_plugins()
        .await
        .map_err(RpcError::internal)?;
    web_get_plugins().await
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
