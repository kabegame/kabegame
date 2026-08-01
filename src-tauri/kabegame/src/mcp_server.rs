//! MCP 的 `plugin://{id}/asset/{path}` 中，path 是归一化后的插件根相对路径；
//! 资源来自 `kbAssets`，由文档与更新日志共用。
//! `plugin://{id}/provider` 列出插件贡献的 PathQL provider；
//! `plugin://{id}/provider/{name}` 返回完整定义及其 DSL 源文。

use kabegame_core::{
    emitter::GlobalEmitter,
    providers::{child_runtime_path, provider_runtime},
    settings::Settings,
    storage::{Album, ImageInfo, Storage, SurfRecord, TaskInfo},
};
use pathql_rs::EngineError;
use percent_encoding::percent_decode_str;
use rmcp::{
    model::{
        object, CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ErrorCode,
        Implementation, ListResourceTemplatesResult, ListResourcesResult, ListToolsResult,
        PaginatedRequestParams, ReadResourceRequestParams, ReadResourceResponse,
        ReadResourceResult, Resource, ResourceContents, ResourceTemplate, ServerCapabilities,
        ServerInfo, Tool, ToolAnnotations,
    },
    service::RequestContext,
    ErrorData as McpError, RoleServer, ServerHandler,
};
use serde_json::{json, Value};

use crate::mcp_capabilities::{
    all_mcp_capabilities, capability_for_tool, is_capability_enabled, read_capability_id,
    McpCapabilityKind,
};

pub const MCP_PORT: u16 = 7490;

const MCP_INSTRUCTIONS: &str = r#"Kabegame read resources form a LAZY TREE. resources/list does NOT enumerate the
gallery: use list_pathql_entry to walk PathQL one level at a time, then read a bounded leaf.

Discovery loop:
1. list_pathql_entry("images://gallery") to discover dimensions and read their notes.
2. list_pathql_entry("gallery/plugin") to discover installed plugin children.
3. Copy a returned child.path verbatim, append /desc/x100x/1 when needed, and pass the
   resulting URI to resources/read, for example:
   images://gallery/plugin/<id>/desc/x100x/1
Do not re-encode child.path. Paths without :// passed to list_pathql_entry are promoted to
images:// paths.
Use offset and limit to page large child lists; limit is capped at 200. include_counts defaults
to false and is honored only when the returned window contains at most 50 children, preventing
an accidental fan-out of expensive COUNT queries.

NEVER GUESS IMAGE IDS. Discover a bounded gallery collection first and use the returned
ImageInfo.id values. Do not probe images://id_20000, images://id_23000, or similar guesses.

PathQL gallery grammar:
- Every segment narrows the result of the previous segment; filters accumulated along a path
  are combined with AND. Path segments are case-sensitive.
- filter_comb combines two dimensions, for example:
  images://gallery/plugin/patreon/filter_comb/media-type/image/desc/x100x/1
- sort is a sibling of all, not a child: use gallery/sort/<key>/..., never gallery/all/sort/...
- /desc reverses the current order.
- hide/ is a prefix that excludes hidden images, for example gallery/hide/all/desc/x100x/1.
- Common starts:
  gallery/all
  gallery/plugin/<pluginId>
  gallery/album/<albumId>
  gallery/date/<YYYY>y/<MM>m/<DD>d
  gallery/search/display-name/<query>/all
  gallery/sort/<key>
- For every other dimension or legal continuation, list the current node and read each
  returned note instead of inventing syntax.

Pagination is mandatory for collection reads:
- Always end collection URIs with /x<N>x/<page>, normally /x100x/1.
- An unpaginated images read exceeding 500 rows is rejected with pagination_required.
- The page count is ceil(total / N); list_pathql_entry returns total when count succeeds.
- Do NOT list a pagination node. Its page provider may materialize the full result set.
  Compute page numbers from total and read each page URI directly.
- A search term that is itself all digits can look like a page segment; still append explicit
  /x<N>x/<page> pagination after completing the search path.

Image read resources:
  images://gallery/all/desc/x100x/1      first bounded gallery page with gallery joins
  images://gallery/by_id/{id}            one ImageInfo with gallery-computed fields
  images://id_{id}                       one raw ImageInfo
  images://id_{id}/metadata              crawl-time metadata; can be tens of KB
  images://x100x/1                       first 100 raw rows, without gallery joins

Other read schemes:
  albums://all                           all Albums (Vec<Album>)
  albums://id_{id}                       one Album
  tasks://all                            all Tasks (Vec<TaskInfo>)
  tasks://id_{id}                        one TaskInfo
  surf_records://all                     all SurfRecords (Vec<SurfRecord>)
  surf_records://id_{id}                 one SurfRecord
  plugin://                              all Plugins, trimmed
  plugin://{id}                          one Plugin, trimmed
  plugin://{id}/icon                     base64 PNG blob
  plugin://{id}/description_template     EJS template
  plugin://{id}/doc                      default-locale doc.md
  plugin://{id}/changelog                default-locale CHANGELOG.md
  plugin://{id}/asset/{path}             one plugin asset, MIME by extension
  plugin://{id}/provider                 list of PathQL providers this plugin contributes
  plugin://{id}/provider/{name}          one provider def + its DSL source

For asset, path is the normalized plugin-root-relative path declared in kbAssets. Documentation
and changelogs share these entries. "Trimmed" plugin JSON has assets, iconPngBase64, and
descriptionTemplate removed; fetch those heavy resources through the sub-paths above.

Do not use provider://, image://, album://, task://, or surf://. They are not supported.

ImageInfo fields (camelCase):
  id, url, localPath, pluginId, taskId, surfRecordId, crawledAt (Unix seconds),
  metadataId, pluginVersion, thumbnailPath, favorite, isHidden, localExists, hash,
  width, height, displayName, type, lastSetWallpaperAt, size, albumOrder,
  compatiblePath, postUrl.
type is a stored media format such as "image/jpg" or "video/mp4"; the key is `type`, not
`mediaType`. Use images://id_{id}/metadata for crawl-time JSON metadata.
favorite, isHidden, and albumOrder are computed only on images://gallery/... paths.
On images://id_{id} they are always false, false, and null; use
images://gallery/by_id/{id} when those values are needed.

Plugin package layout, in brief: package.json declares kbBackend: v8, and kbAssets lists
plugin-root-relative resource paths; dist/main.js exports async function crawl; kbDoc points
to documentation files; icon.png is optional.

Tools:
- list_pathql_entry is the read-only discovery tool described above.
- set_album_images_order sets manual order, up to 100 images per call. Open the album in
  Kabegame and switch to album-order to see it.
- create_album creates an album; add_images_to_album adds images; rename_image renames one.

IMPORTANT — actions that are NOT supported:
- Deleting images is not possible. If the user asks to delete images, explain that this
  action is unavailable through MCP, and offer to collect them into an album such as "待删除"
  so the user can review and delete them manually in the app.
- Deleting albums is not possible. If the user asks to delete an album, explain that this
  action is unavailable, and offer to move its contents into another album or nest it inside
  another album using create_album + add_images_to_album.
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
            let mut segments = Vec::new();
            let mut start = 0;
            let mut escaped = false;
            for (index, ch) in rest.char_indices() {
                if escaped {
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if ch == '/' {
                    if start < index {
                        segments.push(&rest[start..index]);
                    }
                    start = index + ch.len_utf8();
                }
            }
            if start < rest.len() {
                segments.push(&rest[start..]);
            }
            segments
        })
        .unwrap_or_default()
}

/// 剥掉 MCP URI 的 percent 传输层，得到可直接交给 PathQL runtime 的引擎语法路径。
///
/// percent 编码属于 URI 传输层，反斜线转义属于 PathQL 引擎语法层；这里仅按 `/`
/// 切分 URI 并 percent-decode 一次，不再调用 `escape_path_segment`。客户端若要表达段内
/// 字面 `/`，应先做引擎转义再做 URI 编码，即发送 `%5C%2F`；直接发送 `%2F` 会在解码后
/// 被引擎解释为路径分隔符。
fn normalize_mcp_uri_path(path: &str) -> String {
    path.split('/')
        .map(|segment| {
            if segment.contains('%') {
                percent_decode_str(segment).decode_utf8_lossy().into_owned()
            } else {
                segment.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn is_any_read_capability_enabled(disabled: &[String]) -> bool {
    all_mcp_capabilities().iter().any(|capability| {
        capability.kind == McpCapabilityKind::Read && is_capability_enabled(capability.id, disabled)
    })
}

fn is_uri_capability_enabled(uri: &str, disabled: &[String]) -> bool {
    let Ok(scheme) = resource_scheme(uri) else {
        return false;
    };
    let segments = resource_segments(uri);
    match read_capability_id(scheme, segments.as_slice()) {
        Some(id) => is_capability_enabled(id, disabled),
        None => all_mcp_capabilities().iter().any(|capability| {
            capability.category == scheme
                && capability.kind == McpCapabilityKind::Read
                && is_capability_enabled(capability.id, disabled)
        }),
    }
}

fn disabled_resource_error(uri: &str) -> McpError {
    McpError::resource_not_found("resource_disabled", Some(json!({ "uri": uri })))
}

fn disabled_tool_error(tool: &str) -> McpError {
    McpError::invalid_request("tool_disabled", Some(json!({ "tool": tool })))
}

fn pathql_error(error: EngineError) -> McpError {
    match error {
        EngineError::PathNotFound(_)
        | EngineError::NoProvider(_)
        | EngineError::SchemaNotFound(_) => {
            McpError::resource_not_found("resource_not_found", None)
        }
        other => McpError::internal_error(format!("pathql: {other}"), None),
    }
}

async fn fetch_resource_rows(uri: &str) -> Result<Vec<Value>, McpError> {
    let rt = provider_runtime().clone();
    let uri = uri.to_string();
    tokio::task::spawn_blocking(move || rt.fetch(&uri))
        .await
        .map_err(|e| McpError::internal_error(e.to_string(), None))?
        .map_err(pathql_error)
}

fn is_paginated_image_path(segments: &[&str]) -> bool {
    segments
        .last()
        .is_some_and(|segment| !segment.is_empty() && segment.chars().all(|ch| ch.is_ascii_digit()))
}

async fn enforce_image_pagination(uri: &str, segments: &[&str]) -> Result<(), McpError> {
    const MAX_ROWS: usize = 500;

    let is_single = matches!(segments, [segment] if segment.starts_with("id_"));
    if is_single || is_paginated_image_path(segments) {
        return Ok(());
    }

    let rt = provider_runtime().clone();
    let count_uri = uri.to_string();
    let total = tokio::task::spawn_blocking(move || rt.count(&count_uri))
        .await
        .map_err(|e| McpError::internal_error(e.to_string(), None))?
        .map_err(pathql_error)?;
    if total > MAX_ROWS {
        return Err(McpError::invalid_params(
            "pagination_required",
            Some(json!({
                "uri": uri,
                "total": total,
                "maxRows": MAX_ROWS,
                "howTo": "Append /x<N>x/<page> to the completed collection path, for example /x100x/1."
            })),
        ));
    }
    Ok(())
}

fn normalize_pathql_uri(path: &str) -> String {
    let path = path.trim();
    if path.contains("://") {
        path.to_string()
    } else if path.is_empty() {
        "images://".to_string()
    } else {
        format!("images://{}", path.trim_start_matches('/'))
    }
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
) -> Result<ReadResourceResponse, McpError> {
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

fn json_resource(json: String, uri: impl Into<String>) -> Result<ReadResourceResponse, McpError> {
    Ok(ReadResourceResult::new(vec![
        ResourceContents::text(json, uri).with_mime_type("application/json")
    ])
    .into())
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
                "images://gallery/all/desc/x100x/1",
                Resource::new(
                    "images://gallery/all/desc/x100x/1",
                    "Gallery images (first page)",
                )
                .with_description("First 100 gallery rows in descending order")
                .with_mime_type("application/json"),
            ),
            (
                "images://x100x/1",
                Resource::new("images://x100x/1", "Raw image rows")
                    .with_description(
                        "First 100 raw rows from images, without album/favorite joins",
                    )
                    .with_mime_type("application/json"),
            ),
            (
                "albums://all",
                Resource::new("albums://all", "All albums")
                    .with_description("Full list of albums (Vec<Album>)")
                    .with_mime_type("application/json"),
            ),
            (
                "tasks://all",
                Resource::new("tasks://all", "All tasks")
                    .with_description("Full list of tasks (Vec<TaskInfo>)")
                    .with_mime_type("application/json"),
            ),
            (
                "surf_records://all",
                Resource::new("surf_records://all", "All surf records")
                    .with_description("Full list of surf records (Vec<SurfRecord>)")
                    .with_mime_type("application/json"),
            ),
            (
                "plugin://",
                Resource::new("plugin://", "All plugins (trimmed)")
                    .with_description(
                        "Full list of installed plugins with heavy fields (assets, \
                         iconPngBase64, descriptionTemplate) stripped",
                    )
                    .with_mime_type("application/json"),
            ),
        ]
        .into_iter()
        .filter_map(|(uri, resource)| is_uri_capability_enabled(uri, &disabled).then_some(resource))
        .collect();

        Ok(ListResourcesResult {
            resources,
            next_cursor: None,
            meta: None,
            ..Default::default()
        })
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResponse, McpError> {
        let runtime_uri = normalize_mcp_uri_path(&request.uri);
        let scheme = resource_scheme(&runtime_uri)?;
        let segments = resource_segments(&runtime_uri);
        let disabled = Settings::global().get_mcp_disabled_capabilities();
        if !is_uri_capability_enabled(&runtime_uri, &disabled) {
            return Err(disabled_resource_error(&request.uri));
        }

        match scheme {
            "images" => {
                let is_metadata = segments.len() == 2
                    && segments.first().is_some_and(|seg| seg.starts_with("id_"))
                    && segments[1] == "metadata";
                let is_single = segments.len() == 1
                    && segments.first().is_some_and(|seg| seg.starts_with("id_"));
                enforce_image_pagination(&runtime_uri, segments.as_slice()).await?;
                let rows = fetch_resource_rows(&runtime_uri).await?;
                let value = if is_metadata {
                    metadata_rows_to_value(rows, &request.uri)?
                } else {
                    image_rows_to_value(rows, is_single, &request.uri)?
                };
                json_value_resource(value, request.uri)
            }
            "albums" => {
                let is_single = matches!(segments.as_slice(), [seg] if seg.starts_with("id_"));
                let rows = fetch_resource_rows(&runtime_uri).await?;
                json_value_resource(
                    rows_to_value::<Album>(rows, is_single, &request.uri)?,
                    request.uri,
                )
            }
            "tasks" => {
                let is_single = matches!(segments.as_slice(), [seg] if seg.starts_with("id_"));
                let rows = fetch_resource_rows(&runtime_uri).await?;
                json_value_resource(
                    rows_to_value::<TaskInfo>(rows, is_single, &request.uri)?,
                    request.uri,
                )
            }
            "surf_records" => {
                let is_single = matches!(segments.as_slice(), [seg] if seg.starts_with("id_"));
                let rows = fetch_resource_rows(&runtime_uri).await?;
                json_value_resource(
                    rows_to_value::<SurfRecord>(rows, is_single, &request.uri)?,
                    request.uri,
                )
            }
            "plugin" => {
                let rows = fetch_resource_rows(&runtime_uri).await?;
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
                        .with_mime_type("image/png")])
                        .into())
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
                        .with_mime_type("text/plain")])
                        .into())
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
                        .with_mime_type("text/markdown")])
                        .into())
                    }
                    [_plugin_id, "changelog"] => {
                        let row = rows.into_iter().next().ok_or_else(|| {
                            McpError::resource_not_found(
                                "no_plugin_changelog",
                                Some(json!({ "uri": request.uri })),
                            )
                        })?;
                        let text =
                            row.get("changelog")
                                .and_then(Value::as_str)
                                .ok_or_else(|| {
                                    McpError::resource_not_found(
                                        "no_plugin_changelog",
                                        Some(json!({ "uri": request.uri })),
                                    )
                                })?;
                        Ok(ReadResourceResult::new(vec![ResourceContents::text(
                            text.to_string(),
                            request.uri,
                        )
                        .with_mime_type("text/markdown")])
                        .into())
                    }
                    [_plugin_id, "asset", _path] => {
                        let row = rows.into_iter().next().ok_or_else(|| {
                            McpError::resource_not_found(
                                "asset_not_found",
                                Some(json!({ "uri": request.uri })),
                            )
                        })?;
                        let data =
                            row.get("dataBase64")
                                .and_then(Value::as_str)
                                .ok_or_else(|| {
                                    McpError::resource_not_found(
                                        "asset_not_found",
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
                        .with_mime_type(mime)])
                        .into())
                    }
                    [_plugin_id, "provider"] => {
                        let value = serde_json::to_value(rows)
                            .map_err(|e| McpError::internal_error(e.to_string(), None))?;
                        json_value_resource(value, request.uri)
                    }
                    [_plugin_id, "provider", _name] => {
                        let row = rows.into_iter().next().ok_or_else(|| {
                            McpError::resource_not_found(
                                "provider_not_found",
                                Some(json!({ "uri": request.uri })),
                            )
                        })?;
                        json_value_resource(row, request.uri)
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
                    ResourceTemplate::new("images://id_{imageId}", "Image info")
                        .with_description("Full ImageInfo for a single image including metadataId.")
                        .with_mime_type("application/json"),
                ),
                (
                    "images.read.metadata",
                    ResourceTemplate::new("images://id_{imageId}/metadata", "Image metadata")
                        .with_description(
                            "Crawl-time metadata — can be 10s of KB (tags, author, URLs, etc.).",
                        )
                        .with_mime_type("application/json"),
                ),
                (
                    "images.read.gallery",
                    ResourceTemplate::new(
                        "images://gallery/plugin/{pluginId}/desc/x100x/{page}",
                        "Gallery images by plugin",
                    )
                    .with_description(
                        "A descending 100-row gallery page filtered by crawler plugin.",
                    )
                    .with_mime_type("application/json"),
                ),
                (
                    "images.read.gallery",
                    ResourceTemplate::new(
                        "images://gallery/album/{albumId}/desc/x100x/{page}",
                        "Gallery images by album",
                    )
                    .with_description("A descending 100-row gallery page filtered by album.")
                    .with_mime_type("application/json"),
                ),
                (
                    "images.read.gallery",
                    ResourceTemplate::new(
                        "images://gallery/date/{year}y/{month}m/{day}d/desc/x100x/{page}",
                        "Gallery images by date",
                    )
                    .with_description("A descending 100-row gallery page filtered by crawl date.")
                    .with_mime_type("application/json"),
                ),
                (
                    "images.read.gallery",
                    ResourceTemplate::new(
                        "images://gallery/search/display-name/{query}/all/desc/x100x/{page}",
                        "Search gallery display names",
                    )
                    .with_description(
                        "A descending 100-row page whose display names contain the query.",
                    )
                    .with_mime_type("application/json"),
                ),
                (
                    "images.read.gallery",
                    ResourceTemplate::new(
                        "images://gallery/by_id/{imageId}",
                        "Gallery image by ID",
                    )
                    .with_description(
                        "One ImageInfo with favorite, isHidden, and albumOrder computed.",
                    )
                    .with_mime_type("application/json"),
                ),
                (
                    "albums.read.by_id",
                    ResourceTemplate::new("albums://id_{albumId}", "Album info")
                        .with_description("Full album object: id, name, parentId, createdAt.")
                        .with_mime_type("application/json"),
                ),
                (
                    "tasks.read.by_id",
                    ResourceTemplate::new("tasks://id_{taskId}", "Task info")
                        .with_description(
                            "Full task object: id, pluginId, status, progress, counts, etc.",
                        )
                        .with_mime_type("application/json"),
                ),
                (
                    "surf_records.read.by_id",
                    ResourceTemplate::new("surf_records://id_{surfRecordId}", "Surf record info")
                        .with_description("Full surf record: id, host, name, lastVisitAt, etc.")
                        .with_mime_type("application/json"),
                ),
                (
                    "plugin.read.info",
                    ResourceTemplate::new("plugin://{pluginId}", "Plugin info (trimmed)")
                        .with_description(
                            "Plugin metadata without assets/iconPngBase64/descriptionTemplate. \
                             Fetch those via sub-path resources on demand.",
                        )
                        .with_mime_type("application/json"),
                ),
                (
                    "plugin.read.doc",
                    ResourceTemplate::new("plugin://{pluginId}/doc", "Plugin documentation")
                        .with_description("Plugin doc.md content in Markdown (default locale).")
                        .with_mime_type("text/markdown"),
                ),
                (
                    "plugin.read.changelog",
                    ResourceTemplate::new("plugin://{pluginId}/changelog", "Plugin changelog")
                        .with_description(
                            "Plugin CHANGELOG.md content in Markdown (default locale).",
                        )
                        .with_mime_type("text/markdown"),
                ),
                (
                    "plugin.read.icon",
                    ResourceTemplate::new("plugin://{pluginId}/icon", "Plugin icon")
                        .with_description("Plugin icon as base64-encoded PNG.")
                        .with_mime_type("image/png"),
                ),
                (
                    "plugin.read.description_template",
                    ResourceTemplate::new(
                        "plugin://{pluginId}/description_template",
                        "Plugin description template",
                    )
                    .with_description("EJS template used to render plugin descriptions.")
                    .with_mime_type("text/plain"),
                ),
                (
                    "plugin.read.asset",
                    ResourceTemplate::new("plugin://{pluginId}/asset/{assetPath}", "Plugin asset")
                        .with_description(
                        "A single asset. assetPath is the normalized plugin-root-relative path \
                         declared in kbAssets; documentation and changelogs share these entries. \
                         MIME is inferred by extension.",
                    ),
                ),
                (
                    "plugin.read.provider",
                    ResourceTemplate::new(
                        "plugin://{pluginId}/provider",
                        "Plugin PathQL providers",
                    )
                    .with_description(
                        "List of PathQL provider definitions this plugin contributes (name, \
                         namespace, sourcePath, note summary).",
                    )
                    .with_mime_type("application/json"),
                ),
                (
                    "plugin.read.provider",
                    ResourceTemplate::new(
                        "plugin://{pluginId}/provider/{name}",
                        "Plugin PathQL provider detail",
                    )
                    .with_description(
                        "One provider's full structured definition plus its raw DSL source text \
                         (source is null for the application-injected default entry_provider).",
                    )
                    .with_mime_type("application/json"),
                ),
            ]
            .into_iter()
            .filter_map(|(id, template)| is_capability_enabled(id, &disabled).then_some(template))
            .collect(),
            meta: None,
            ..Default::default()
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
                    "list_pathql_entry",
                    Tool::new(
                        "list_pathql_entry",
                        "List one level of Kabegame's lazy PathQL resource tree. \
                         resources/list does not enumerate the gallery. Every returned child.path \
                         can be copied directly into resources/read or walked with this tool. \
                         NEVER guess numeric image ids; discover paths and bounded pages here.",
                        object(json!({
                            "type": "object",
                            "properties": {
                                "path": {
                                    "type": "string",
                                    "description": "PathQL URI. Paths without :// are promoted to images://."
                                },
                                "include_counts": {
                                    "type": "boolean",
                                    "default": false,
                                    "description": "Count each returned child only when the requested window has at most 50 children."
                                },
                                "offset": {
                                    "type": "integer",
                                    "minimum": 0,
                                    "default": 0
                                },
                                "limit": {
                                    "type": "integer",
                                    "minimum": 0,
                                    "maximum": 200,
                                    "default": 100
                                }
                            },
                            "required": ["path"]
                        })),
                    )
                    .annotate(
                        ToolAnnotations::new()
                            .read_only(true)
                            .idempotent(true),
                    ),
                ),
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
                    .map_or_else(
                        || is_any_read_capability_enabled(&disabled),
                        |id| is_capability_enabled(id, &disabled),
                    )
                    .then_some(tool)
            })
            .collect(),
            next_cursor: None,
            meta: None,
            ..Default::default()
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let disabled = Settings::global().get_mcp_disabled_capabilities();
        if let Some(id) = capability_for_tool(request.name.as_ref()) {
            if !is_capability_enabled(id, &disabled) {
                return Err(disabled_tool_error(request.name.as_ref()));
            }
        }

        match request.name.as_ref() {
            "list_pathql_entry" => {
                #[derive(serde::Deserialize)]
                struct Args {
                    path: String,
                    #[serde(default)]
                    include_counts: bool,
                    offset: Option<usize>,
                    limit: Option<usize>,
                }

                let args: Args = parse_args(request.arguments)?;
                let offset = args.offset.unwrap_or(0);
                let limit = args.limit.unwrap_or(100);
                if limit > 200 {
                    return Err(McpError::invalid_params(
                        "limit_exceeded",
                        Some(json!({ "limit": limit, "maxLimit": 200 })),
                    ));
                }

                let uri = normalize_pathql_uri(&args.path);
                let runtime_uri = normalize_mcp_uri_path(&uri);
                if !is_uri_capability_enabled(&runtime_uri, &disabled) {
                    return Err(disabled_resource_error(&uri));
                }

                let rt = provider_runtime().clone();
                let payload = tokio::task::spawn_blocking(move || {
                    rt.resolve(&runtime_uri)?;
                    let total = rt.count(&runtime_uri).ok();
                    let note = rt.note(&runtime_uri).ok().flatten();
                    let children = rt.list(&runtime_uri)?;
                    let child_count = children.len();
                    let window: Vec<_> = children.into_iter().skip(offset).take(limit).collect();
                    let counts_included = args.include_counts && window.len() <= 50;
                    let window_len = window.len();
                    let has_more = offset.saturating_add(window_len) < child_count;
                    let children: Vec<Value> = window
                        .into_iter()
                        .map(|child| {
                            let path = child_runtime_path(&uri, &child.name);
                            let child_engine_path = normalize_mcp_uri_path(&path);
                            let child_note = rt.note(&child_engine_path).ok().flatten();
                            let child_total = if counts_included {
                                rt.count(&child_engine_path).ok()
                            } else {
                                None
                            };
                            json!({
                                "name": child.name,
                                "path": path,
                                "note": child_note,
                                "meta": child.meta,
                                "total": child_total
                            })
                        })
                        .collect();
                    let mut payload = json!({
                        "path": uri,
                        "total": total,
                        "note": note,
                        "children": children,
                        "childCount": child_count,
                        "offset": offset,
                        "limit": limit,
                        "hasMore": has_more,
                        "countsIncluded": counts_included
                    });
                    // hint 分两种:节点真的没有子项 vs 只是本页窗口空(offset 越界 / limit=0)。
                    // 后者若也报"这是叶子",会把翻页翻过头的调用方误导成"此路不通"。
                    if child_count == 0 {
                        payload["hint"] = json!(
                            "This is either a collection leaf (append /x100x/1 and use \
                             resources/read) or its next children are syntax keywords rather \
                             than enumerable data; see server instructions."
                        );
                    } else if window_len == 0 {
                        payload["hint"] = json!(format!(
                            "Empty window: this node has {child_count} children but offset \
                             {offset} skips past all of them. Retry with a smaller offset."
                        ));
                    }
                    Ok::<_, EngineError>(payload)
                })
                .await
                .map_err(|e| McpError::internal_error(e.to_string(), None))?
                .map_err(pathql_error)?;

                Ok(CallToolResult::structured(payload).into())
            }
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

                Ok(CallToolResult::success(vec![ContentBlock::text(format!(
                    "Updated order for {count} images in album '{}'. \
                     To see the new arrangement, open this album in Kabegame \
                     and switch the sort mode to '加入顺序' (album-order / join order).",
                    args.album_id
                ))])
                .into())
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
                Ok(CallToolResult::success(vec![ContentBlock::text(
                    serde_json::to_string(&album).unwrap_or_default(),
                )])
                .into())
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

                Ok(CallToolResult::success(vec![ContentBlock::text(format!(
                    "Added {}/{} images to album '{}'.",
                    result.added, result.attempted, args.album_id
                ))])
                .into())
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
                Ok(CallToolResult::success(vec![ContentBlock::text(format!(
                    "Renamed image '{}' to '{}'.",
                    args.image_id, args.display_name
                ))])
                .into())
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
    use kabegame_core::providers::child_runtime_path;

    use super::{normalize_mcp_uri_path, resource_scheme, resource_segments};

    #[test]
    fn resource_scheme_parses_scheme_prefix() {
        assert_eq!(resource_scheme("images://id_1").unwrap(), "images");
        assert!(resource_scheme("id_1").is_err());
    }

    #[test]
    fn resource_segments_split_after_scheme() {
        assert_eq!(
            resource_segments("plugin://pixiv/asset/readme.png"),
            vec!["pixiv", "asset", "readme.png"]
        );
        assert!(resource_segments("plugin://").is_empty());
    }

    #[test]
    fn resource_segments_only_split_unescaped_slashes() {
        assert_eq!(
            resource_segments(r"plugin://a\/b/asset/readme.png"),
            vec![r"a\/b", "asset", "readme.png"]
        );
        assert_eq!(
            resource_segments(&normalize_mcp_uri_path("plugin://a%2Fb")),
            vec!["a", "b"]
        );
    }

    #[test]
    fn normalize_mcp_uri_path_decodes_chinese_transport_segment() {
        assert_eq!(
            normalize_mcp_uri_path("images://gallery/search/display-name/%E8%90%A4"),
            "images://gallery/search/display-name/萤"
        );
    }

    #[test]
    fn normalize_mcp_uri_path_preserves_bare_where_marker() {
        assert_eq!(
            normalize_mcp_uri_path("images://gallery/~any/plugin/pixiv"),
            "images://gallery/~any/plugin/pixiv"
        );
    }

    #[test]
    fn normalize_mcp_uri_path_decodes_only_the_uri_layer() {
        assert_eq!(
            normalize_mcp_uri_path("images://gallery/search/display-name/%5C%2F"),
            r"images://gallery/search/display-name/\/"
        );
    }

    #[test]
    fn normalize_mcp_uri_path_handles_mixed_segments() {
        assert_eq!(
            normalize_mcp_uri_path("images://gallery/%E4%B8%AD%E6%96%87/~any/%5C~literal"),
            r"images://gallery/中文/~any/\~literal"
        );
    }

    #[test]
    fn child_runtime_path_round_trips_reserved_and_slash_names() {
        let reserved = child_runtime_path("images://gallery/plugin", "~any");
        assert_eq!(reserved, "images://gallery/plugin/%5C~any");
        assert_eq!(
            normalize_mcp_uri_path(&reserved),
            r"images://gallery/plugin/\~any"
        );

        let with_slash = child_runtime_path("images://gallery/plugin", "a/b");
        assert_eq!(with_slash, "images://gallery/plugin/a%5C%2Fb");
        assert_eq!(
            normalize_mcp_uri_path(&with_slash),
            r"images://gallery/plugin/a\/b"
        );
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
