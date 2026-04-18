use kabegame_core::{
    emitter::GlobalEmitter,
    plugin::{Plugin, PluginManager},
    providers::{
        execute_provider_query, parse_provider_path, ProviderPathQuery, ProviderRuntime,
    },
    storage::Storage,
};
use url::Url;
use rmcp::{
    ErrorData as McpError, RoleServer, ServerHandler,
    model::{
        AnnotateAble, CallToolRequestParams, CallToolResult, Content, ErrorCode, Implementation,
        ListResourcesResult, ListResourceTemplatesResult, ListToolsResult, object,
        PaginatedRequestParams, RawResource, RawResourceTemplate, ReadResourceRequestParams,
        ReadResourceResult, ResourceContents, ServerCapabilities, ServerInfo, Tool,
    },
    service::RequestContext,
};
use serde_json::{json, Value};

pub const MCP_PORT: u16 = 7490;

const PROVIDER_URI_PREFIX: &str = "provider://";
const IMAGE_URI_PREFIX: &str = "image://";
const ALBUM_URI_PREFIX: &str = "album://";
const TASK_URI_PREFIX: &str = "task://";
const SURF_URI_PREFIX: &str = "surf://";
const PLUGIN_URI_PREFIX: &str = "plugin://";

const MCP_INSTRUCTIONS: &str = r#"Kabegame MCP exposes six URI schemes plus write tools.

1) provider:// — path-tree gallery browsing
   provider://<path>           Entry       : { name, meta, note }           (single node; never images)
   provider://<path>/          List        : { entries, total, meta, note } (Dir entries + Image entries)
   provider://<path>/*         ListWithMeta: same as List, but every Dir entry also carries its entity meta

   Query parameter (only on List / ListWithMeta; at most ONE without=):
     ?without=children   omit Dir entries — pure image slice
     ?without=images     omit Image entries — structure-only listing
     NOTE: specifying both is rejected (invalid_params). To skip both, use Entry mode.

   entries[N] shape:
     { "kind": "dir",   "name": "...", "meta": <ProviderMeta|null> }
     { "kind": "image", "image": <ImageInfo> }

   total      — total image count for the current query scope (null when not applicable).
   meta / note — present when the node itself represents a stored entity.

   Pagination: page size follows user setting (default 100). Page N starts at (N-1)*pageSize.
   IMPORTANT: page 0 is invalid — always start from page 1.

   Examples:
     provider://album/              list all albums (Dir entries; name = album id)
     provider://album/*             same + Album meta on each Dir
     provider://album/{id}          Entry: meta + note for this album (no images)
     provider://album/{id}/         List:  sub-dirs + page-1 images
     provider://album/{id}/1/       page 1 images (ascending by crawled_at)
     provider://album/{id}/desc/1/  page 1 images (newest first)
     provider://all/                all images, page 1
     provider://all/desc/1/         all images, page 1, newest-first
     provider://all/?without=children  page 1 images only, no page dirs
     provider://date/2024-03/       images crawled in 2024-03, page 1
     provider://media-type/image/   images only, page 1
     provider://wallpaper-order/1/  wallpaper history, page 1

2) album://              list ALL Albums       — returns Vec<Album>
   album://{id}          single Album          — returns Album

3) task://               list ALL Tasks        — returns Vec<TaskInfo>
   task://{id}           single TaskInfo

4) surf://               list ALL SurfRecords  — returns Vec<SurfRecord>
   surf://{host}         single SurfRecord

5) image://{id}              full ImageInfo (including metadataId)
   image://{id}/metadata     crawl-time metadata (tags, author, URLs; can be 10s of KB)

6) plugin://                              list ALL Plugins (trimmed — see note below)
   plugin://{id}                          single Plugin (trimmed)
   plugin://{id}/icon                     base64 icon PNG                (image/png, blob)
   plugin://{id}/description_template     EJS description template       (text/plain)
   plugin://{id}/doc                      doc.md (default locale)        (text/markdown)
   plugin://{id}/doc_resource/{key}       one doc_root resource file     (mime by extension, blob)

   "Trimmed" = the Plugin JSON returned by plugin:// and plugin://{id} has `docResources`,
   `iconPngBase64`, and `descriptionTemplate` stripped out. Fetch each heavy resource on
   demand via the sub-paths above.

provider:// meta shapes (ProviderMeta tagged by kind/data):
   kind: "album"   data: Album      { id, name, createdAt, parentId }
   kind: "task"    data: TaskInfo   { id, pluginId, status, progress, counts, … }
   kind: "surf"    data: SurfRecord { id, host, name, rootUrl, imageCount, lastVisitAt, … }
   kind: "plugin"  data: Plugin     — may include docResources up to ~10 MB total.
       DO NOT request `provider://plugin/*` (batch plugin meta) — use `plugin://` instead,
       which returns trimmed plugin JSON; fetch heavy resources via the `plugin://{id}/{icon|
       description_template|doc|doc_resource/{key}}` sub-paths only when needed.

Image fields (entries[N].image — ImageInfo, camelCase via serde rename_all):
   id, url, localPath, pluginId, taskId, surfRecordId, crawledAt (unix sec),
   metadata (crawl-time JSON; may be populated inline OR null with metadataId set — historically
   large metadata is moved to the image_metadata table and exposed via metadataId),
   metadataId, thumbnailPath, favorite, localExists, hash, width, height, displayName,
   type ("image" | "video" — NOTE: serde key is `type`, not `mediaType`),
   lastSetWallpaperAt, size (bytes).
   When metadata is null but metadataId is set, use image://{id}/metadata.

Plugin package layout (for model-authored plugins): manifest.json, crawl.rhai, config.json,
doc_root/doc.md, optional icon.png.

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

/// Trim large Plugin fields (docResources / iconPngBase64 / descriptionTemplate) before returning
/// over MCP. Heavy resources are accessible via dedicated sub-paths on demand.
fn serialize_plugin_lite(plugin: &Plugin) -> Value {
    let mut v = serde_json::to_value(plugin).unwrap_or(Value::Null);
    if let Value::Object(ref mut map) = v {
        map.remove("docResources");
        map.remove("iconPngBase64");
        map.remove("descriptionTemplate");
    }
    v
}

/// Single allowed `without=` query value for provider:// list modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum McpWithout {
    None,
    Children,
    Images,
}

/// Parse provider:// query string. Accepts at most one `without=children|images`.
fn parse_mcp_without(query: Option<&str>) -> Result<McpWithout, McpError> {
    let Some(q) = query.filter(|s| !s.is_empty()) else {
        return Ok(McpWithout::None);
    };
    let mut seen: Option<McpWithout> = None;
    for pair in q.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if k != "without" {
            // unknown keys are ignored for forward-compat
            continue;
        }
        let parsed = match v {
            "children" => McpWithout::Children,
            "images" => McpWithout::Images,
            other => {
                return Err(McpError::invalid_params(
                    format!("unknown without value: {other}"),
                    Some(json!({ "allowed": ["children", "images"] })),
                ));
            }
        };
        if seen.is_some() {
            return Err(McpError::invalid_params(
                "without can only appear once; use Entry mode (provider://<path>) to skip both",
                None,
            ));
        }
        seen = Some(parsed);
    }
    Ok(seen.unwrap_or(McpWithout::None))
}

fn mime_for_key(key: &str) -> &'static str {
    let ext = std::path::Path::new(key)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase());
    match ext.as_deref() {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("gif") => "image/gif",
        _ => "application/octet-stream",
    }
}

fn parse_args<T: serde::de::DeserializeOwned>(
    arguments: Option<serde_json::Map<String, serde_json::Value>>,
) -> Result<T, McpError> {
    serde_json::from_value(serde_json::Value::Object(arguments.unwrap_or_default())).map_err(|e| {
        McpError::invalid_params(e.to_string(), None)
    })
}

fn json_resource(json: String, uri: impl Into<String>) -> Result<ReadResourceResult, McpError> {
    Ok(ReadResourceResult::new(vec![
        ResourceContents::text(json, uri).with_mime_type("application/json"),
    ]))
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
        let resources = vec![
            RawResource::new("provider://all/", "All images")
                .with_description("All images in the gallery, ordered by crawl time (ascending)")
                .with_mime_type("application/json")
                .no_annotation(),
            RawResource::new("provider://all/desc/", "All images (newest first)")
                .with_description("All images in the gallery, ordered by crawl time (descending)")
                .with_mime_type("application/json")
                .no_annotation(),
            RawResource::new("provider://wallpaper-order/", "Wallpaper history")
                .with_description("Images that have been set as wallpaper, ordered by set-time")
                .with_mime_type("application/json")
                .no_annotation(),
            RawResource::new("album://", "All albums")
                .with_description("Full list of albums (Vec<Album>)")
                .with_mime_type("application/json")
                .no_annotation(),
            RawResource::new("task://", "All tasks")
                .with_description("Full list of tasks (Vec<TaskInfo>)")
                .with_mime_type("application/json")
                .no_annotation(),
            RawResource::new("surf://", "All surf records")
                .with_description("Full list of surf records (Vec<SurfRecord>)")
                .with_mime_type("application/json")
                .no_annotation(),
            RawResource::new("plugin://", "All plugins (trimmed)")
                .with_description(
                    "Full list of installed plugins with heavy fields (docResources, \
                     iconPngBase64, descriptionTemplate) stripped",
                )
                .with_mime_type("application/json")
                .no_annotation(),
        ];

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
        let parsed = Url::parse(&request.uri).map_err(|_| {
            McpError::resource_not_found("invalid_uri", Some(json!({ "uri": request.uri })))
        })?;
        let id = parsed.host_str().unwrap_or("");
        let sub = parsed.path(); // "" | "/" | "/metadata" | "/doc" | "/doc_resource/..." etc.

        match parsed.scheme() {
            // image://{id}  /  image://{id}/metadata
            "image" => {
                if id.is_empty() {
                    return Err(McpError::resource_not_found(
                        "empty_image_id",
                        Some(json!({ "uri": request.uri })),
                    ));
                }
                if sub == "/metadata" {
                    let meta = Storage::global()
                        .get_image_metadata(id)
                        .map_err(|e| {
                            McpError::internal_error(format!("metadata error: {e}"), None)
                        })?
                        .ok_or_else(|| {
                            McpError::resource_not_found(
                                "no_metadata",
                                Some(json!({ "imageId": id })),
                            )
                        })?;
                    let json = serde_json::to_string(&meta)
                        .map_err(|e| McpError::internal_error(e.to_string(), None))?;
                    return json_resource(json, request.uri);
                }
                let image = Storage::global()
                    .find_image_by_id(id)
                    .map_err(|e| McpError::internal_error(e, None))?
                    .ok_or_else(|| {
                        McpError::resource_not_found("image_not_found", Some(json!({ "imageId": id })))
                    })?;
                let json = serde_json::to_string(&image)
                    .map_err(|e| McpError::internal_error(e.to_string(), None))?;
                json_resource(json, request.uri)
            }

            // album://  (list all)  /  album://{id}
            "album" => {
                if id.is_empty() {
                    let albums = Storage::global()
                        .list_all_albums()
                        .map_err(|e| McpError::internal_error(e, None))?;
                    let json = serde_json::to_string(&albums)
                        .map_err(|e| McpError::internal_error(e.to_string(), None))?;
                    return json_resource(json, request.uri);
                }
                let album = Storage::global()
                    .list_all_albums()
                    .map_err(|e| McpError::internal_error(e, None))?
                    .into_iter()
                    .find(|a| a.id == id)
                    .ok_or_else(|| {
                        McpError::resource_not_found(
                            "album_not_found",
                            Some(json!({ "albumId": id })),
                        )
                    })?;
                let json = serde_json::to_string(&album)
                    .map_err(|e| McpError::internal_error(e.to_string(), None))?;
                json_resource(json, request.uri)
            }

            // task://  (list all)  /  task://{id}
            "task" => {
                if id.is_empty() {
                    let tasks = Storage::global()
                        .get_all_tasks()
                        .map_err(|e| McpError::internal_error(e, None))?;
                    let json = serde_json::to_string(&tasks)
                        .map_err(|e| McpError::internal_error(e.to_string(), None))?;
                    return json_resource(json, request.uri);
                }
                let task = Storage::global()
                    .get_task(id)
                    .map_err(|e| McpError::internal_error(e, None))?
                    .ok_or_else(|| {
                        McpError::resource_not_found("task_not_found", Some(json!({ "taskId": id })))
                    })?;
                let json = serde_json::to_string(&task)
                    .map_err(|e| McpError::internal_error(e.to_string(), None))?;
                json_resource(json, request.uri)
            }

            // surf://  (list all)  /  surf://{host}
            "surf" => {
                if id.is_empty() {
                    let records = Storage::global()
                        .list_all_surf_records()
                        .map_err(|e| McpError::internal_error(e, None))?;
                    let json = serde_json::to_string(&records)
                        .map_err(|e| McpError::internal_error(e.to_string(), None))?;
                    return json_resource(json, request.uri);
                }
                let record = Storage::global()
                    .get_surf_record_by_host(id)
                    .map_err(|e| McpError::internal_error(e, None))?
                    .ok_or_else(|| {
                        McpError::resource_not_found("surf_not_found", Some(json!({ "host": id })))
                    })?;
                let json = serde_json::to_string(&record)
                    .map_err(|e| McpError::internal_error(e.to_string(), None))?;
                json_resource(json, request.uri)
            }

            // plugin://                            list all (trimmed)
            // plugin://{id}                        single (trimmed)
            // plugin://{id}/icon                   base64 PNG blob
            // plugin://{id}/description_template   EJS text/plain
            // plugin://{id}/doc                    doc.md text/markdown
            // plugin://{id}/doc_resource/{key}     blob by extension mime
            "plugin" => {
                if id.is_empty() {
                    let plugins = PluginManager::global()
                        .get_all()
                        .await
                        .map_err(|e| McpError::internal_error(e, None))?;
                    let arr: Vec<Value> = plugins.iter().map(serialize_plugin_lite).collect();
                    let json = serde_json::to_string(&arr)
                        .map_err(|e| McpError::internal_error(e.to_string(), None))?;
                    return json_resource(json, request.uri);
                }

                if let Some(key) = sub.strip_prefix("/doc_resource/") {
                    if key.is_empty() {
                        return Err(McpError::resource_not_found(
                            "invalid_doc_resource",
                            Some(json!({ "uri": request.uri })),
                        ));
                    }
                    let resources = PluginManager::global()
                        .get(id)
                        .await
                        .and_then(|p| p.doc_resources)
                        .ok_or_else(|| {
                            McpError::resource_not_found(
                                "no_doc_resources",
                                Some(json!({ "pluginId": id })),
                            )
                        })?;
                    let data = resources.get(key).ok_or_else(|| {
                        McpError::resource_not_found(
                            "doc_resource_not_found",
                            Some(json!({ "pluginId": id, "key": key })),
                        )
                    })?;
                    let mime = mime_for_key(key);
                    return Ok(ReadResourceResult::new(vec![
                        ResourceContents::blob(data.clone(), request.uri).with_mime_type(mime),
                    ]));
                }

                match sub {
                    "/description_template" => {
                        let tpl = PluginManager::global()
                            .get(id)
                            .await
                            .and_then(|p| p.description_template)
                            .ok_or_else(|| {
                                McpError::resource_not_found(
                                    "no_description_template",
                                    Some(json!({ "pluginId": id })),
                                )
                            })?;
                        Ok(ReadResourceResult::new(vec![
                            ResourceContents::text(tpl, request.uri).with_mime_type("text/plain"),
                        ]))
                    }
                    "/icon" => {
                        let icon = PluginManager::global()
                            .get(id)
                            .await
                            .and_then(|p| p.icon_png_base64)
                            .ok_or_else(|| {
                                McpError::resource_not_found(
                                    "no_icon",
                                    Some(json!({ "pluginId": id })),
                                )
                            })?;
                        Ok(ReadResourceResult::new(vec![
                            ResourceContents::blob(icon, request.uri).with_mime_type("image/png"),
                        ]))
                    }
                    "/doc" => {
                        let doc = PluginManager::global()
                            .get(id)
                            .await
                            .and_then(|p| p.doc)
                            .ok_or_else(|| {
                                McpError::resource_not_found(
                                    "no_plugin_doc",
                                    Some(json!({ "pluginId": id })),
                                )
                            })?;
                        let content = doc.get("default").ok_or_else(|| {
                            McpError::resource_not_found(
                                "no_default_doc",
                                Some(json!({ "pluginId": id })),
                            )
                        })?;
                        Ok(ReadResourceResult::new(vec![ResourceContents::text(
                            content.clone(),
                            request.uri,
                        )
                        .with_mime_type("text/markdown")]))
                    }
                    "" | "/" => {
                        let plugin = PluginManager::global()
                            .get(id)
                            .await
                            .ok_or_else(|| {
                                McpError::resource_not_found(
                                    "plugin_not_found",
                                    Some(json!({ "pluginId": id })),
                                )
                            })?;
                        let json = serde_json::to_string(&serialize_plugin_lite(&plugin))
                            .map_err(|e| McpError::internal_error(e.to_string(), None))?;
                        json_resource(json, request.uri)
                    }
                    _ => Err(McpError::resource_not_found(
                        "invalid_plugin_path",
                        Some(json!({ "uri": request.uri })),
                    )),
                }
            }

            // provider://<path>[?without=children|images]
            // URL components: host = first path segment, path = rest
            "provider" => {
                let path_part = format!("{}{}", id, sub);
                if path_part.is_empty() || path_part == "/" {
                    return Err(McpError::resource_not_found(
                        "empty_path",
                        Some(json!({ "uri": request.uri })),
                    ));
                }

                let without = parse_mcp_without(parsed.query())?;
                let (path, mode) = parse_provider_path(&path_part);
                let full = format!("gallery/{}", path.trim().trim_start_matches('/'));

                let result_json: Value = match mode {
                    ProviderPathQuery::Entry => execute_provider_query(&full).map_err(|e| {
                        McpError::internal_error(
                            format!("provider error: {e}"),
                            Some(json!({ "path": path_part })),
                        )
                    })?,
                    ProviderPathQuery::List | ProviderPathQuery::ListWithMeta => {
                        let rt = ProviderRuntime::global();
                        let node = rt
                            .resolve(&full)
                            .map_err(|e| {
                                McpError::internal_error(
                                    format!("resolve error: {e}"),
                                    Some(json!({ "path": path_part })),
                                )
                            })?
                            .ok_or_else(|| {
                                McpError::resource_not_found(
                                    "path_not_found",
                                    Some(json!({ "path": path_part })),
                                )
                            })?;

                        let children = if without == McpWithout::Children {
                            Vec::new()
                        } else if mode == ProviderPathQuery::ListWithMeta {
                            node.provider
                                .list_children_with_meta(&node.composed)
                                .map_err(|e| McpError::internal_error(e, None))?
                        } else {
                            node.provider
                                .list_children(&node.composed)
                                .map_err(|e| McpError::internal_error(e, None))?
                        };

                        let images = if without == McpWithout::Images {
                            Vec::new()
                        } else {
                            let composed_images = if node.composed.order_bys.is_empty() {
                                node.composed.clone().with_order("images.id ASC")
                            } else {
                                node.composed.clone()
                            };
                            node.provider
                                .list_images(&composed_images)
                                .map_err(|e| McpError::internal_error(e, None))?
                        };

                        let storage = Storage::global();
                        let entries =
                            kabegame_core::gallery::browse_from_provider(storage, children, images)
                                .map_err(|e| McpError::internal_error(e, None))?;
                        let entries_json = serde_json::to_value(&entries)
                            .map_err(|e| McpError::internal_error(e.to_string(), None))?;

                        let meta = node.provider.get_meta();
                        let note = node.provider.get_note().map(|(title, content)| {
                            json!({ "title": title, "content": content })
                        });
                        let total: Option<usize> =
                            storage.get_images_count_by_query(&node.composed).ok();

                        json!({
                            "entries": entries_json,
                            "total": total,
                            "meta": meta,
                            "note": note,
                        })
                    }
                };

                let json_str = serde_json::to_string(&result_json).map_err(|e| {
                    McpError::internal_error(format!("serialization error: {e}"), None)
                })?;
                json_resource(json_str, request.uri)
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
        Ok(ListResourceTemplatesResult {
            next_cursor: None,
            resource_templates: vec![
                RawResourceTemplate::new("provider://{+path}", "Gallery provider path")
                    .with_description(
                        "Any gallery provider path. Append '/' for List, '/*' for ListWithMeta; \
                         add ?without=children or ?without=images (at most one) to trim output.",
                    )
                    .with_mime_type("application/json")
                    .no_annotation(),
                RawResourceTemplate::new("album://{albumId}", "Album info")
                    .with_description("Full album object: id, name, parentId, createdAt.")
                    .with_mime_type("application/json")
                    .no_annotation(),
                RawResourceTemplate::new("task://{taskId}", "Task info")
                    .with_description(
                        "Full task object: id, pluginId, status, progress, counts, etc.",
                    )
                    .with_mime_type("application/json")
                    .no_annotation(),
                RawResourceTemplate::new("surf://{host}", "Surf record info")
                    .with_description(
                        "Full surf record: id, host, name, imageCount, lastVisitAt, etc.",
                    )
                    .with_mime_type("application/json")
                    .no_annotation(),
                RawResourceTemplate::new("image://{imageId}", "Image info")
                    .with_description("Full ImageInfo for a single image including metadataId.")
                    .with_mime_type("application/json")
                    .no_annotation(),
                RawResourceTemplate::new("image://{imageId}/metadata", "Image metadata")
                    .with_description(
                        "Crawl-time metadata — can be 10s of KB (tags, author, URLs, etc.).",
                    )
                    .with_mime_type("application/json")
                    .no_annotation(),
                RawResourceTemplate::new("plugin://{pluginId}", "Plugin info (trimmed)")
                    .with_description(
                        "Plugin metadata without docResources/iconPngBase64/descriptionTemplate. \
                         Fetch those via sub-path resources on demand.",
                    )
                    .with_mime_type("application/json")
                    .no_annotation(),
                RawResourceTemplate::new("plugin://{pluginId}/doc", "Plugin documentation")
                    .with_description("Plugin doc.md content in Markdown (default locale).")
                    .with_mime_type("text/markdown")
                    .no_annotation(),
                RawResourceTemplate::new("plugin://{pluginId}/icon", "Plugin icon")
                    .with_description("Plugin icon as base64-encoded PNG.")
                    .with_mime_type("image/png")
                    .no_annotation(),
                RawResourceTemplate::new(
                    "plugin://{pluginId}/description_template",
                    "Plugin description template",
                )
                .with_description("EJS template used to render plugin descriptions.")
                .with_mime_type("text/plain")
                .no_annotation(),
                RawResourceTemplate::new(
                    "plugin://{pluginId}/doc_resource/{resourceKey}",
                    "Plugin doc resource",
                )
                .with_description(
                    "A single doc_resource (e.g. images referenced by doc.md); mime inferred by extension.",
                )
                .no_annotation(),
            ],
            meta: None,
        })
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult {
            tools: vec![
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
            ],
            next_cursor: None,
            meta: None,
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
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

                let result = Storage::global()
                    .add_images_to_album(&args.album_id, &args.image_ids)
                    .map_err(|e| McpError::internal_error(e, None))?;

                if let Some(orders) = &args.image_orders {
                    let pairs: Vec<(String, i64)> =
                        orders.iter().map(|o| (o.image_id.clone(), o.order)).collect();
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
                GlobalEmitter::global().emit_images_change(
                    "rename",
                    &[args.image_id.clone()],
                    None,
                    None,
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

pub async fn start_mcp_server() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use rmcp::transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService,
        session::local::LocalSessionManager,
    };

    let service = StreamableHttpService::new(
        || Ok(KabegameMcpServer),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default(),
    );

    let router = axum::Router::new().nest_service("/mcp", service);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", MCP_PORT)).await?;
    println!("  ✓ MCP server listening on 127.0.0.1:{MCP_PORT}");
    axum::serve(listener, router).await?;
    Ok(())
}
