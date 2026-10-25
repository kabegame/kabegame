use std::sync::Arc;

use pathql_rs::compose::ProviderQuery;
use pathql_rs::provider::{
    ChildEntry, EngineError, ListRef, Provider, ProviderContext, ProviderRuntime, ResolveRef,
};
use serde_json::{json, Value};

use crate::plugin::package_file::{is_recommended_config, recommended_rows};
use crate::plugin::{
    assets::mime_for_asset, manifest_value_display_for_locale, package_file::PluginFileOrigin,
    Plugin, PluginManager,
};
use crate::providers::query::{parse_note, ProviderNote};
use crate::storage::Storage;

pub fn register_plugin_resource_provider(runtime: &ProviderRuntime) -> Result<(), EngineError> {
    runtime.register_programmatic_provider("kabegame", "plugin_resource_root_provider", |_| {
        Ok(Arc::new(PluginRootProvider) as Arc<dyn Provider>)
    })
}

fn plugin_manager() -> Option<&'static PluginManager> {
    PluginManager::global_opt()
}

/// runtime 会缓存路径前缀的 provider；坐标每次读取都重新解析，不能持有旧 Plugin。
#[derive(Clone)]
pub struct PluginCoord {
    pub origin: PluginFileOrigin,
    pub id: String,
    pub version: String,
}

impl PluginCoord {
    fn plugin(&self) -> Option<Arc<Plugin>> {
        plugin_manager()?.resolve_plugin_file(&self.id, &self.origin, &self.version)
    }
}

fn current_coord(origin: &PluginFileOrigin, id: &str) -> Option<PluginCoord> {
    let coord = PluginCoord {
        origin: origin.clone(),
        id: id.into(),
        version: plugin_manager()?.plugin_file_version(id, origin)?,
    };
    coord.plugin()?;
    Some(coord)
}

fn child(name: &str, provider: impl Provider + 'static) -> ChildEntry {
    ChildEntry {
        total: None,
        name: name.into(),
        provider: Some(Arc::new(provider)),
        meta: None,
    }
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
        map.remove("iconPngBase64");
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
        // byPreview 的 token 是凭据，根和预览层都不可枚举它。
        Ok(vec![
            ListRef::Direct(child(
                "installed",
                PluginOriginProvider {
                    origin: PluginFileOrigin::Installed,
                },
            )),
            ListRef::Direct(child("byStore", PluginStoreRootProvider)),
        ])
    }

    fn resolve(&self, name: &str, _composed: &ProviderQuery, _ctx: &ProviderContext) -> ResolveRef {
        let entry = match name {
            "installed" => Some(child(
                name,
                PluginOriginProvider {
                    origin: PluginFileOrigin::Installed,
                },
            )),
            "byStore" => Some(child(name, PluginStoreRootProvider)),
            "byPreview" => Some(child(name, PluginPreviewRootProvider)),
            _ => None,
        };
        ResolveRef::Terminal(entry)
    }

    fn fetch_rows(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Option<Vec<Value>>, EngineError> {
        Ok(Some(
            all_plugins()?
                .iter()
                .filter_map(|p| {
                    PluginCoord {
                        origin: PluginFileOrigin::Installed,
                        id: p.id.clone(),
                        version: p.version.clone(),
                    }
                    .plugin()
                })
                .map(|p| serialize_plugin_lite(&p))
                .collect(),
        ))
    }
}

struct PluginStoreRootProvider;

impl Provider for PluginStoreRootProvider {
    fn list(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Vec<ListRef>, EngineError> {
        Ok(plugin_manager()
            .map(|m| m.plugin_file_store_sources())
            .unwrap_or_default()
            .into_iter()
            .map(|source_id| {
                ListRef::Direct(child(
                    &source_id,
                    PluginOriginProvider {
                        origin: PluginFileOrigin::Store {
                            source_id: source_id.clone(),
                        },
                    },
                ))
            })
            .collect())
    }

    fn resolve(&self, name: &str, _composed: &ProviderQuery, _ctx: &ProviderContext) -> ResolveRef {
        let exists = plugin_manager()
            .is_some_and(|m| m.plugin_file_store_sources().iter().any(|s| s == name));
        ResolveRef::Terminal(exists.then(|| {
            child(
                name,
                PluginOriginProvider {
                    origin: PluginFileOrigin::Store {
                        source_id: name.into(),
                    },
                },
            )
        }))
    }
}

struct PluginPreviewRootProvider;

impl Provider for PluginPreviewRootProvider {
    fn resolve(&self, name: &str, _composed: &ProviderQuery, _ctx: &ProviderContext) -> ResolveRef {
        ResolveRef::Terminal(Some(child(
            name,
            PluginOriginProvider {
                origin: PluginFileOrigin::Preview { token: name.into() },
            },
        )))
    }
}

struct PluginOriginProvider {
    origin: PluginFileOrigin,
}

impl Provider for PluginOriginProvider {
    fn list(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Vec<ListRef>, EngineError> {
        let ids = plugin_manager()
            .map(|m| m.plugin_file_ids(&self.origin))
            .transpose()
            .map_err(plugin_error)?
            .unwrap_or_default();
        Ok(ids
            .into_iter()
            .filter_map(|id| {
                current_coord(&self.origin, &id)?;
                Some(ListRef::Direct(child(
                    &id,
                    PluginIdProvider {
                        origin: self.origin.clone(),
                        id: id.clone(),
                    },
                )))
            })
            .collect())
    }

    fn resolve(&self, name: &str, _composed: &ProviderQuery, _ctx: &ProviderContext) -> ResolveRef {
        ResolveRef::Terminal(current_coord(&self.origin, name).map(|_| {
            child(
                name,
                PluginIdProvider {
                    origin: self.origin.clone(),
                    id: name.into(),
                },
            )
        }))
    }

    fn fetch_rows(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Option<Vec<Value>>, EngineError> {
        let ids = plugin_manager()
            .map(|m| m.plugin_file_ids(&self.origin))
            .transpose()
            .map_err(plugin_error)?
            .unwrap_or_default();
        Ok(Some(
            ids.iter()
                .filter_map(|id| current_coord(&self.origin, id)?.plugin())
                .map(|p| serialize_plugin_lite(&p))
                .collect(),
        ))
    }
}

// id 层不固定版本，重读时总是返回来源里的当前版本。
struct PluginIdProvider {
    origin: PluginFileOrigin,
    id: String,
}

impl Provider for PluginIdProvider {
    fn list(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Vec<ListRef>, EngineError> {
        Ok(current_coord(&self.origin, &self.id)
            .map(|coord| {
                vec![ListRef::Direct(child(
                    &coord.version.clone(),
                    PluginEntryProvider { coord },
                ))]
            })
            .unwrap_or_default())
    }

    fn resolve(&self, name: &str, _composed: &ProviderQuery, _ctx: &ProviderContext) -> ResolveRef {
        let coord = PluginCoord {
            origin: self.origin.clone(),
            id: self.id.clone(),
            version: name.into(),
        };
        ResolveRef::Terminal(
            coord
                .plugin()
                .map(|_| child(name, PluginEntryProvider { coord })),
        )
    }

    fn fetch_rows(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Option<Vec<Value>>, EngineError> {
        Ok(Some(
            current_coord(&self.origin, &self.id)
                .and_then(|coord| coord.plugin())
                .map(|p| vec![serialize_plugin_lite(&p)])
                .unwrap_or_default(),
        ))
    }
}

struct PluginEntryProvider {
    coord: PluginCoord,
}

impl Provider for PluginEntryProvider {
    fn list(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Vec<ListRef>, EngineError> {
        if self.coord.plugin().is_none() {
            return Ok(Vec::new());
        }
        Ok(vec![
            ListRef::Direct(ChildEntry {
                total: None,
                name: "icon".into(),
                provider: Some(Arc::new(PluginIconProvider {
                    coord: self.coord.clone(),
                })),
                meta: None,
            }),
            ListRef::Direct(ChildEntry {
                total: None,
                name: "description_template".into(),
                provider: Some(Arc::new(PluginDescriptionTemplateProvider {
                    coord: self.coord.clone(),
                })),
                meta: None,
            }),
            ListRef::Direct(ChildEntry {
                total: None,
                name: "doc".into(),
                provider: Some(Arc::new(PluginDocProvider {
                    coord: self.coord.clone(),
                })),
                meta: None,
            }),
            ListRef::Direct(ChildEntry {
                total: None,
                name: "changelog".into(),
                provider: Some(Arc::new(PluginChangelogProvider {
                    coord: self.coord.clone(),
                })),
                meta: None,
            }),
            ListRef::Direct(ChildEntry {
                total: None,
                name: "asset".into(),
                provider: Some(Arc::new(PluginAssetRootProvider {
                    coord: self.coord.clone(),
                })),
                meta: None,
            }),
            ListRef::Direct(ChildEntry {
                total: None,
                name: "provider".into(),
                provider: Some(Arc::new(PluginProviderRootProvider {
                    coord: self.coord.clone(),
                })),
                meta: None,
            }),
            ListRef::Direct(child(
                "recommended",
                PluginRecommendedProvider {
                    coord: self.coord.clone(),
                    path: None,
                },
            )),
        ])
    }

    fn resolve(&self, name: &str, _composed: &ProviderQuery, _ctx: &ProviderContext) -> ResolveRef {
        if self.coord.plugin().is_none() {
            return ResolveRef::Terminal(None);
        }
        let provider: Option<Arc<dyn Provider>> = match name {
            "icon" => Some(Arc::new(PluginIconProvider {
                coord: self.coord.clone(),
            })),
            "description_template" => Some(Arc::new(PluginDescriptionTemplateProvider {
                coord: self.coord.clone(),
            })),
            "doc" => Some(Arc::new(PluginDocProvider {
                coord: self.coord.clone(),
            })),
            "changelog" => Some(Arc::new(PluginChangelogProvider {
                coord: self.coord.clone(),
            })),
            "asset" => Some(Arc::new(PluginAssetRootProvider {
                coord: self.coord.clone(),
            })),
            "provider" => Some(Arc::new(PluginProviderRootProvider {
                coord: self.coord.clone(),
            })),
            "recommended" => Some(Arc::new(PluginRecommendedProvider {
                coord: self.coord.clone(),
                path: None,
            })),
            _ => None,
        };
        ResolveRef::Terminal(provider.map(|provider| ChildEntry {
            total: None,
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
            self.coord
                .plugin()
                .map(|plugin| vec![serialize_plugin_lite(&plugin)])
                .unwrap_or_default(),
        ))
    }
}

struct PluginIconProvider {
    coord: PluginCoord,
}

impl Provider for PluginIconProvider {
    fn fetch_rows(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Option<Vec<Value>>, EngineError> {
        let rows = self
            .coord
            .plugin()
            .and_then(|plugin| plugin.icon_png_base64.clone())
            .map(|icon| vec![json!({ "iconPngBase64": icon })])
            .unwrap_or_default();
        Ok(Some(rows))
    }
}

struct PluginDescriptionTemplateProvider {
    coord: PluginCoord,
}

impl Provider for PluginDescriptionTemplateProvider {
    fn fetch_rows(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Option<Vec<Value>>, EngineError> {
        let rows = self
            .coord
            .plugin()
            .map(|plugin| {
                crate::plugin::package_file::read_manifest_text(
                    &plugin,
                    "kbDescriptionTemplate",
                    None,
                )
            })
            .transpose()
            .map_err(plugin_error)?
            .flatten()
            .map(|template| vec![json!({ "descriptionTemplate": template })])
            .unwrap_or_default();
        Ok(Some(rows))
    }
}

struct PluginDocProvider {
    coord: PluginCoord,
}

impl Provider for PluginDocProvider {
    fn fetch_rows(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Option<Vec<Value>>, EngineError> {
        let rows = self
            .coord
            .plugin()
            .map(|plugin| {
                crate::plugin::package_file::read_manifest_text(&plugin, "kbDoc", Some("default"))
            })
            .transpose()
            .map_err(plugin_error)?
            .flatten()
            .map(|doc| vec![json!({ "doc": doc })])
            .unwrap_or_default();
        Ok(Some(rows))
    }
}

struct PluginChangelogProvider {
    coord: PluginCoord,
}

impl Provider for PluginChangelogProvider {
    fn fetch_rows(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Option<Vec<Value>>, EngineError> {
        let rows = self
            .coord
            .plugin()
            .map(|plugin| {
                crate::plugin::package_file::read_manifest_text(
                    &plugin,
                    "kbChangelog",
                    Some("default"),
                )
            })
            .transpose()
            .map_err(plugin_error)?
            .flatten()
            .map(|text| vec![json!({ "changelog": text })])
            .unwrap_or_default();
        Ok(Some(rows))
    }
}

struct PluginAssetRootProvider {
    coord: PluginCoord,
}

impl Provider for PluginAssetRootProvider {
    fn list(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Vec<ListRef>, EngineError> {
        let Some(resources) = self.coord.plugin().map(|p| p.asset_keys.clone()) else {
            return Ok(Vec::new());
        };
        let mut keys: Vec<String> = resources;
        keys.sort();
        Ok(keys
            .into_iter()
            .map(|key| {
                ListRef::Direct(ChildEntry {
                    total: None,
                    name: key.clone(),
                    provider: Some(Arc::new(PluginAssetProvider {
                        coord: self.coord.clone(),
                        asset_path: key,
                    })),
                    meta: None,
                })
            })
            .collect())
    }

    fn resolve(&self, name: &str, _composed: &ProviderQuery, _ctx: &ProviderContext) -> ResolveRef {
        if self.coord.plugin().is_none() {
            return ResolveRef::Terminal(None);
        }
        ResolveRef::Terminal(Some(ChildEntry {
            total: None,
            name: name.to_string(),
            provider: Some(Arc::new(PluginAssetProvider {
                coord: self.coord.clone(),
                asset_path: name.to_string(),
            })),
            meta: None,
        }))
    }
}

struct PluginAssetProvider {
    coord: PluginCoord,
    asset_path: String,
}

impl Provider for PluginAssetProvider {
    fn fetch_rows(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Option<Vec<Value>>, EngineError> {
        let rows = self
            .coord
            .plugin()
            .filter(|plugin| plugin.asset_keys.contains(&self.asset_path))
            .map(|plugin| {
                let path = plugin
                    .file_path
                    .as_ref()
                    .ok_or("插件无文件路径".to_string())?;
                crate::plugin::package_file::read_kgpg_entry(
                    std::path::Path::new(path),
                    &self.asset_path,
                )
            })
            .transpose()
            .map_err(plugin_error)?
            .flatten()
            .map(|bytes| {
                use base64::Engine;
                base64::engine::general_purpose::STANDARD.encode(bytes)
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
    coord: PluginCoord,
}

impl Provider for PluginProviderRootProvider {
    fn list(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Vec<ListRef>, EngineError> {
        let Some(plugin) = self.coord.plugin() else {
            return Ok(Vec::new());
        };
        let mut providers: Vec<_> = plugin.providers.iter().collect();
        providers.sort_by(|a, b| a.def.name.0.cmp(&b.def.name.0));
        Ok(providers
            .into_iter()
            .map(|provider| {
                let name = provider.def.name.0.clone();
                ListRef::Direct(ChildEntry {
                    total: None,
                    name: name.clone(),
                    provider: Some(Arc::new(PluginProviderItemProvider {
                        coord: self.coord.clone(),
                        name,
                    })),
                    meta: None,
                })
            })
            .collect())
    }

    fn resolve(&self, name: &str, _composed: &ProviderQuery, _ctx: &ProviderContext) -> ResolveRef {
        let exists = self.coord.plugin().is_some_and(|plugin| {
            plugin
                .providers
                .iter()
                .any(|provider| provider.def.name.0 == name)
        });
        if !exists {
            return ResolveRef::Terminal(None);
        }
        ResolveRef::Terminal(Some(ChildEntry {
            total: None,
            name: name.to_string(),
            provider: Some(Arc::new(PluginProviderItemProvider {
                coord: self.coord.clone(),
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
        let rows = self
            .coord
            .plugin()
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
    coord: PluginCoord,
    name: String,
}

impl Provider for PluginProviderItemProvider {
    fn fetch_rows(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Option<Vec<Value>>, EngineError> {
        let rows = self
            .coord
            .plugin()
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

/// 推荐目录与单项共用坐标，声明路径作为单个段（与 asset 相同）。
struct PluginRecommendedProvider {
    coord: PluginCoord,
    path: Option<String>,
}

impl Provider for PluginRecommendedProvider {
    fn list(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Vec<ListRef>, EngineError> {
        if self.path.is_some() {
            return Ok(Vec::new());
        }
        let Some(plugin) = self.coord.plugin() else {
            return Ok(Vec::new());
        };
        Ok(plugin
            .package_json
            .as_ref()
            .and_then(|pkg| pkg.get("kbRecommendedConfigs"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|path| {
                ListRef::Direct(child(
                    path,
                    PluginRecommendedProvider {
                        coord: self.coord.clone(),
                        path: Some(path.into()),
                    },
                ))
            })
            .collect())
    }

    fn resolve(&self, name: &str, _composed: &ProviderQuery, _ctx: &ProviderContext) -> ResolveRef {
        let exists = self.path.is_none()
            && self
                .coord
                .plugin()
                .is_some_and(|plugin| is_recommended_config(&plugin, name));
        ResolveRef::Terminal(exists.then(|| {
            child(
                name,
                PluginRecommendedProvider {
                    coord: self.coord.clone(),
                    path: Some(name.into()),
                },
            )
        }))
    }

    fn fetch_rows(
        &self,
        _composed: &ProviderQuery,
        _ctx: &ProviderContext,
    ) -> Result<Option<Vec<Value>>, EngineError> {
        let Some(plugin) = self.coord.plugin() else {
            return Ok(Some(Vec::new()));
        };
        let configs = Storage::global().get_run_configs().map_err(plugin_error)?;
        let rows = recommended_rows(&plugin, &configs)
            .into_iter()
            .filter(|row| {
                self.path.as_ref().is_none_or(|path| {
                    row.get("path").and_then(Value::as_str) == Some(path.as_str())
                })
            })
            .collect();
        Ok(Some(rows))
    }
}
