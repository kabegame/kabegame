//! 插件文件的统一按需读取出口；命令、HTTP 与 MCP 共用白名单和 ZIP 读取逻辑。
use super::{assets::normalize_asset_path, Plugin, PluginManager, PluginScript, VarDefinition};
use crate::plugin::var_canonical::canonical_user_config_for_compare;
use crate::storage::RunConfig;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{io::Read, path::Path, sync::Arc};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PluginFileOrigin {
    Installed,
    Store {
        #[serde(rename = "sourceId")]
        source_id: String,
    },
    Preview {
        token: String,
    },
}

impl PluginFileOrigin {
    pub fn from_query(source: Option<String>, preview: Option<String>) -> Option<Self> {
        match (source, preview) {
            (None, None) => Some(Self::Installed),
            (Some(source_id), None) => Some(Self::Store { source_id }),
            (None, Some(token)) => Some(Self::Preview { token }),
            _ => None,
        }
    }
}

pub struct PluginFileBody {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub etag: String,
}

#[derive(Debug)]
pub enum PluginFileError {
    NotFound,
    Read(String),
}

impl std::fmt::Display for PluginFileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => write!(f, "插件文件不存在"),
            Self::Read(error) => f.write_str(error),
        }
    }
}

impl std::error::Error for PluginFileError {}

/// 按来源、版本及清单白名单读取插件条目；ETag 命中时不打开 ZIP。
pub fn read_plugin_file(
    id: &str,
    origin: &PluginFileOrigin,
    version: &str,
    path: &str,
    if_none_match: Option<&str>,
) -> Result<Option<PluginFileBody>, PluginFileError> {
    let plugin = PluginManager::global_opt()
        .and_then(|manager| manager.resolve_plugin_file(id, origin, version))
        .ok_or(PluginFileError::NotFound)?;
    let entry = allowed_entry(&plugin, path).ok_or(PluginFileError::NotFound)?;
    let etag = etag_for(&plugin).map_err(PluginFileError::Read)?;
    if if_none_match.is_some_and(|header| {
        header.split(',').any(|value| {
            let value = value.trim().trim_start_matches("W/");
            value == etag || value == "*"
        })
    }) {
        return Ok(None);
    }
    let file = plugin.file_path.as_ref().ok_or(PluginFileError::NotFound)?;
    let bytes = read_kgpg_entry(Path::new(file), &entry)
        .map_err(PluginFileError::Read)?
        .ok_or(PluginFileError::NotFound)?;
    Ok(Some(PluginFileBody {
        bytes,
        mime: mime_for_plugin_file(&entry),
        etag,
    }))
}

impl PluginManager {
    /// 导入态比较只读已安装记录和有本地包的商店缓存，不涉及预览或下载。
    pub(crate) fn recommended_diff_plugins(&self, id: &str) -> Vec<(bool, Arc<Plugin>)> {
        let mut plugins = Vec::new();
        if let Some(plugin) = self.get(id) {
            plugins.push((true, plugin));
        }
        let cache = self.store_plugin_cache.load();
        let mut sources: Vec<_> = cache.keys().collect();
        sources.sort();
        for source in sources {
            if let Some(plugin) = cache[source].get(id).filter(|plugin| {
                plugin
                    .file_path
                    .as_deref()
                    .is_some_and(|path| Path::new(path).is_file())
            }) {
                plugins.push((false, Arc::new(plugin.clone())));
            }
        }
        plugins
    }

    pub fn resolve_plugin_file(
        &self,
        id: &str,
        origin: &PluginFileOrigin,
        version: &str,
    ) -> Option<Arc<Plugin>> {
        let plugin = match origin {
            PluginFileOrigin::Installed => self.get(id)?,
            PluginFileOrigin::Store { source_id } => Arc::new(
                self.store_plugin_cache
                    .load()
                    .get(source_id)?
                    .get(id)?
                    .clone(),
            ),
            PluginFileOrigin::Preview { token } => {
                let mut cache = self.preview_plugins.lock().ok()?;
                let index = cache.iter().position(|(key, plugin)| {
                    key == token && plugin.id == id && plugin.version == version
                })?;
                let entry = cache.remove(index)?;
                let plugin = entry.1.clone();
                cache.push_back(entry);
                plugin
            }
        };
        (plugin.id == id && plugin.version == version).then_some(plugin)
    }

    /// 只枚举本地缓存的来源，不触发商店下载，也不公开预览凭据。
    pub(crate) fn plugin_file_store_sources(&self) -> Vec<String> {
        let mut sources: Vec<_> = self.store_plugin_cache.load().keys().cloned().collect();
        sources.sort();
        sources
    }

    pub(crate) fn plugin_file_ids(&self, origin: &PluginFileOrigin) -> Result<Vec<String>, String> {
        let mut ids: Vec<_> = match origin {
            PluginFileOrigin::Installed => self.get_all()?.iter().map(|p| p.id.clone()).collect(),
            PluginFileOrigin::Store { source_id } => self
                .store_plugin_cache
                .load()
                .get(source_id)
                .map(|plugins| plugins.keys().cloned().collect())
                .unwrap_or_default(),
            PluginFileOrigin::Preview { .. } => Vec::new(),
        };
        ids.sort();
        Ok(ids)
    }

    /// id 层尚未携带版本；只读来源元数据，资源读取仍须经 resolve_plugin_file 校验。
    pub(crate) fn plugin_file_version(
        &self,
        id: &str,
        origin: &PluginFileOrigin,
    ) -> Option<String> {
        match origin {
            PluginFileOrigin::Installed => Some(self.get(id)?.version.clone()),
            PluginFileOrigin::Store { source_id } => Some(
                self.store_plugin_cache
                    .load()
                    .get(source_id)?
                    .get(id)?
                    .version
                    .clone(),
            ),
            PluginFileOrigin::Preview { token } => self
                .preview_plugins
                .lock()
                .ok()?
                .iter()
                .find(|(key, plugin)| key == token && plugin.id == id)
                .map(|(_, plugin)| plugin.version.clone()),
        }
    }

    pub async fn load_script(&self, plugin: &Plugin) -> Result<PluginScript, String> {
        if plugin.script.is_builtin() {
            return Ok(plugin.script.clone());
        }
        let plugin = plugin.clone();
        tokio::task::spawn_blocking(move || {
            let source = read_manifest_text(&plugin, "main", None)?.ok_or("插件主脚本不存在")?;
            if source.trim().is_empty() {
                return Err("插件主脚本为空".into());
            }
            Ok(PluginScript {
                backend: plugin.script.backend,
                source: Some(source.into()),
            })
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub fn load_metadata_migration(&self, plugin: &Plugin) -> Result<Option<String>, String> {
        let Some(path) = &plugin.metadata_migration_path else {
            return Ok(None);
        };
        read_plugin_text(plugin, path)
    }
}

/// 返回真实 ZIP 条目名；资源只信任通过体积校验后的 asset_keys。
pub fn allowed_entry(plugin: &Plugin, requested: &str) -> Option<String> {
    let key = normalize_asset_path(requested)?;
    let pkg = plugin.package_json.as_ref()?;
    let mut entries = vec!["package.json"];
    for field in ["kbIcon", "kbDescriptionTemplate"] {
        if let Some(path) = pkg.get(field).and_then(Value::as_str) {
            entries.push(path);
        }
    }
    for field in ["kbDoc", "kbChangelog"] {
        if let Some(map) = pkg.get(field).and_then(Value::as_object) {
            entries.extend(map.values().filter_map(Value::as_str));
        }
    }
    if let Some(items) = pkg.get("kbRecommendedConfigs").and_then(Value::as_array) {
        entries.extend(items.iter().filter_map(Value::as_str));
    }
    entries.extend(plugin.asset_keys.iter().map(String::as_str));
    entries
        .into_iter()
        .find(|entry| normalize_asset_path(entry).as_deref() == Some(key.as_str()))
        .map(str::to_string)
}

pub fn is_recommended_config(plugin: &Plugin, entry: &str) -> bool {
    plugin
        .package_json
        .as_ref()
        .and_then(|p| p.get("kbRecommendedConfigs"))
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().any(|v| v.as_str() == Some(entry)))
}

pub fn read_kgpg_entry(path: &Path, entry: &str) -> Result<Option<Vec<u8>>, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut file = match zip.by_name(entry) {
        Ok(file) => file,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(Some(bytes))
}

pub fn read_plugin_text(plugin: &Plugin, entry: &str) -> Result<Option<String>, String> {
    let Some(path) = &plugin.file_path else {
        return Ok(None);
    };
    read_kgpg_entry(Path::new(path), entry)?
        .map(|bytes| String::from_utf8(bytes).map_err(|e| e.to_string()))
        .transpose()
}

pub fn read_manifest_text(
    plugin: &Plugin,
    field: &str,
    locale: Option<&str>,
) -> Result<Option<String>, String> {
    let value = plugin.package_json.as_ref().and_then(|p| p.get(field));
    let path = match locale {
        Some(locale) => value.and_then(|v| v.get(locale)),
        None => value,
    }
    .and_then(Value::as_str);
    match path {
        Some(path) => read_plugin_text(plugin, path),
        None => Ok(None),
    }
}

pub fn mime_for_plugin_file(path: &str) -> String {
    let image = super::assets::mime_for_asset(path);
    if image != "application/octet-stream" {
        return image.to_string();
    }
    match Path::new(path)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "md" => "text/markdown; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        _ => "text/plain; charset=utf-8",
    }
    .to_string()
}

pub fn etag_for(plugin: &Plugin) -> Result<String, String> {
    let metadata = std::fs::metadata(plugin.file_path.as_ref().ok_or("插件无文件路径")?)
        .map_err(|e| e.to_string())?;
    let modified = metadata
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    Ok(format!(
        "\"{}-{}-{modified}\"",
        plugin.version,
        metadata.len()
    ))
}

/// 按清单顺序读取推荐文件；损坏或缺失的项跳过，两种导入态投影共用此出口。
fn read_recommended_configs(plugin: &Plugin) -> Vec<(String, Value)> {
    plugin
        .package_json
        .as_ref()
        .and_then(|pkg| pkg.get("kbRecommendedConfigs"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(|path| {
            let result = read_plugin_text(plugin, path)
                .and_then(|text| text.ok_or_else(|| "推荐文件不存在".to_string()))
                .and_then(|text| serde_json::from_str(&text).map_err(|error| error.to_string()));
            match result {
                Ok(content) => Some((path.to_string(), content)),
                Err(error) => {
                    eprintln!("[WARN] 读取推荐配置 {}/{path} 失败: {error}", plugin.id);
                    None
                }
            }
        })
        .collect()
}

fn recommended_is_imported(plugin: &Plugin, content: &Value, configs: &[RunConfig]) -> bool {
    configs.iter().any(|config| {
        preset_content_matches(
            &plugin.id,
            &plugin.base_url,
            &plugin.var_defs,
            content,
            config,
        )
    })
}

pub fn recommended_import_states(plugin: &Plugin, configs: &[RunConfig]) -> Vec<(String, bool)> {
    read_recommended_configs(plugin)
        .into_iter()
        .map(|(path, content)| (path, recommended_is_imported(plugin, &content, configs)))
        .collect()
}

pub fn recommended_rows(plugin: &Plugin, configs: &[RunConfig]) -> Vec<Value> {
    read_recommended_configs(plugin)
        .into_iter()
        .map(|(path, content)| {
            let imported = recommended_is_imported(plugin, &content, configs);
            let mut object = content.as_object().cloned().unwrap_or_default();
            object.insert("pluginId".into(), Value::String(plugin.id.clone()));
            object.insert(
                "filename".into(),
                Value::String(
                    Path::new(&path)
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("")
                        .to_string(),
                ),
            );
            object.insert("path".into(), Value::String(path));
            object.insert("isImported".into(), Value::Bool(imported));
            Value::Object(object)
        })
        .collect()
}
pub(crate) fn preset_content_matches(
    plugin_id: &str,
    plugin_base_url: &str,
    defs: &[VarDefinition],
    preset: &Value,
    config: &RunConfig,
) -> bool {
    let preset_url = preset
        .get("url")
        .or_else(|| preset.get("baseUrl"))
        .or_else(|| preset.get("base_url"))
        .and_then(Value::as_str)
        .unwrap_or(plugin_base_url)
        .trim();
    let preset_user_config = preset
        .get("userConfig")
        .or_else(|| preset.get("user_config"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let config_user_config =
        serde_json::to_value(config.user_config.as_ref().cloned().unwrap_or_default())
            .unwrap_or_else(|_| serde_json::json!({}));
    let preset_headers = preset
        .get("httpHeaders")
        .or_else(|| preset.get("http_headers"))
        .and_then(Value::as_object)
        .filter(|headers| !headers.is_empty());
    let config_headers = config
        .http_headers
        .as_ref()
        .filter(|headers| !headers.is_empty())
        .and_then(|headers| serde_json::to_value(headers).ok())
        .and_then(|value| value.as_object().cloned());
    let preset_dry_run = preset
        .get("isDryRun")
        .or_else(|| preset.get("is_dry_run"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    config.plugin_id == plugin_id
        && config.url.trim() == preset_url
        && canonical_user_config_for_compare(preset_user_config, defs)
            == canonical_user_config_for_compare(config_user_config, defs)
        && preset_headers.cloned() == config_headers
        && config.is_dry_run == preset_dry_run
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{collections::HashMap, io::Write};

    #[test]
    fn package_file_origin_from_query() {
        assert_eq!(
            PluginFileOrigin::from_query(None, None),
            Some(PluginFileOrigin::Installed)
        );
        assert_eq!(
            PluginFileOrigin::from_query(Some("store".into()), None),
            Some(PluginFileOrigin::Store {
                source_id: "store".into()
            })
        );
        assert_eq!(
            PluginFileOrigin::from_query(None, Some("token".into())),
            Some(PluginFileOrigin::Preview {
                token: "token".into()
            })
        );
        assert_eq!(
            PluginFileOrigin::from_query(Some("store".into()), Some("token".into())),
            None
        );
    }

    fn plugin() -> Plugin {
        let mut plugin = (**super::super::builtin::builtin_plugins()
            .values()
            .next()
            .unwrap())
        .clone();
        plugin.id = "test-file".into();
        plugin.version = "1.2.3".into();
        plugin.package_json = Some(json!({
            "name":"test-file", "version":"1.2.3", "kbPackageVersion":3,
            "kbBackend":"v8", "main":"main.js", "kbBaseUrl":"https://example.test",
            "kbIcon":"icon.png", "kbDoc":{"default":"docs/README.md","zh":"中文.md"},
            "kbChangelog":{"default":"CHANGELOG.md"}, "kbDescriptionTemplate":"description.ejs",
            "kbRecommendedConfigs":["configs/default.json"], "kbAssets":["images/a b.png","huge.png"],
            "kbMetadataMigration":"migration.js"
        }));
        plugin.asset_keys = vec!["images/a b.png".into()];
        plugin
    }

    fn kgpg(plugin: &Plugin, extra: &[(&str, &[u8])]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test-file.kgpg");
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let package = serde_json::to_vec(plugin.package_json.as_ref().unwrap()).unwrap();
        let entries: Vec<(&str, &[u8])> = vec![
            ("package.json", &package),
            ("main.js", b"export async function crawl() {}"),
            ("icon.png", b"icon"),
            ("docs/README.md", b"# Original\n![image](images/a%20b.png)"),
            ("中文.md", "# 中文".as_bytes()),
            ("CHANGELOG.md", b"# Changes"),
            ("description.ejs", b"<%= metadata.title %>"),
            ("configs/default.json", b"{}"),
            ("images/a b.png", b"image"),
            (
                "migration.js",
                b"export function migrate(input) { return input; }",
            ),
        ];
        for (name, bytes) in entries.into_iter().chain(extra.iter().copied()) {
            writer
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(bytes).unwrap();
        }
        let zip = writer.finish().unwrap().into_inner();
        let header = crate::kgpg::build_kgpg3_header(None).unwrap();
        crate::kgpg::write_kgpg3_from_zip_bytes(&path, &header, &zip).unwrap();
        (dir, path)
    }

    // 复用本模块的包体夹具，覆盖真实 PathQL runtime 的前缀缓存行为。
    #[test]
    fn plugin_resource_origins_subresources_and_live_coordinates() {
        use crate::providers::programmatic::plugin_resource::register_plugin_resource_provider;
        use pathql_rs::provider::{
            ClosureExecutor, ProviderContext, ProviderRuntime, ResolveRef, SqlDialect,
        };

        crate::app_paths::AppPaths::init_for_tests();
        let _ = crate::storage::Storage::init_global();
        PluginManager::init_global().unwrap();
        let manager = PluginManager::global();
        let mut installed = plugin();
        let (_dir, path) = kgpg(&installed, &[]);
        installed.file_path = Some(path.to_string_lossy().into_owned());
        installed.icon_png_base64 = Some("installed-icon".into());
        installed.providers = vec![super::super::PluginProviderDef {
            source_path: "providers/entry.yaml".into(),
            source: Some("installed DSL".into()),
            def: serde_json::from_value(json!({
                "name": "entry_provider", "namespace": "plugins.test-file"
            }))
            .unwrap(),
        }];
        let mut store = installed.clone();
        store.icon_png_base64 = Some("store-icon".into());
        store.providers[0].source = Some("cached store DSL".into());
        let mut preview = installed.clone();
        preview.icon_png_base64 = Some("preview-icon".into());
        manager.plugins.store(Arc::new(Some(HashMap::from([(
            installed.id.clone(),
            Arc::new(installed.clone()),
        )]))));
        manager.store_plugin_cache.store(Arc::new(HashMap::from([(
            "source".into(),
            HashMap::from([(store.id.clone(), store.clone())]),
        )])));
        manager
            .preview_plugins
            .lock()
            .unwrap()
            .push_back(("secret".into(), Arc::new(preview)));

        // ETag 命中不读取条目；白名单外路径始终拒绝。
        let etag = etag_for(&installed).unwrap();
        assert!(read_plugin_file(
            "test-file",
            &PluginFileOrigin::Installed,
            "1.2.3",
            "icon.png",
            Some(&etag),
        )
        .unwrap()
        .is_none());
        assert!(matches!(
            read_plugin_file(
                "test-file",
                &PluginFileOrigin::Installed,
                "1.2.3",
                "main.js",
                None,
            ),
            Err(PluginFileError::NotFound)
        ));

        let runtime = ProviderRuntime::new(
            Arc::new(ClosureExecutor::new(SqlDialect::Sqlite, |_, _| {
                panic!("插件资源不应执行 SQL")
            })),
            Default::default(),
        );
        register_plugin_resource_provider(&runtime).unwrap();
        runtime
            .register_programmatic_schema("plugin", "kabegame", "plugin_resource_root_provider")
            .unwrap();
        let names = |path: &str| -> Vec<String> {
            runtime
                .list(path)
                .unwrap()
                .into_iter()
                .map(|entry| entry.name)
                .collect()
        };
        assert_eq!(names("plugin://"), ["installed", "byStore"]);
        assert_eq!(
            runtime.fetch("plugin://").unwrap(),
            runtime.fetch("plugin://installed").unwrap()
        );
        assert_eq!(names("plugin://byStore"), ["source"]);
        assert_eq!(names("plugin://byStore/source"), ["test-file"]);
        assert!(names("plugin://byPreview").is_empty());
        assert!(names("plugin://byPreview/secret").is_empty());
        assert!(runtime.resolve("plugin://test-file").is_err());

        let ctx = ProviderContext::new(
            Arc::new(pathql_rs::ProviderRegistry::new()),
            runtime.clone(),
        );
        for (origin, icon) in [
            ("installed", "installed-icon"),
            ("byStore/source", "store-icon"),
            ("byPreview/secret", "preview-icon"),
        ] {
            let id_path = format!("plugin://{origin}/test-file");
            assert_eq!(names(&id_path), ["1.2.3"]);
            let node = runtime.resolve(&id_path).unwrap();
            assert!(matches!(
                node.provider
                    .unwrap()
                    .resolve("wrong", &node.composed, &ctx),
                ResolveRef::Terminal(None)
            ));
            let base = format!("{id_path}/1.2.3");
            let rows = runtime.fetch(&base).unwrap();
            assert_eq!(rows, runtime.fetch(&id_path).unwrap());
            assert!(rows[0].get("iconPngBase64").is_none());
            assert_eq!(
                names(&base),
                [
                    "icon",
                    "description_template",
                    "doc",
                    "changelog",
                    "asset",
                    "provider",
                    "recommended"
                ]
            );
            assert_eq!(
                runtime.fetch(&format!("{base}/icon")).unwrap(),
                vec![json!({"iconPngBase64": icon})]
            );
            assert!(runtime.fetch(&format!("{base}/doc")).unwrap()[0]["doc"]
                .as_str()
                .unwrap()
                .starts_with("# Original"));
            assert_eq!(
                runtime.fetch(&format!("{base}/changelog")).unwrap()[0]["changelog"],
                "# Changes"
            );
            assert_eq!(
                runtime
                    .fetch(&format!("{base}/description_template"))
                    .unwrap()[0]["descriptionTemplate"],
                "<%= metadata.title %>"
            );
            assert_eq!(names(&format!("{base}/asset")), ["images/a b.png"]);
            // 含斜杠的资源键按 runtime 转义规则作为单段传入。
            assert_eq!(
                runtime
                    .fetch(&format!("{base}/asset/images\\/a b.png"))
                    .unwrap()[0]["dataBase64"],
                "aW1hZ2U="
            );
            assert_eq!(
                names(&format!("{base}/recommended")),
                ["configs/default.json"]
            );
            let recommended = runtime.fetch(&format!("{base}/recommended")).unwrap();
            assert_eq!(recommended.len(), 1);
            assert_eq!(recommended[0]["path"], "configs/default.json");
            assert_eq!(recommended[0]["pluginId"], "test-file");
            assert!(recommended[0]["isImported"].is_boolean());
            assert_eq!(
                runtime
                    .fetch(&format!("{base}/recommended/configs\\/default.json"))
                    .unwrap(),
                recommended
            );
            assert_eq!(names(&format!("{base}/provider")), ["entry_provider"]);
            assert_eq!(
                runtime.fetch(&format!("{base}/provider")).unwrap()[0]["name"],
                "entry_provider"
            );
            assert!(runtime
                .fetch(&format!("{base}/provider/entry_provider"))
                .unwrap()[0]["def"]
                .is_object());
        }
        assert_eq!(
            runtime
                .fetch("plugin://byStore/source/test-file/1.2.3/provider/entry_provider")
                .unwrap()[0]["source"],
            "cached store DSL"
        );
        assert!(runtime
            .resolve("plugin://byStore/source/not-cached/1.2.3")
            .is_err());
        assert!(runtime
            .resolve("plugin://byStore/missing/test-file/1.2.3")
            .is_err());
        assert!(runtime
            .resolve("plugin://byPreview/wrong/test-file/1.2.3")
            .is_err());
        assert!(manager.store_download_states.lock().unwrap().is_empty());
        assert_eq!(manager.store_plugin_cache.load()["source"].len(), 1);

        // 同一个 runtime 和同一个路径已经被缓存，覆盖同版本后必须读到新 Plugin。
        let resource = "plugin://installed/test-file/1.2.3";
        installed.icon_png_base64 = Some("reinstalled-icon".into());
        installed.providers[0].source = Some("reinstalled DSL".into());
        manager.plugins.store(Arc::new(Some(HashMap::from([(
            installed.id.clone(),
            Arc::new(installed.clone()),
        )]))));
        assert_eq!(
            runtime.fetch(&format!("{resource}/icon")).unwrap()[0]["iconPngBase64"],
            "reinstalled-icon"
        );
        assert_eq!(
            runtime
                .fetch(&format!("{resource}/provider/entry_provider"))
                .unwrap()[0]["source"],
            "reinstalled DSL"
        );
        installed.version = "2.0.0".into();
        manager.plugins.store(Arc::new(Some(HashMap::from([(
            installed.id.clone(),
            Arc::new(installed),
        )]))));
        assert!(runtime
            .fetch(&format!("{resource}/icon"))
            .unwrap()
            .is_empty());
        assert!(runtime
            .fetch(&format!("{resource}/recommended"))
            .unwrap()
            .is_empty());
        assert!(runtime
            .fetch(&format!("{resource}/recommended/configs\\/default.json"))
            .unwrap()
            .is_empty());
        assert!(names(&format!("{resource}/recommended")).is_empty());
        assert!(names(resource).is_empty());
        assert_eq!(names("plugin://installed/test-file"), ["2.0.0"]);
        assert!(!runtime
            .fetch("plugin://installed/test-file/2.0.0")
            .unwrap()
            .is_empty());
        manager.plugins.store(Arc::new(Some(HashMap::new())));
        assert!(runtime
            .fetch("plugin://installed/test-file/2.0.0")
            .unwrap()
            .is_empty());
        assert!(names("plugin://installed/test-file").is_empty());
    }

    #[test]
    fn package_file_whitelist_normalizes_and_rejects_private_entries() {
        let plugin = plugin();
        for path in [
            "package.json",
            "icon.png",
            "docs/README.md",
            "中文.md",
            "CHANGELOG.md",
            "description.ejs",
            "configs/default.json",
            "images/a b.png",
        ] {
            assert_eq!(allowed_entry(&plugin, path).as_deref(), Some(path));
        }
        assert_eq!(
            allowed_entry(&plugin, "./docs/../images/a%20b.png#anchor").as_deref(),
            Some("images/a b.png")
        );
        for path in [
            "../package.json",
            "%2e%2e/package.json",
            "main.js",
            "migration.js",
            "huge.png",
            "unknown.json",
            "https://x/icon.png",
        ] {
            assert!(allowed_entry(&plugin, path).is_none(), "{path}");
        }
        assert!(is_recommended_config(&plugin, "configs/default.json"));
        assert!(!is_recommended_config(&plugin, "package.json"));
    }

    #[tokio::test]
    async fn package_file_keeps_lite_records_and_freezes_script_on_demand() {
        let manager = PluginManager::new();
        let (_dir, path) = kgpg(&plugin(), &[]);
        let preview = manager.preview_import_from_kgpg(&path).await.unwrap();
        assert!(preview.script.is_v8());
        assert!(preview.script.v8_source().is_none());
        assert!(preview.metadata_migration_path.is_some());
        let value = serde_json::to_value(&preview).unwrap();
        for key in [
            "doc",
            "changelog",
            "assets",
            "descriptionTemplate",
            "recommendedConfigs",
            "script",
        ] {
            assert!(value.get(key).is_none(), "{key}");
        }
        let origin = preview.file_origin.as_ref().unwrap();
        assert!(manager
            .resolve_plugin_file(&preview.id, origin, "wrong-version")
            .is_none());
        assert!(manager
            .resolve_plugin_file(&preview.id, origin, &preview.version)
            .is_some());
        assert!(manager
            .resolve_plugin_file("other", origin, &preview.version)
            .is_none());
        let loaded = manager.load_script(&preview).await.unwrap();
        assert_eq!(loaded.v8_source(), Some("export async function crawl() {}"));
        assert!(preview.script.v8_source().is_none());
        assert!(manager
            .load_metadata_migration(&preview)
            .unwrap()
            .unwrap()
            .contains("export function migrate"));
        assert_eq!(
            read_manifest_text(&preview, "kbDoc", Some("default"))
                .unwrap()
                .unwrap(),
            "# Original\n![image](images/a%20b.png)"
        );
        assert!(read_kgpg_entry(&path, "missing").unwrap().is_none());
        let tag = etag_for(&preview).unwrap();
        assert_eq!(etag_for(&preview).unwrap(), tag);
        // 冻结后不再依赖包文件。
        let (frozen, _, _) = manager
            .resolve_plugin_for_cli_run(path.to_str().unwrap(), None)
            .await
            .unwrap();
        std::fs::remove_file(path).unwrap();
        assert_eq!(frozen.script.v8_source(), loaded.v8_source());
    }

    #[tokio::test]
    async fn package_file_skips_oversized_assets_using_zip_size() {
        let mut plugin = plugin();
        let names: Vec<String> = (0..6).map(|i| format!("banner/{i}.png")).collect();
        plugin.package_json.as_mut().unwrap()["kbAssets"] = json!(names);
        let bytes = vec![0; super::super::assets::ASSET_MAX_FILE_SIZE];
        let mut extra: Vec<(&str, &[u8])> = names
            .iter()
            .map(|name| (name.as_str(), bytes.as_slice()))
            .collect();
        let huge = vec![0; bytes.len() + 1];
        extra.push(("huge.png", &huge));
        plugin.package_json.as_mut().unwrap()["kbAssets"]
            .as_array_mut()
            .unwrap()
            .push(json!("huge.png"));
        let (_dir, path) = kgpg(&plugin, &extra);
        let loaded = PluginManager::new().parse_kgpg(&path, None).await.unwrap();
        assert_eq!(loaded.asset_keys.len(), 5);
        assert!(allowed_entry(&loaded, "banner/4.png").is_some());
        assert!(allowed_entry(&loaded, "banner/5.png").is_none());
        assert!(allowed_entry(&loaded, "huge.png").is_none());
    }

    #[tokio::test]
    async fn package_file_preview_lru_and_source_maps_are_isolated() {
        let manager = PluginManager::new();
        let (_dir, path) = kgpg(&plugin(), &[]);
        let first = manager.preview_import_from_kgpg(&path).await.unwrap();
        let second = manager.preview_import_from_kgpg(&path).await.unwrap();
        for _ in 0..6 {
            manager.preview_import_from_kgpg(&path).await.unwrap();
        }
        let origin = first.file_origin.as_ref().unwrap();
        assert!(manager
            .resolve_plugin_file(&first.id, origin, &first.version)
            .is_some());
        manager.preview_import_from_kgpg(&path).await.unwrap();
        assert!(manager
            .resolve_plugin_file(
                &second.id,
                second.file_origin.as_ref().unwrap(),
                &second.version
            )
            .is_none());
        assert!(manager
            .resolve_plugin_file(&first.id, origin, &first.version)
            .is_some());
        manager.store_plugin_cache.store(Arc::new(HashMap::from([(
            "one".into(),
            HashMap::from([(first.id.clone(), first.clone())]),
        )])));
        assert!(manager
            .resolve_plugin_file(
                &first.id,
                &PluginFileOrigin::Store {
                    source_id: "one".into()
                },
                &first.version
            )
            .is_some());
        assert!(manager
            .resolve_plugin_file(
                &first.id,
                &PluginFileOrigin::Store {
                    source_id: "two".into()
                },
                &first.version
            )
            .is_none());
        manager.plugins.store(Arc::new(Some(HashMap::from([(
            first.id.clone(),
            Arc::new(first.clone()),
        )]))));
        assert!(manager
            .resolve_plugin_file(&first.id, &PluginFileOrigin::Installed, &first.version)
            .is_some());
        assert!(manager
            .resolve_plugin_file(&first.id, &PluginFileOrigin::Installed, "0.0.0")
            .is_none());
    }

    #[test]
    fn recommended_rows_and_import_states_share_content_and_skip_broken_files() {
        let mut plugin = plugin();
        plugin.base_url = "https://example.test".into();
        plugin.package_json.as_mut().unwrap()["kbRecommendedConfigs"] = json!([
            "configs/default.json",
            "configs/second.json",
            "broken.json",
            "missing.json"
        ]);
        let (_dir, path) = kgpg(&plugin, &[
            ("configs/second.json", br#"{"pluginId":"fake","filename":"fake","path":"fake","isImported":true,"url":"https://other.test"}"#),
            ("broken.json", b"not json"),
        ]);
        plugin.file_path = Some(path.to_string_lossy().into_owned());
        let config: RunConfig = serde_json::from_value(json!({
            "id":"c", "name":"renamed", "pluginId":plugin.id,
            "url":"https://example.test", "createdAt":1
        }))
        .unwrap();
        let configs = [config];
        let states = recommended_import_states(&plugin, &configs);
        assert_eq!(
            states,
            vec![
                ("configs/default.json".into(), true),
                ("configs/second.json".into(), false)
            ]
        );
        let rows = recommended_rows(&plugin, &configs);
        assert_eq!(rows.len(), 2);
        for (row, (path, imported)) in rows.iter().zip(&states) {
            assert_eq!(row["pluginId"], plugin.id);
            assert_eq!(row["path"], *path);
            assert_eq!(
                row["filename"],
                Path::new(path).file_name().unwrap().to_str().unwrap()
            );
            assert_eq!(row["isImported"], *imported);
        }
        assert_eq!(rows[1]["url"], "https://other.test");
        assert!(recommended_import_states(&plugin, &[])
            .iter()
            .all(|(_, imported)| !imported));
        assert!(recommended_rows(&plugin, &[])
            .iter()
            .all(|row| row["isImported"] == false));
    }

    #[test]
    fn recommended_diff_scope_uses_installed_and_local_store_packages_only() {
        let manager = PluginManager::new();
        let mut installed = plugin();
        let (_dir, path) = kgpg(&installed, &[]);
        installed.file_path = Some(path.to_string_lossy().into_owned());
        manager.plugins.store(Arc::new(Some(HashMap::from([(
            installed.id.clone(),
            Arc::new(installed.clone()),
        )]))));
        let mut missing = installed.clone();
        missing.file_path = Some(
            path.with_extension("missing")
                .to_string_lossy()
                .into_owned(),
        );
        manager.store_plugin_cache.store(Arc::new(HashMap::from([
            (
                "local".into(),
                HashMap::from([(installed.id.clone(), installed.clone())]),
            ),
            (
                "missing".into(),
                HashMap::from([(installed.id.clone(), missing)]),
            ),
        ])));
        let scope = manager.recommended_diff_plugins(&installed.id);
        assert_eq!(scope.len(), 2);
        assert!(scope[0].0);
        assert!(!scope[1].0);
        assert!(manager.recommended_diff_plugins("uncached").is_empty());
        manager.plugins.store(Arc::new(Some(HashMap::new())));
        let scope = manager.recommended_diff_plugins(&installed.id);
        assert_eq!(scope.len(), 1);
        assert!(!scope[0].0);
    }

    #[test]
    fn package_file_mime_uses_media_table_and_text_charset() {
        assert_eq!(mime_for_plugin_file("a.md"), "text/markdown; charset=utf-8");
        assert_eq!(
            mime_for_plugin_file("a.json"),
            "application/json; charset=utf-8"
        );
        assert_eq!(mime_for_plugin_file("a.ejs"), "text/plain; charset=utf-8");
        assert_eq!(mime_for_plugin_file("a.jpg"), "image/jpeg");
        assert_eq!(mime_for_plugin_file("a.avif"), "image/avif");
    }
}
