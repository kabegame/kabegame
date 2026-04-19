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
        RpcError { code: -32000, message: msg.to_string() }
    }
    pub fn invalid_params(msg: impl ToString) -> Self {
        RpcError { code: -32602, message: msg.to_string() }
    }
    pub fn not_found() -> Self {
        RpcError { code: -32601, message: "method not found".into() }
    }
    pub fn forbidden() -> Self {
        RpcError { code: -32001, message: "forbidden".into() }
    }
}

type HandlerFn = Arc<dyn Fn(Value) -> BoxFuture<Result<Value, RpcError>> + Send + Sync>;

pub struct MethodEntry {
    pub requires_super: bool,
    pub handler: HandlerFn,
}

static REGISTRY: OnceLock<HashMap<&'static str, MethodEntry>> = OnceLock::new();

fn registry() -> &'static HashMap<&'static str, MethodEntry> {
    REGISTRY.get().expect("RPC registry not initialized; call init_registry() first")
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

    map.insert("get_albums", MethodEntry {
        requires_super: false,
        handler: Arc::new(|_p| Box::pin(async move {
            crate::commands_core::album::get_albums().await.map_err(RpcError::internal)
        })),
    });

    map.insert("get_album_counts", MethodEntry {
        requires_super: false,
        handler: Arc::new(|_p| Box::pin(async move {
            crate::commands_core::album::get_album_counts().await.map_err(RpcError::internal)
        })),
    });

    map.insert("get_images_range", MethodEntry {
        requires_super: false,
        handler: Arc::new(|p| Box::pin(async move {
            #[derive(serde::Deserialize)]
            struct Args { offset: usize, limit: usize }
            let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
            crate::commands_core::image::get_images_range(args.offset, args.limit)
                .await
                .map_err(RpcError::internal)
        })),
    });

    map.insert("get_tasks_page", MethodEntry {
        requires_super: false,
        handler: Arc::new(|p| Box::pin(async move {
            #[derive(serde::Deserialize)]
            struct Args { limit: u32, offset: u32 }
            let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
            crate::commands_core::task::get_tasks_page(args.limit, args.offset)
                .await
                .map_err(RpcError::internal)
        })),
    });

    map.insert("get_task", MethodEntry {
        requires_super: false,
        handler: Arc::new(|p| Box::pin(async move {
            #[derive(serde::Deserialize)]
            struct Args { task_id: String }
            let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
            crate::commands_core::task::get_task(args.task_id)
                .await
                .map_err(RpcError::internal)
        })),
    });

    map.insert("get_build_mode", MethodEntry {
        requires_super: false,
        handler: Arc::new(|_p| Box::pin(async move {
            crate::commands_core::misc::get_build_mode().map_err(RpcError::internal)
        })),
    });

    map.insert("get_supported_image_types", MethodEntry {
        requires_super: false,
        handler: Arc::new(|_p| Box::pin(async move {
            crate::commands_core::misc::get_supported_image_types().map_err(RpcError::internal)
        })),
    });

    // ── write (super required) ────────────────────────────────────────────────

    map.insert("rename_album", MethodEntry {
        requires_super: true,
        handler: Arc::new(|p| Box::pin(async move {
            #[derive(serde::Deserialize)]
            struct Args { album_id: String, new_name: String }
            let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
            crate::commands_core::album::rename_album(args.album_id, args.new_name)
                .await
                .map_err(RpcError::internal)
        })),
    });

    map.insert("delete_album", MethodEntry {
        requires_super: true,
        handler: Arc::new(|p| Box::pin(async move {
            #[derive(serde::Deserialize)]
            struct Args { album_id: String }
            let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
            crate::commands_core::album::delete_album(args.album_id)
                .await
                .map_err(RpcError::internal)
        })),
    });

    map.insert("toggle_image_favorite", MethodEntry {
        requires_super: true,
        handler: Arc::new(|p| Box::pin(async move {
            #[derive(serde::Deserialize)]
            struct Args { image_id: String, favorite: bool }
            let args: Args = serde_json::from_value(p).map_err(RpcError::invalid_params)?;
            crate::commands_core::image::toggle_image_favorite(args.image_id, args.favorite)
                .await
                .map_err(RpcError::internal)
        })),
    });

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
        Ok(result) => serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        }),
        Err(e) => rpc_error(id, e.code, e.message),
    }
}

fn rpc_error(id: Value, code: i32, message: impl Into<String>) -> Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message.into() }
    })
}
