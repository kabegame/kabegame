mod typescript;

use crate::ast::{
    DynamicListEntry, ListEntry, Namespace, ProviderDef, ProviderInvocation, ProviderName,
    SimpleName,
};
use crate::provider::{EngineError, ProviderKey, ProviderRuntime};
use crate::registry::{ProviderRegistry, RegistryEntry};
use std::collections::{BTreeMap, BTreeSet, HashMap};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum CodegenTarget {
    TypeScript,
}

impl ProviderRuntime {
    pub fn client_codegen(&self, target: CodegenTarget) -> Result<String, EngineError> {
        let model = CodegenModel::inspect(self);
        match target {
            CodegenTarget::TypeScript => Ok(typescript::emit(&model)),
        }
    }
}

#[derive(Debug)]
pub(crate) struct CodegenModel {
    pub(crate) providers: Vec<ProviderNode>,
    pub(crate) placeholders: Vec<PlaceholderNode>,
    pub(crate) schemes: Vec<SchemeNode>,
}

#[derive(Debug)]
pub(crate) struct ProviderNode {
    pub(crate) fqn: String,
    pub(crate) type_name: String,
    pub(crate) edges: Vec<Edge>,
}

#[derive(Debug)]
pub(crate) struct PlaceholderNode {
    pub(crate) type_name: String,
    pub(crate) source: String,
}

#[derive(Debug)]
pub(crate) struct SchemeNode {
    pub(crate) scheme: String,
    pub(crate) target: EdgeTarget,
}

#[derive(Debug)]
pub(crate) struct Edge {
    pub(crate) kind: EdgeKind,
    pub(crate) target: EdgeTarget,
}

#[derive(Debug)]
pub(crate) enum EdgeKind {
    Static { key: String },
    Resolve { alias: String },
    Dynamic { alias: Option<String> },
}

#[derive(Debug, Clone)]
pub(crate) struct EdgeTarget {
    pub(crate) type_name: String,
    pub(crate) concrete: bool,
}

#[derive(Debug)]
struct RawProviderNode {
    fqn: String,
    edges: Vec<RawEdge>,
}

#[derive(Debug)]
struct RawEdge {
    kind: EdgeKind,
    target: RawTarget,
}

#[derive(Debug, Clone)]
enum RawTarget {
    Concrete(String),
    Placeholder(PlaceholderKey),
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum PlaceholderKey {
    Programmatic(String),
    Unresolved(String),
    HostBinding {
        host: String,
        binding: String,
    },
    Fallback {
        host: String,
        edge_kind: &'static str,
        ordinal: usize,
    },
}

impl CodegenModel {
    fn inspect(runtime: &ProviderRuntime) -> Self {
        let registry = runtime.client_codegen_registry();
        let mut registry_entries: Vec<_> = registry.iter().collect();
        registry_entries
            .sort_by(|(left, _), (right, _)| provider_fqn(left).cmp(&provider_fqn(right)));

        let mut raw_providers = Vec::new();
        let mut placeholders = BTreeMap::new();
        for (key, entry) in &registry_entries {
            let fqn = provider_fqn(key);
            match entry {
                RegistryEntry::Dsl(def) => raw_providers.push(RawProviderNode {
                    fqn: fqn.clone(),
                    edges: collect_edges(&registry, key, def, &mut placeholders),
                }),
                RegistryEntry::Programmatic(_) => {
                    register_placeholder(
                        &mut placeholders,
                        PlaceholderKey::Programmatic(fqn.clone()),
                    );
                }
            }
        }

        let raw_schemes: Vec<_> = runtime
            .client_codegen_schemas()
            .into_iter()
            .map(|(scheme, key)| {
                let target = target_for_key(&registry, &key, &mut placeholders);
                (scheme, target)
            })
            .collect();

        let mut used_names = BTreeSet::new();
        let mut concrete_names = HashMap::new();
        for raw in &raw_providers {
            let desired = format!("{}Node", pascal_case(&raw.fqn));
            let type_name = allocate_type_name(&desired, &mut used_names);
            concrete_names.insert(raw.fqn.clone(), type_name);
        }

        let mut placeholder_names = BTreeMap::new();
        for key in placeholders.keys() {
            let desired = placeholder_type_name(key);
            let type_name = allocate_type_name(&desired, &mut used_names);
            placeholder_names.insert(key.clone(), type_name);
        }

        let providers = raw_providers
            .into_iter()
            .map(|raw| ProviderNode {
                type_name: concrete_names[&raw.fqn].clone(),
                fqn: raw.fqn,
                edges: raw
                    .edges
                    .into_iter()
                    .map(|edge| Edge {
                        kind: edge.kind,
                        target: resolve_target(&edge.target, &concrete_names, &placeholder_names),
                    })
                    .collect(),
            })
            .collect();

        let placeholders = placeholders
            .into_iter()
            .map(|(key, source)| PlaceholderNode {
                type_name: placeholder_names[&key].clone(),
                source,
            })
            .collect();

        let schemes = raw_schemes
            .into_iter()
            .map(|(scheme, target)| SchemeNode {
                scheme,
                target: resolve_target(&target, &concrete_names, &placeholder_names),
            })
            .collect();

        Self {
            providers,
            placeholders,
            schemes,
        }
    }
}

fn collect_edges(
    registry: &ProviderRegistry,
    host_key: &(Namespace, SimpleName),
    def: &ProviderDef,
    placeholders: &mut BTreeMap<PlaceholderKey, String>,
) -> Vec<RawEdge> {
    let host_fqn = provider_fqn(host_key);
    let mut edges = Vec::new();

    if let Some(list) = &def.list {
        for (index, (key, entry)) in list.entries.iter().enumerate() {
            match entry {
                ListEntry::Static(invocation) if !key.contains("${") => {
                    let target = target_for_invocation(
                        registry,
                        &host_key.0,
                        invocation,
                        &host_fqn,
                        "List",
                        index + 1,
                        placeholders,
                    );
                    edges.push(RawEdge {
                        kind: EdgeKind::Static { key: key.clone() },
                        target,
                    });
                }
                ListEntry::Static(_) => {}
                ListEntry::Dynamic(DynamicListEntry::Sql(entry)) => {
                    let target = match &entry.provider {
                        Some(provider) if provider.0.contains("${") => placeholder_target(
                            placeholders,
                            PlaceholderKey::HostBinding {
                                host: host_fqn.clone(),
                                binding: entry.data_var.0.clone(),
                            },
                        ),
                        Some(provider) => {
                            target_for_provider_name(registry, &host_key.0, provider, placeholders)
                        }
                        None => placeholder_target(
                            placeholders,
                            PlaceholderKey::Fallback {
                                host: host_fqn.clone(),
                                edge_kind: "List",
                                ordinal: index + 1,
                            },
                        ),
                    };
                    edges.push(RawEdge {
                        kind: EdgeKind::Dynamic {
                            alias: entry.alias.clone(),
                        },
                        target,
                    });
                }
                ListEntry::Dynamic(DynamicListEntry::Delegate(entry)) => {
                    let target = placeholder_target(
                        placeholders,
                        PlaceholderKey::HostBinding {
                            host: host_fqn.clone(),
                            binding: entry.child_var.0.clone(),
                        },
                    );
                    edges.push(RawEdge {
                        kind: EdgeKind::Dynamic {
                            alias: entry.alias.clone(),
                        },
                        target,
                    });
                }
            }
        }
    }

    if let Some(resolve) = &def.resolve {
        let mut entries: Vec<_> = resolve.0.iter().collect();
        entries.sort_by(|(left, _), (right, _)| left.cmp(right));
        for (index, (_, entry)) in entries.into_iter().enumerate() {
            let Some(alias) = &entry.alias else {
                continue;
            };
            let target = target_for_invocation(
                registry,
                &host_key.0,
                &entry.invocation,
                &host_fqn,
                "Resolve",
                index + 1,
                placeholders,
            );
            edges.push(RawEdge {
                kind: EdgeKind::Resolve {
                    alias: alias.clone(),
                },
                target,
            });
        }
    }

    edges
}

fn target_for_invocation(
    registry: &ProviderRegistry,
    current_ns: &Namespace,
    invocation: &ProviderInvocation,
    host_fqn: &str,
    edge_kind: &'static str,
    ordinal: usize,
    placeholders: &mut BTreeMap<PlaceholderKey, String>,
) -> RawTarget {
    match invocation {
        ProviderInvocation::ByName(entry) if !entry.provider.0.contains("${") => {
            target_for_provider_name(registry, current_ns, &entry.provider, placeholders)
        }
        ProviderInvocation::ByDelegate(entry) => {
            if let Some(child_var) = &entry.child_var {
                placeholder_target(
                    placeholders,
                    PlaceholderKey::HostBinding {
                        host: host_fqn.to_string(),
                        binding: child_var.0.clone(),
                    },
                )
            } else {
                placeholder_target(
                    placeholders,
                    PlaceholderKey::Fallback {
                        host: host_fqn.to_string(),
                        edge_kind,
                        ordinal,
                    },
                )
            }
        }
        ProviderInvocation::ByName(_) | ProviderInvocation::Empty(_) => placeholder_target(
            placeholders,
            PlaceholderKey::Fallback {
                host: host_fqn.to_string(),
                edge_kind,
                ordinal,
            },
        ),
    }
}

fn target_for_provider_name(
    registry: &ProviderRegistry,
    current_ns: &Namespace,
    provider: &ProviderName,
    placeholders: &mut BTreeMap<PlaceholderKey, String>,
) -> RawTarget {
    match registry.lookup_with_key(current_ns, provider) {
        Some((key, RegistryEntry::Dsl(_))) => RawTarget::Concrete(provider_fqn(key)),
        Some((key, RegistryEntry::Programmatic(_))) => placeholder_target(
            placeholders,
            PlaceholderKey::Programmatic(provider_fqn(key)),
        ),
        None => {
            let fqn = inferred_provider_fqn(current_ns, provider);
            placeholder_target(placeholders, PlaceholderKey::Unresolved(fqn))
        }
    }
}

fn target_for_key(
    registry: &ProviderRegistry,
    key: &ProviderKey,
    placeholders: &mut BTreeMap<PlaceholderKey, String>,
) -> RawTarget {
    let provider_key = (
        Namespace(key.namespace.clone()),
        SimpleName(key.name.clone()),
    );
    let fqn = provider_fqn(&provider_key);
    let reference = ProviderName(fqn.clone());
    match registry.lookup_with_key(&Namespace(String::new()), &reference) {
        Some((_, RegistryEntry::Dsl(_))) => RawTarget::Concrete(fqn),
        Some((_, RegistryEntry::Programmatic(_))) => {
            placeholder_target(placeholders, PlaceholderKey::Programmatic(fqn))
        }
        None => placeholder_target(placeholders, PlaceholderKey::Unresolved(fqn)),
    }
}

fn placeholder_target(
    placeholders: &mut BTreeMap<PlaceholderKey, String>,
    key: PlaceholderKey,
) -> RawTarget {
    register_placeholder(placeholders, key.clone());
    RawTarget::Placeholder(key)
}

fn register_placeholder(placeholders: &mut BTreeMap<PlaceholderKey, String>, key: PlaceholderKey) {
    placeholders
        .entry(key.clone())
        .or_insert_with(|| placeholder_source(&key));
}

fn placeholder_source(key: &PlaceholderKey) -> String {
    match key {
        PlaceholderKey::Programmatic(fqn) => format!("程序化 provider: {fqn}"),
        PlaceholderKey::Unresolved(fqn) => format!("未解析 provider 引用: {fqn}"),
        PlaceholderKey::HostBinding { host, binding } => {
            format!("动态 provider 边: {host} (binding: {binding})")
        }
        PlaceholderKey::Fallback {
            host,
            edge_kind,
            ordinal,
        } => format!("无法具体化的 {edge_kind} 边: {host}#{ordinal}"),
    }
}

fn placeholder_type_name(key: &PlaceholderKey) -> String {
    match key {
        PlaceholderKey::Programmatic(fqn) | PlaceholderKey::Unresolved(fqn) => {
            format!("Opaque{}Node", pascal_case(fqn))
        }
        PlaceholderKey::HostBinding { host, binding } => {
            format!("{}{}Node", pascal_case(host), pascal_case(binding))
        }
        PlaceholderKey::Fallback {
            host,
            edge_kind,
            ordinal,
        } => format!("{}{}{}Node", pascal_case(host), edge_kind, ordinal),
    }
}

fn resolve_target(
    target: &RawTarget,
    concrete_names: &HashMap<String, String>,
    placeholder_names: &BTreeMap<PlaceholderKey, String>,
) -> EdgeTarget {
    match target {
        RawTarget::Concrete(fqn) => EdgeTarget {
            type_name: concrete_names[fqn].clone(),
            concrete: true,
        },
        RawTarget::Placeholder(key) => EdgeTarget {
            type_name: placeholder_names[key].clone(),
            concrete: false,
        },
    }
}

fn allocate_type_name(desired: &str, used: &mut BTreeSet<String>) -> String {
    if used.insert(desired.to_string()) {
        return desired.to_string();
    }
    let mut ordinal = 2;
    loop {
        let candidate = format!("{desired}${ordinal}");
        if used.insert(candidate.clone()) {
            return candidate;
        }
        ordinal += 1;
    }
}

pub(crate) fn pascal_case(value: &str) -> String {
    value
        .split(['.', '_', '-'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().chain(chars).collect::<String>(),
                None => String::new(),
            }
        })
        .collect()
}

fn provider_fqn(key: &(Namespace, SimpleName)) -> String {
    if key.0 .0.is_empty() {
        key.1 .0.clone()
    } else {
        format!("{}.{}", key.0 .0, key.1 .0)
    }
}

fn inferred_provider_fqn(current_ns: &Namespace, provider: &ProviderName) -> String {
    if provider.is_absolute() || current_ns.0.is_empty() {
        provider.0.clone()
    } else {
        format!("{}.{}", current_ns.0, provider.0)
    }
}
