use std::sync::Arc;

use pathql_rs::compose::ProviderQuery;
use pathql_rs::provider::{
    ChildEntry, EngineError, ListRef, Provider, ProviderContext, ProviderRuntime, ResolveRef,
};
use serde_json::{json, Value};

use crate::plugin::{Plugin, PluginManager, manifest_value_display_for_locale};

pub fn register_plugin_resource_provider(runtime: &ProviderRuntime) -> Result<(), EngineError> {
    runtime.register_programmatic_provider("kabegame", "plugin_resource_root_provider", |_| {
        Ok(Arc::new(PluginRootProvider) as Arc<dyn Provider>)
    })
}

fn plugin_manager() -> Option<&'static PluginManager> {
    PluginManager::global_opt()
}

fn get_plugin(plugin_id: &str) -> Option<Arc<Plugin>> {
    plugin_manager()?.get(plugin_id)
}

fn all_plugins() -> Result<Vec<Arc<Plugin>>, EngineError> {
    match plugin_manager() {
        Some(manager) => manager.get_all().map_err(plugin_error),
        None => Ok(Vec::new()),
    }
}

fn plugin_error(message: String) -> EngineError {
    EngineError::FactoryFailed("kabegame".into(), "plugin_resource".into(), message)
}

fn serialize_plugin_lite(plugin: &Arc<Plugin>) -> Value {
    let mut value = serde_json::to_value(plugin.as_ref()).unwrap_or(Value::Null);
    if let Value::Object(ref mut map) = value {
        map.insert(
            "displayName".to_string(),
            Value::String(manifest_value_display_for_locale(
                &plugin.name,
                kabegame_i18n::current_vd_locale(),
            )),
        );
        map.remove("docResources");
        map.remove("iconPngBase64");
        map.remove("descriptionTemplate");
    }
    value
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

struct PluginRootProvider;

impl Provider for PluginRootProvider {
    fn list(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Vec<ListRef>, EngineError> {
        Ok(all_plugins()?
            .into_iter()
            .map(|plugin| {
                ListRef::Direct(ChildEntry {
                    name: plugin.id.clone(),
                    provider: Some(Arc::new(PluginEntryProvider {
                        plugin_id: plugin.id.clone(),
                    })),
                    meta: None,
                })
            })
            .collect())
    }

    fn resolve(&self, name: &str, _composed: &ProviderQuery, _ctx: &ProviderContext) -> ResolveRef {
        if get_plugin(name).is_none() {
            return ResolveRef::Terminal(None);
        }
        ResolveRef::Terminal(Some(ChildEntry {
            name: name.to_string(),
            provider: Some(Arc::new(PluginEntryProvider {
                plugin_id: name.to_string(),
            })),
            meta: None,
        }))
    }

    fn fetch_rows(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Option<Vec<Value>>, EngineError> {
        Ok(Some(
            all_plugins()?.iter().map(serialize_plugin_lite).collect(),
        ))
    }
}

struct PluginEntryProvider {
    plugin_id: String,
}

impl Provider for PluginEntryProvider {
    fn list(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Vec<ListRef>, EngineError> {
        Ok(vec![
            ListRef::Direct(ChildEntry {
                name: "icon".into(),
                provider: Some(Arc::new(PluginIconProvider {
                    plugin_id: self.plugin_id.clone(),
                })),
                meta: None,
            }),
            ListRef::Direct(ChildEntry {
                name: "description_template".into(),
                provider: Some(Arc::new(PluginDescriptionTemplateProvider {
                    plugin_id: self.plugin_id.clone(),
                })),
                meta: None,
            }),
            ListRef::Direct(ChildEntry {
                name: "doc".into(),
                provider: Some(Arc::new(PluginDocProvider {
                    plugin_id: self.plugin_id.clone(),
                })),
                meta: None,
            }),
            ListRef::Direct(ChildEntry {
                name: "doc_resource".into(),
                provider: Some(Arc::new(PluginDocResourceRootProvider {
                    plugin_id: self.plugin_id.clone(),
                })),
                meta: None,
            }),
        ])
    }

    fn resolve(&self, name: &str, _composed: &ProviderQuery, _ctx: &ProviderContext) -> ResolveRef {
        let provider: Option<Arc<dyn Provider>> = match name {
            "icon" => Some(Arc::new(PluginIconProvider {
                plugin_id: self.plugin_id.clone(),
            })),
            "description_template" => Some(Arc::new(PluginDescriptionTemplateProvider {
                plugin_id: self.plugin_id.clone(),
            })),
            "doc" => Some(Arc::new(PluginDocProvider {
                plugin_id: self.plugin_id.clone(),
            })),
            "doc_resource" => Some(Arc::new(PluginDocResourceRootProvider {
                plugin_id: self.plugin_id.clone(),
            })),
            _ => None,
        };
        ResolveRef::Terminal(provider.map(|provider| ChildEntry {
            name: name.to_string(),
            provider: Some(provider),
            meta: None,
        }))
    }

    fn fetch_rows(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Option<Vec<Value>>, EngineError> {
        Ok(Some(
            get_plugin(&self.plugin_id)
                .map(|plugin| vec![serialize_plugin_lite(&plugin)])
                .unwrap_or_default(),
        ))
    }
}

struct PluginIconProvider {
    plugin_id: String,
}

impl Provider for PluginIconProvider {
    fn fetch_rows(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Option<Vec<Value>>, EngineError> {
        let rows = get_plugin(&self.plugin_id)
            .and_then(|plugin| plugin.icon_png_base64.clone())
            .map(|icon| vec![json!({ "iconPngBase64": icon })])
            .unwrap_or_default();
        Ok(Some(rows))
    }
}

struct PluginDescriptionTemplateProvider {
    plugin_id: String,
}

impl Provider for PluginDescriptionTemplateProvider {
    fn fetch_rows(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Option<Vec<Value>>, EngineError> {
        let rows = get_plugin(&self.plugin_id)
            .and_then(|plugin| plugin.description_template.clone())
            .map(|template| vec![json!({ "descriptionTemplate": template })])
            .unwrap_or_default();
        Ok(Some(rows))
    }
}

struct PluginDocProvider {
    plugin_id: String,
}

impl Provider for PluginDocProvider {
    fn fetch_rows(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Option<Vec<Value>>, EngineError> {
        let rows = get_plugin(&self.plugin_id)
            .and_then(|plugin| plugin.doc.clone())
            .and_then(|doc| doc.get("default").cloned())
            .map(|doc| vec![json!({ "doc": doc })])
            .unwrap_or_default();
        Ok(Some(rows))
    }
}

struct PluginDocResourceRootProvider {
    plugin_id: String,
}

impl Provider for PluginDocResourceRootProvider {
    fn list(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Vec<ListRef>, EngineError> {
        let Some(resources) = get_plugin(&self.plugin_id).and_then(|p| p.doc_resources.clone())
        else {
            return Ok(Vec::new());
        };
        let mut keys: Vec<String> = resources.keys().cloned().collect();
        keys.sort();
        Ok(keys
            .into_iter()
            .map(|key| {
                ListRef::Direct(ChildEntry {
                    name: key.clone(),
                    provider: Some(Arc::new(PluginDocResourceProvider {
                        plugin_id: self.plugin_id.clone(),
                        resource_key: key,
                    })),
                    meta: None,
                })
            })
            .collect())
    }

    fn resolve(&self, name: &str, _composed: &ProviderQuery, _ctx: &ProviderContext) -> ResolveRef {
        ResolveRef::Terminal(Some(ChildEntry {
            name: name.to_string(),
            provider: Some(Arc::new(PluginDocResourceProvider {
                plugin_id: self.plugin_id.clone(),
                resource_key: name.to_string(),
            })),
            meta: None,
        }))
    }
}

struct PluginDocResourceProvider {
    plugin_id: String,
    resource_key: String,
}

impl Provider for PluginDocResourceProvider {
    fn fetch_rows(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Option<Vec<Value>>, EngineError> {
        let rows = get_plugin(&self.plugin_id)
            .and_then(|plugin| plugin.doc_resources.clone())
            .and_then(|resources| resources.get(&self.resource_key).cloned())
            .map(|data| {
                vec![json!({
                    "key": self.resource_key.clone(),
                    "mime": mime_for_key(&self.resource_key),
                    "dataBase64": data,
                })]
            })
            .unwrap_or_default();
        Ok(Some(rows))
    }
}
