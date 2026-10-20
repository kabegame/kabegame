//! 插件文件的统一按需读取出口；HTTP 与 MCP 共用白名单和 ZIP 读取逻辑。
use super::{assets::normalize_asset_path, Plugin, PluginManager, PluginScript, VarDefinition};
use crate::plugin::var_canonical::canonical_user_config_for_compare;
use crate::storage::{RunConfig, Storage};
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

impl PluginManager {
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

pub fn annotate_recommended_config(
    plugin: &Plugin,
    path: &str,
    json: Value,
) -> Result<Value, String> {
    let configs = Storage::global().get_run_configs()?;
    Ok(annotate_with_configs(plugin, path, json, &configs))
}

fn annotate_with_configs(plugin: &Plugin, path: &str, json: Value, configs: &[RunConfig]) -> Value {
    let imported = configs.iter().any(|config| {
        preset_content_matches(
            &plugin.id,
            &plugin.base_url,
            &plugin.var_defs,
            &json,
            config,
        )
    });
    let mut object = json.as_object().cloned().unwrap_or_default();
    object.insert("pluginId".into(), Value::String(plugin.id.clone()));
    object.insert(
        "filename".into(),
        Value::String(
            Path::new(path)
                .file_name()
                .and_then(|v| v.to_str())
                .unwrap_or("")
                .to_string(),
        ),
    );
    object.insert("isImported".into(), Value::Bool(imported));
    Value::Object(object)
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
    fn package_file_annotates_imported_state_and_overrides_untrusted_identity() {
        let plugin = plugin();
        let config: RunConfig = serde_json::from_value(json!({
            "id":"c", "name":"renamed", "pluginId":plugin.id, "url":"https://example.test", "createdAt":1
        })).unwrap();
        let mut plugin = plugin;
        plugin.base_url = "https://example.test".into();
        let raw = json!({"pluginId":"fake","filename":"fake.json","isImported":false});
        let value = annotate_with_configs(&plugin, "configs/default.json", raw.clone(), &[config]);
        assert_eq!(value["pluginId"], plugin.id);
        assert_eq!(value["filename"], "default.json");
        assert_eq!(value["isImported"], true);
        assert_eq!(
            annotate_with_configs(&plugin, "configs/default.json", raw, &[])["isImported"],
            false
        );
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
