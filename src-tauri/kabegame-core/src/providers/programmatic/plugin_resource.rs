use std::sync::Arc;

use pathql_rs::compose::ProviderQuery;
use pathql_rs::provider::{
    ChildEntry, EngineError, ListRef, Provider, ProviderContext, ProviderRuntime, ResolveRef,
};
use serde_json::{json, Value};

use crate::plugin::{
    assets::mime_for_asset, manifest_value_display_for_locale, Plugin, PluginManager,
};
use crate::providers::query::{parse_note, ProviderNote};

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
        map.remove("assets");
        map.remove("iconPngBase64");
        map.remove("descriptionTemplate");
    }
    value
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
                name: "changelog".into(),
                provider: Some(Arc::new(PluginChangelogProvider {
                    plugin_id: self.plugin_id.clone(),
                })),
                meta: None,
            }),
            ListRef::Direct(ChildEntry {
                name: "asset".into(),
                provider: Some(Arc::new(PluginAssetRootProvider {
                    plugin_id: self.plugin_id.clone(),
                })),
                meta: None,
            }),
            ListRef::Direct(ChildEntry {
                name: "provider".into(),
                provider: Some(Arc::new(PluginProviderRootProvider {
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
            "changelog" => Some(Arc::new(PluginChangelogProvider {
                plugin_id: self.plugin_id.clone(),
            })),
            "asset" => Some(Arc::new(PluginAssetRootProvider {
                plugin_id: self.plugin_id.clone(),
            })),
            "provider" => Some(Arc::new(PluginProviderRootProvider {
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

struct PluginChangelogProvider {
    plugin_id: String,
}

impl Provider for PluginChangelogProvider {
    fn fetch_rows(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Option<Vec<Value>>, EngineError> {
        let rows = get_plugin(&self.plugin_id)
            .and_then(|plugin| plugin.changelog.clone())
            .and_then(|changelog| changelog.get("default").cloned())
            .map(|text| vec![json!({ "changelog": text })])
            .unwrap_or_default();
        Ok(Some(rows))
    }
}

struct PluginAssetRootProvider {
    plugin_id: String,
}

impl Provider for PluginAssetRootProvider {
    fn list(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Vec<ListRef>, EngineError> {
        let Some(resources) = get_plugin(&self.plugin_id).and_then(|p| p.assets.clone()) else {
            return Ok(Vec::new());
        };
        let mut keys: Vec<String> = resources.iter().map(|asset| asset.key.clone()).collect();
        keys.sort();
        Ok(keys
            .into_iter()
            .map(|key| {
                ListRef::Direct(ChildEntry {
                    name: key.clone(),
                    provider: Some(Arc::new(PluginAssetProvider {
                        plugin_id: self.plugin_id.clone(),
                        asset_path: key,
                    })),
                    meta: None,
                })
            })
            .collect())
    }

    fn resolve(&self, name: &str, _composed: &ProviderQuery, _ctx: &ProviderContext) -> ResolveRef {
        ResolveRef::Terminal(Some(ChildEntry {
            name: name.to_string(),
            provider: Some(Arc::new(PluginAssetProvider {
                plugin_id: self.plugin_id.clone(),
                asset_path: name.to_string(),
            })),
            meta: None,
        }))
    }
}

struct PluginAssetProvider {
    plugin_id: String,
    asset_path: String,
}

impl Provider for PluginAssetProvider {
    fn fetch_rows(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Option<Vec<Value>>, EngineError> {
        let rows = get_plugin(&self.plugin_id)
            .and_then(|plugin| plugin.assets.clone())
            .and_then(|assets| {
                assets
                    .into_iter()
                    .find(|asset| asset.key == self.asset_path)
                    .map(|asset| asset.data_base64)
            })
            .map(|data| {
                vec![json!({
                    // key 是归一化后的插件根相对路径。
                    "key": self.asset_path.clone(),
                    "mime": mime_for_asset(&self.asset_path),
                    "dataBase64": data,
                })]
            })
            .unwrap_or_default();
        Ok(Some(rows))
    }
}

struct PluginProviderRootProvider {
    plugin_id: String,
}

impl Provider for PluginProviderRootProvider {
    fn list(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Vec<ListRef>, EngineError> {
        let Some(plugin) = get_plugin(&self.plugin_id) else {
            return Ok(Vec::new());
        };
        let mut providers: Vec<_> = plugin.providers.iter().collect();
        providers.sort_by(|a, b| a.def.name.0.cmp(&b.def.name.0));
        Ok(providers
            .into_iter()
            .map(|provider| {
                let name = provider.def.name.0.clone();
                ListRef::Direct(ChildEntry {
                    name: name.clone(),
                    provider: Some(Arc::new(PluginProviderItemProvider {
                        plugin_id: self.plugin_id.clone(),
                        name,
                    })),
                    meta: None,
                })
            })
            .collect())
    }

    fn resolve(&self, name: &str, _composed: &ProviderQuery, _ctx: &ProviderContext) -> ResolveRef {
        let exists = get_plugin(&self.plugin_id).is_some_and(|plugin| {
            plugin
                .providers
                .iter()
                .any(|provider| provider.def.name.0 == name)
        });
        if !exists {
            return ResolveRef::Terminal(None);
        }
        ResolveRef::Terminal(Some(ChildEntry {
            name: name.to_string(),
            provider: Some(Arc::new(PluginProviderItemProvider {
                plugin_id: self.plugin_id.clone(),
                name: name.to_string(),
            })),
            meta: None,
        }))
    }

    fn fetch_rows(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Option<Vec<Value>>, EngineError> {
        let rows = get_plugin(&self.plugin_id)
            .map(|plugin| {
                let mut providers: Vec<_> = plugin.providers.iter().collect();
                providers.sort_by(|a, b| a.def.name.0.cmp(&b.def.name.0));
                providers
                    .into_iter()
                    .map(|provider| {
                        let mut row = json!({
                            "name": provider.def.name.0.clone(),
                            "namespace": provider
                                .def
                                .namespace
                                .as_ref()
                                .map(|namespace| namespace.0.clone()),
                            "sourcePath": provider.source_path.clone(),
                        });
                        let note: Option<ProviderNote> = parse_note(provider.def.note.clone());
                        if let (Value::Object(row), Some(note)) = (&mut row, note) {
                            row.insert(
                                "note".to_string(),
                                serde_json::to_value(note).unwrap_or(Value::Null),
                            );
                        }
                        row
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(Some(rows))
    }
}

struct PluginProviderItemProvider {
    plugin_id: String,
    name: String,
}

impl Provider for PluginProviderItemProvider {
    fn fetch_rows(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Option<Vec<Value>>, EngineError> {
        let rows = get_plugin(&self.plugin_id)
            .and_then(|plugin| {
                plugin
                    .providers
                    .iter()
                    .find(|provider| provider.def.name.0 == self.name)
                    .map(|provider| {
                        vec![json!({
                            "name": provider.def.name.0.clone(),
                            "namespace": provider
                                .def
                                .namespace
                                .as_ref()
                                .map(|namespace| namespace.0.clone()),
                            "sourcePath": provider.source_path.clone(),
                            "source": provider.source.clone(),
                            "def": serde_json::to_value(&provider.def).unwrap_or(Value::Null),
                        })]
                    })
            })
            .unwrap_or_default();
        Ok(Some(rows))
    }
}
