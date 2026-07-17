use kabegame_core::{
    emitter::GlobalEmitter,
    providers::provider_runtime,
    settings::Settings,
    storage::{Album, ImageInfo, Storage, SurfRecord, TaskInfo},
};
use pathql_rs::EngineError;
use rmcp::{
    model::{
        object, AnnotateAble, CallToolRequestParams, CallToolResult, Content, ErrorCode,
        Implementation, ListResourceTemplatesResult, ListResourcesResult, ListToolsResult,
        PaginatedRequestParams, RawResource, RawResourceTemplate, ReadResourceRequestParams,
        ReadResourceResult, ResourceContents, ServerCapabilities, ServerInfo, Tool,
    },
    service::RequestContext,
    ErrorData as McpError, RoleServer, ServerHandler,
};
use serde_json::{json, Value};

use crate::mcp_capabilities::{
    capability_for_tool, is_capability_enabled, read_capability_id,
};

pub const MCP_PORT: u16 = 7490;

const MCP_INSTRUCTIONS: &str = r#"Kabegame MCP exposes PathQL-backed read resources plus write tools.

Use these read schemes:

1) images://
   images://id_{id}              full ImageInfo (including metadataId)
   images://id_{id}/metadata     crawl-time metadata (tags, author, URLs; can be 10s of KB)
   images://gallery/all          gallery collection from the existing images tree
   images://x100x/1              first 100 raw image rows

2) albums://
   albums://all                  list ALL Albums — returns Vec<Album>
   albums://id_{id}              single Album

3) tasks://
   tasks://all                   list ALL Tasks — returns Vec<TaskInfo>
   tasks://id_{id}               single TaskInfo

4) surf_records://
   surf_records://all            list ALL SurfRecords — returns Vec<SurfRecord>
   surf_records://id_{id}        single SurfRecord

5) plugin://                              list ALL Plugins (trimmed — see note below)
   plugin://{id}                          single Plugin (trimmed)
   plugin://{id}/icon                     base64 icon PNG                (image/png, blob)
   plugin://{id}/description_template     EJS description template       (text/plain)
   plugin://{id}/doc                      doc.md (default locale)        (text/markdown)
   plugin://{id}/doc_resource/{key}       one doc_root resource file     (mime by extension, blob)

   "Trimmed" = the Plugin JSON returned by plugin:// and plugin://{id} has `docResources`,
   `iconPngBase64`, and `descriptionTemplate` stripped out. Fetch each heavy resource on
   demand via the sub-paths above.

Do not use provider://, image://, album://, task://, or surf://. They are not supported.

Image fields (ImageInfo, camelCase via serde rename_all):
   id, url, localPath, pluginId, taskId, surfRecordId, crawledAt (unix sec),
   metadataId, thumbnailPath, favorite, localExists, hash, width, height, displayName,
   type ("image" | "video" — NOTE: serde key is `type`, not `mediaType`),
   lastSetWallpaperAt, size (bytes).
   Use images://id_{id}/metadata to fetch crawl-time JSON metadata.

Plugin package layout (for model-authored plugins): package.json (kbBackend: v8),
dist/main.js (export async function crawl), doc_root/doc.md, optional icon.png.

Tools: set_album_images_order (manual order, up to 100 images per call), create_album,
add_images_to_album, rename_image. After set_album_images_order, open the album in Kabegame
and switch sort mode to album-order to see the arrangement.

IMPORTANT — actions that are NOT supported:
- Deleting images is not possible. If the user asks to delete images, explain that this
  action is not available through MCP, and offer to collect the unwanted images into an
  album (e.g. "待删除") instead so the user can review and delete them manually in the app.
- Deleting albums is not possible. If the user asks to delete an album, explain that this
  action is not available, and offer to move its contents into another album or nest it
  inside another album using create_album + add_images_to_album.
- No other destructive or write operations beyond the tools listed above are supported.
"#;

fn resource_scheme(uri: &str) -> Result<&str, McpError> {
    let (scheme, _) = uri
        .split_once("://")
        .ok_or_else(|| McpError::resource_not_found("invalid_uri", Some(json!({ "uri": uri }))))?;
    if scheme.is_empty() {
        return Err(McpError::resource_not_found(
            "invalid_uri",
            Some(json!({ "uri": uri })),
        ));
    }
    Ok(scheme)
}

fn resource_segments(uri: &str) -> Vec<&str> {
    uri.split_once("://")
        .map(|(_, rest)| {
            rest.trim_matches('/')
                .split('/')
                .filter(|segment| !segment.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn is_uri_capability_enabled(uri: &str, disabled: &[String]) -> bool {
    let Ok(scheme) = resource_scheme(uri) else {
        return true;
    };
    let segments = resource_segments(uri);
    match read_capability_id(scheme, segments.as_slice()) {
        Some(id) => is_capability_enabled(id, disabled),
        None => true,
    }
}

fn disabled_resource_error(uri: &str) -> McpError {
    McpError::resource_not_found("resource_disabled", Some(json!({ "uri": uri })))
}

fn disabled_tool_error(tool: &str) -> McpError {
    McpError::invalid_request("tool_disabled", Some(json!({ "tool": tool })))
}

async fn fetch_resource_rows(uri: &str) -> Result<Vec<Value>, McpError> {
    let rt = provider_runtime().clone();
    let uri = uri.to_string();
    tokio::task::spawn_blocking(move || rt.fetch(&uri))
        .await
        .map_err(|e| McpError::internal_error(e.to_string(), None))?
        .map_err(|e| match e {
            EngineError::PathNotFound(_)
            | EngineError::NoProvider(_)
            | EngineError::SchemaNotFound(_) => {
                McpError::resource_not_found("resource_not_found", None)
            }
            other => McpError::internal_error(format!("pathql: {other}"), None),
        })
}

fn rows_to_value<T>(rows: Vec<Value>, single: bool, uri: &str) -> Result<Value, McpError>
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    let mut values = Vec::with_capacity(rows.len());
    for row in rows {
        let item: T = serde_json::from_value(row)
            .map_err(|e| McpError::internal_error(format!("row decode: {e}"), None))?;
        values.push(
            serde_json::to_value(item)
                .map_err(|e| McpError::internal_error(format!("row encode: {e}"), None))?,
        );
    }
    if single {
        values.into_iter().next().ok_or_else(|| {
            McpError::resource_not_found("resource_not_found", Some(json!({ "uri": uri })))
        })
    } else {
        Ok(Value::Array(values))
    }
}

fn image_rows_to_value(rows: Vec<Value>, single: bool, uri: &str) -> Result<Value, McpError> {
    rows_to_value::<ImageInfo>(rows, single, uri)
}

fn metadata_rows_to_value(rows: Vec<Value>, uri: &str) -> Result<Value, McpError> {
    let row = rows.into_iter().next().ok_or_else(|| {
        McpError::resource_not_found("metadata_not_found", Some(json!({ "uri": uri })))
    })?;
    let Some(metadata) = row.get("metadata_json") else {
        return Ok(row);
    };
    match metadata {
        Value::String(s) => serde_json::from_str::<Value>(s)
            .map_err(|e| McpError::internal_error(format!("metadata decode: {e}"), None)),
        Value::Null => Err(McpError::resource_not_found(
            "metadata_not_found",
            Some(json!({ "uri": uri })),
        )),
        other => Ok(other.clone()),
    }
}

fn json_value_resource(
    value: Value,
    uri: impl Into<String>,
) -> Result<ReadResourceResult, McpError> {
    let json =
        serde_json::to_string(&value).map_err(|e| McpError::internal_error(e.to_string(), None))?;
    json_resource(json, uri)
}

fn parse_args<T: serde::de::DeserializeOwned>(
    arguments: Option<serde_json::Map<String, serde_json::Value>>,
) -> Result<T, McpError> {
    serde_json::from_value(serde_json::Value::Object(arguments.unwrap_or_default()))
        .map_err(|e| McpError::invalid_params(e.to_string(), None))
}

fn json_resource(json: String, uri: impl Into<String>) -> Result<ReadResourceResult, McpError> {
    Ok(ReadResourceResult::new(vec![ResourceContents::text(
        json, uri,
    )
    .with_mime_type("application/json")]))
}

#[derive(Clone)]
pub struct KabegameMcpServer;

impl ServerHandler for KabegameMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_resources()
                .enable_tools()
                .build(),
        )
        .with_server_info(Implementation::from_build_env())
        .with_instructions(MCP_INSTRUCTIONS.to_string())
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        let disabled = Settings::global().get_mcp_disabled_capabilities();
        let resources = vec![
            (
                "images://gallery/all",
                RawResource::new("images://gallery/all", "Gallery images")
                    .with_description("Gallery collection from the images PathQL tree")
                    .with_mime_type("application/json")
                    .no_annotation(),
            ),
            (
                "images://x100x/1",
                RawResource::new("images://x100x/1", "Raw image rows")
                    .with_description("First 100 raw rows from images")
                    .with_mime_type("application/json")
                    .no_annotation(),
            ),
            (
                "albums://all",
                RawResource::new("albums://all", "All albums")
                    .with_description("Full list of albums (Vec<Album>)")
                    .with_mime_type("application/json")
                    .no_annotation(),
            ),
            (
                "tasks://all",
                RawResource::new("tasks://all", "All tasks")
                    .with_description("Full list of tasks (Vec<TaskInfo>)")
                    .with_mime_type("application/json")
                    .no_annotation(),
            ),
            (
                "surf_records://all",
                RawResource::new("surf_records://all", "All surf records")
                    .with_description("Full list of surf records (Vec<SurfRecord>)")
                    .with_mime_type("application/json")
                    .no_annotation(),
            ),
            (
                "plugin://",
                RawResource::new("plugin://", "All plugins (trimmed)")
                    .with_description(
                        "Full list of installed plugins with heavy fields (docResources, \
                         iconPngBase64, descriptionTemplate) stripped",
                    )
                    .with_mime_type("application/json")
                    .no_annotation(),
            ),
        ]
        .into_iter()
        .filter_map(|(uri, resource)| {
            is_uri_capability_enabled(uri, &disabled).then_some(resource)
        })
        .collect();

        Ok(ListResourcesResult {
            resources,
            next_cursor: None,
            meta: None,
        })
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResult, McpError> {
        let scheme = resource_scheme(&request.uri)?;
        let segments = resource_segments(&request.uri);
        let disabled = Settings::global().get_mcp_disabled_capabilities();
        if let Some(id) = read_capability_id(scheme, segments.as_slice()) {
            if !is_capability_enabled(id, &disabled) {
                return Err(disabled_resource_error(&request.uri));
            }
        }

        match scheme {
            "images" => {
                let is_metadata = segments.len() == 2
                    && segments.first().is_some_and(|seg| seg.starts_with("id_"))
                    && segments[1] == "metadata";
                let is_single = segments.len() == 1
                    && segments.first().is_some_and(|seg| seg.starts_with("id_"));
                let rows = fetch_resource_rows(&request.uri).await?;
                let value = if is_metadata {
                    metadata_rows_to_value(rows, &request.uri)?
                } else {
                    image_rows_to_value(rows, is_single, &request.uri)?
                };
                json_value_resource(value, request.uri)
            }
            "albums" => {
                let is_single = matches!(segments.as_slice(), [seg] if seg.starts_with("id_"));
                let rows = fetch_resource_rows(&request.uri).await?;
                json_value_resource(
                    rows_to_value::<Album>(rows, is_single, &request.uri)?,
                    request.uri,
                )
            }
            "tasks" => {
                let is_single = matches!(segments.as_slice(), [seg] if seg.starts_with("id_"));
                let rows = fetch_resource_rows(&request.uri).await?;
                json_value_resource(
                    rows_to_value::<TaskInfo>(rows, is_single, &request.uri)?,
                    request.uri,
                )
            }
            "surf_records" => {
                let is_single = matches!(segments.as_slice(), [seg] if seg.starts_with("id_"));
                let rows = fetch_resource_rows(&request.uri).await?;
                json_value_resource(
                    rows_to_value::<SurfRecord>(rows, is_single, &request.uri)?,
                    request.uri,
                )
            }
            "plugin" => {
                let rows = fetch_resource_rows(&request.uri).await?;
                match segments.as_slice() {
                    [] => json_value_resource(Value::Array(rows), request.uri),
                    [_plugin_id] => {
                        let value = rows.into_iter().next().ok_or_else(|| {
                            McpError::resource_not_found(
                                "plugin_not_found",
                                Some(json!({ "uri": request.uri })),
                            )
                        })?;
                        json_value_resource(value, request.uri)
                    }
                    [_plugin_id, "icon"] => {
                        let row = rows.into_iter().next().ok_or_else(|| {
                            McpError::resource_not_found(
                                "no_icon",
                                Some(json!({ "uri": request.uri })),
                            )
                        })?;
                        let data = row
                            .get("iconPngBase64")
                            .and_then(Value::as_str)
                            .ok_or_else(|| {
                                McpError::resource_not_found(
                                    "no_icon",
                                    Some(json!({ "uri": request.uri })),
                                )
                            })?;
                        Ok(ReadResourceResult::new(vec![ResourceContents::blob(
                            data.to_string(),
                            request.uri,
                        )
                        .with_mime_type("image/png")]))
                    }
                    [_plugin_id, "description_template"] => {
                        let row = rows.into_iter().next().ok_or_else(|| {
                            McpError::resource_not_found(
                                "no_description_template",
                                Some(json!({ "uri": request.uri })),
                            )
                        })?;
                        let text = row
                            .get("descriptionTemplate")
                            .and_then(Value::as_str)
                            .ok_or_else(|| {
                                McpError::resource_not_found(
                                    "no_description_template",
                                    Some(json!({ "uri": request.uri })),
                                )
                            })?;
                        Ok(ReadResourceResult::new(vec![ResourceContents::text(
                            text.to_string(),
                            request.uri,
                        )
                        .with_mime_type("text/plain")]))
                    }
                    [_plugin_id, "doc"] => {
                        let row = rows.into_iter().next().ok_or_else(|| {
                            McpError::resource_not_found(
                                "no_plugin_doc",
                                Some(json!({ "uri": request.uri })),
                            )
                        })?;
                        let text = row.get("doc").and_then(Value::as_str).ok_or_else(|| {
                            McpError::resource_not_found(
                                "no_plugin_doc",
                                Some(json!({ "uri": request.uri })),
                            )
                        })?;
                        Ok(ReadResourceResult::new(vec![ResourceContents::text(
                            text.to_string(),
                            request.uri,
                        )
                        .with_mime_type("text/markdown")]))
                    }
                    [_plugin_id, "doc_resource", _key] => {
                        let row = rows.into_iter().next().ok_or_else(|| {
                            McpError::resource_not_found(
                                "doc_resource_not_found",
                                Some(json!({ "uri": request.uri })),
                            )
                        })?;
                        let data =
                            row.get("dataBase64")
                                .and_then(Value::as_str)
                                .ok_or_else(|| {
                                    McpError::resource_not_found(
                                        "doc_resource_not_found",
                                        Some(json!({ "uri": request.uri })),
                                    )
                                })?;
                        let mime = row
                            .get("mime")
                            .and_then(Value::as_str)
                            .unwrap_or("application/octet-stream");
                        Ok(ReadResourceResult::new(vec![ResourceContents::blob(
                            data.to_string(),
                            request.uri,
                        )
                        .with_mime_type(mime)]))
                    }
                    _ => Err(McpError::resource_not_found(
                        "invalid_plugin_path",
                        Some(json!({ "uri": request.uri })),
                    )),
                }
            }
            _ => Err(McpError::resource_not_found(
                "unknown_scheme",
                Some(json!({ "uri": request.uri })),
            )),
        }
    }

    async fn list_resource_templates(
        &self,
        _request: Option<PaginatedRequestParams>,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<ListResourceTemplatesResult, McpError> {
        let disabled = Settings::global().get_mcp_disabled_capabilities();
        Ok(ListResourceTemplatesResult {
            next_cursor: None,
            resource_templates: vec![
                (
                    "images.read.by_id",
                    RawResourceTemplate::new("images://id_{imageId}", "Image info")
                        .with_description(
                            "Full ImageInfo for a single image including metadataId.",
                        )
                        .with_mime_type("application/json")
                        .no_annotation(),
                ),
                (
                    "images.read.metadata",
                    RawResourceTemplate::new("images://id_{imageId}/metadata", "Image metadata")
                        .with_description(
                            "Crawl-time metadata — can be 10s of KB (tags, author, URLs, etc.).",
                        )
                        .with_mime_type("application/json")
                        .no_annotation(),
                ),
                (
                    "albums.read.by_id",
                    RawResourceTemplate::new("albums://id_{albumId}", "Album info")
                        .with_description("Full album object: id, name, parentId, createdAt.")
                        .with_mime_type("application/json")
                        .no_annotation(),
                ),
                (
                    "tasks.read.by_id",
                    RawResourceTemplate::new("tasks://id_{taskId}", "Task info")
                        .with_description(
                            "Full task object: id, pluginId, status, progress, counts, etc.",
                        )
                        .with_mime_type("application/json")
                        .no_annotation(),
                ),
                (
                    "surf_records.read.by_id",
                    RawResourceTemplate::new(
                        "surf_records://id_{surfRecordId}",
                        "Surf record info",
                    )
                    .with_description(
                        "Full surf record: id, host, name, imageCount, lastVisitAt, etc.",
                    )
                    .with_mime_type("application/json")
                    .no_annotation(),
                ),
                (
                    "plugin.read.info",
                    RawResourceTemplate::new("plugin://{pluginId}", "Plugin info (trimmed)")
                        .with_description(
                            "Plugin metadata without docResources/iconPngBase64/descriptionTemplate. \
                             Fetch those via sub-path resources on demand.",
                        )
                        .with_mime_type("application/json")
                        .no_annotation(),
                ),
                (
                    "plugin.read.doc",
                    RawResourceTemplate::new("plugin://{pluginId}/doc", "Plugin documentation")
                        .with_description("Plugin doc.md content in Markdown (default locale).")
                        .with_mime_type("text/markdown")
                        .no_annotation(),
                ),
                (
                    "plugin.read.icon",
                    RawResourceTemplate::new("plugin://{pluginId}/icon", "Plugin icon")
                        .with_description("Plugin icon as base64-encoded PNG.")
                        .with_mime_type("image/png")
                        .no_annotation(),
                ),
                (
                    "plugin.read.description_template",
                    RawResourceTemplate::new(
                        "plugin://{pluginId}/description_template",
                        "Plugin description template",
                    )
                    .with_description("EJS template used to render plugin descriptions.")
                    .with_mime_type("text/plain")
                    .no_annotation(),
                ),
                (
                    "plugin.read.doc_resource",
                    RawResourceTemplate::new(
                        "plugin://{pluginId}/doc_resource/{resourceKey}",
                        "Plugin doc resource",
                    )
                    .with_description(
                        "A single doc_resource (e.g. images referenced by doc.md); mime inferred by extension.",
                    )
                    .no_annotation(),
                ),
            ]
            .into_iter()
            .filter_map(|(id, template)| {
                is_capability_enabled(id, &disabled).then_some(template)
            })
            .collect(),
            meta: None,
        })
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        let disabled = Settings::global().get_mcp_disabled_capabilities();
        Ok(ListToolsResult {
            tools: vec![
                (
                    "set_album_images_order",
                    Tool::new(
                        "set_album_images_order",
                        "Set the manual display order of images in an album. \
                         Process one page (up to 100 images) at a time; call repeatedly for larger albums.",
                        object(json!({
                            "type": "object",
                            "properties": {
                                "album_id": { "type": "string", "description": "Album ID" },
                                "image_orders": {
                                    "type": "array",
                                    "description": "Images to reorder. order values are integers; \
                                                    lower values appear first.",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "image_id": { "type": "string" },
                                            "order":    { "type": "integer" }
                                        },
                                        "required": ["image_id", "order"]
                                    }
                                }
                            },
                            "required": ["album_id", "image_orders"]
                        })),
                    ),
                ),
                (
                    "create_album",
                    Tool::new(
                        "create_album",
                        "Create a new album. Optionally specify a parent album ID to create a nested album.",
                        object(json!({
                            "type": "object",
                            "properties": {
                                "name":      { "type": "string", "description": "Album display name" },
                                "parent_id": { "type": "string", "description": "Parent album ID (omit for root album)" }
                            },
                            "required": ["name"]
                        })),
                    ),
                ),
                (
                    "add_images_to_album",
                    Tool::new(
                        "add_images_to_album",
                        "Add images to an album. Images already in the album are silently skipped. \
                         Optionally set per-image order values at the same time (otherwise order is \
                         auto-assigned after the current last image).",
                        object(json!({
                            "type": "object",
                            "properties": {
                                "album_id":  { "type": "string" },
                                "image_ids": { "type": "array", "items": { "type": "string" } },
                                "image_orders": {
                                    "type": "array",
                                    "description": "Optional: set order for specific images after adding.",
                                    "items": {
                                        "type": "object",
                                        "properties": {
                                            "image_id": { "type": "string" },
                                            "order":    { "type": "integer" }
                                        },
                                        "required": ["image_id", "order"]
                                    }
                                }
                            },
                            "required": ["album_id", "image_ids"]
                        })),
                    ),
                ),
                (
                    "rename_image",
                    Tool::new(
                        "rename_image",
                        "Update the display name of an image.",
                        object(json!({
                            "type": "object",
                            "properties": {
                                "image_id":     { "type": "string" },
                                "display_name": { "type": "string" }
                            },
                            "required": ["image_id", "display_name"]
                        })),
                    ),
                ),
            ]
            .into_iter()
            .filter_map(|(name, tool)| {
                capability_for_tool(name)
                    .is_none_or(|id| is_capability_enabled(id, &disabled))
                    .then_some(tool)
            })
            .collect(),
            next_cursor: None,
            meta: None,
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let disabled = Settings::global().get_mcp_disabled_capabilities();
        if let Some(id) = capability_for_tool(request.name.as_ref()) {
            if !is_capability_enabled(id, &disabled) {
                return Err(disabled_tool_error(request.name.as_ref()));
            }
        }

        match request.name.as_ref() {
            "set_album_images_order" => {
                #[derive(serde::Deserialize)]
                struct Args {
                    album_id: String,
                    image_orders: Vec<ImageOrder>,
                }
                #[derive(serde::Deserialize)]
                struct ImageOrder {
                    image_id: String,
                    order: i64,
                }

                let args: Args = parse_args(request.arguments)?;

                let count = args.image_orders.len();
                let pairs: Vec<(String, i64)> = args
                    .image_orders
                    .into_iter()
                    .map(|o| (o.image_id, o.order))
                    .collect();

                Storage::global()
                    .update_album_images_order(&args.album_id, &pairs)
                    .map_err(|e| McpError::internal_error(e, None))?;

                Ok(CallToolResult::success(vec![Content::text(format!(
                    "Updated order for {count} images in album '{}'. \
                     To see the new arrangement, open this album in Kabegame \
                     and switch the sort mode to '加入顺序' (album-order / join order).",
                    args.album_id
                ))]))
            }
            "create_album" => {
                #[derive(serde::Deserialize)]
                struct Args {
                    name: String,
                    parent_id: Option<String>,
                }
                let args: Args = parse_args(request.arguments)?;
                let album = Storage::global()
                    .add_album(&args.name, args.parent_id.as_deref())
                    .map_err(|e| McpError::internal_error(e, None))?;
                Ok(CallToolResult::success(vec![Content::text(
                    serde_json::to_string(&album).unwrap_or_default(),
                )]))
            }
            "add_images_to_album" => {
                #[derive(serde::Deserialize)]
                struct Args {
                    album_id: String,
                    image_ids: Vec<String>,
                    image_orders: Option<Vec<ImageOrderEntry>>,
                }
                #[derive(serde::Deserialize)]
                struct ImageOrderEntry {
                    image_id: String,
                    order: i64,
                }
                let args: Args = parse_args(request.arguments)?;

                Storage::global()
                    .ensure_album_is_writable(&args.album_id)
                    .map_err(|e| McpError::internal_error(e, None))?;

                let result = Storage::global()
                    .add_images_to_album(&args.album_id, &args.image_ids)
                    .map_err(|e| McpError::internal_error(e, None))?;

                if let Some(orders) = &args.image_orders {
                    let pairs: Vec<(String, i64)> = orders
                        .iter()
                        .map(|o| (o.image_id.clone(), o.order))
                        .collect();
                    Storage::global()
                        .update_album_images_order(&args.album_id, &pairs)
                        .map_err(|e| McpError::internal_error(e, None))?;
                }

                if result.added > 0 {
                    GlobalEmitter::global().emit_album_images_change(
                        "add",
                        &[args.album_id.clone()],
                        &args.image_ids,
                    );
                }

                Ok(CallToolResult::success(vec![Content::text(format!(
                    "Added {}/{} images to album '{}'.",
                    result.added, result.attempted, args.album_id
                ))]))
            }
            "rename_image" => {
                #[derive(serde::Deserialize)]
                struct Args {
                    image_id: String,
                    display_name: String,
                }
                let args: Args = parse_args(request.arguments)?;
                Storage::global()
                    .update_image_display_name(&args.image_id, &args.display_name)
                    .map_err(|e| McpError::internal_error(e, None))?;
                let plugin_ids = Storage::find_image_by_id(&args.image_id)
                    .ok()
                    .flatten()
                    .and_then(|image| image.plugin_id)
                    .map(|plugin_id| vec![plugin_id])
                    .unwrap_or_default();
                GlobalEmitter::global().emit_images_change(
                    "rename",
                    &[args.image_id.clone()],
                    None,
                    None,
                    Some(&plugin_ids),
                );
                Ok(CallToolResult::success(vec![Content::text(format!(
                    "Renamed image '{}' to '{}'.",
                    args.image_id, args.display_name
                ))]))
            }
            _ => Err(McpError::new(
                ErrorCode::METHOD_NOT_FOUND,
                format!("unknown tool: {}", request.name),
                None,
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{resource_scheme, resource_segments};

    #[test]
    fn resource_scheme_parses_scheme_prefix() {
        assert_eq!(resource_scheme("images://id_1").unwrap(), "images");
        assert!(resource_scheme("id_1").is_err());
    }

    #[test]
    fn resource_segments_split_after_scheme() {
        assert_eq!(
            resource_segments("plugin://pixiv/doc_resource/readme.png"),
            vec!["pixiv", "doc_resource", "readme.png"]
        );
        assert!(resource_segments("plugin://").is_empty());
    }
}

/// Returns a Router with `/mcp` (StreamableHTTP) nested, usable by both local and web modes.
pub fn mcp_nest() -> axum::Router {
    use rmcp::transport::streamable_http_server::{
        session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
    };

    let service = StreamableHttpService::new(
        || Ok(KabegameMcpServer),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default(),
    );

    axum::Router::new().nest_service("/mcp", service)
}
