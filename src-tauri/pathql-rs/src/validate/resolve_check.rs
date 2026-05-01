use crate::ast::{
    DelegateProviderField, InvokeByName, ListEntry, ProviderInvocation, Resolve, TemplateValue,
};
use crate::template::{parse, Segment, VarRef};
use crate::validate::{ValidateError, ValidateErrorKind};

use regex::Regex;
use std::collections::HashMap;

/// 校验 resolve 表项: 仅留下两类检查 (7b 起)。
///
/// **删除的检查**:
/// - regex vs static list key literal 碰撞 (false positive: `.*` 转发模式 + `${properties.X}`
///   instance-static key 都是合法但被误判)
/// - regex vs regex 交集 (regex_automata 误判 + 与 `.*` 转发模式根本冲突)
///
/// 运行期解析顺序是 deterministic 的 (静态 list → resolve regex → 动态反查); 多模式重叠
/// 由作者按 schema 出现顺序覆写决定。
///
/// **保留的检查**:
/// 1. regex 编译错误
/// 2. invocation properties / meta 中 `${capture[N]}` 越界 (按当前 regex captures 数算)
pub fn validate_resolve(registry: &crate::ProviderRegistry, errors: &mut Vec<ValidateError>) {
    for ((ns, name), def) in registry.iter_dsl() {
        let Some(resolve) = &def.resolve else {
            continue;
        };
        let fqn = super::fqn(ns, name);

        // 1) compile each key as anchored regex; track captures count for bounds checking
        let mut compiled: Vec<(String, Regex, usize)> = Vec::new();
        for (pat, _) in &resolve.0 {
            // pattern 可能含 ${properties.X} (instance-static); 加载期跳过编译, 仅检查
            // pattern 不为空 — 实例化期再编译
            if pat.contains("${") {
                continue;
            }
            match Regex::new(&format!("^(?:{})$", pat)) {
                Ok(re) => {
                    let groups = re.captures_len().saturating_sub(1);
                    compiled.push((pat.clone(), re, groups));
                }
                Err(e) => errors.push(ValidateError::new(
                    &fqn,
                    format!("resolve[`{}`]", pat),
                    ValidateErrorKind::RegexCompileError {
                        pattern: pat.clone(),
                        msg: e.to_string(),
                    },
                )),
            }
        }

        // 2) capture[N] bounds in invocation properties / meta
        let pattern_to_groups: HashMap<&str, usize> =
            compiled.iter().map(|(p, _, g)| (p.as_str(), *g)).collect();
        for (pat, inv) in &resolve.0 {
            if let ProviderInvocation::ByDelegate(b) = inv {
                if !matches!(b.provider, Some(DelegateProviderField::Name(_)))
                    && b.properties.is_some()
                {
                    errors.push(ValidateError::new(
                        &fqn,
                        format!("resolve[`{}`].properties", pat),
                        ValidateErrorKind::PropertiesRequireExplicitProvider,
                    ));
                }
            }

            let Some(&groups) = pattern_to_groups.get(pat.as_str()) else {
                continue;
            };
            let templates = collect_invocation_strings(inv);
            for (field, text) in templates {
                let Ok(ast) = parse(&text) else {
                    continue;
                };
                for seg in ast.segments {
                    if let Segment::Var(VarRef::Index { ns, index }) = seg {
                        if ns == "capture" && index > groups {
                            errors.push(ValidateError::new(
                                &fqn,
                                format!("resolve[`{}`].{}", pat, field),
                                ValidateErrorKind::CaptureIndexOutOfBounds {
                                    pattern: pat.clone(),
                                    idx: index,
                                    groups,
                                },
                            ));
                        }
                    }
                }
            }
        }

        let _ = compiled;
        let _ = pattern_to_groups;
        let _: &Resolve = resolve;
        let _ = ListEntry::Static; // keep import live (used in tests)
    }
}

fn collect_invocation_strings(inv: &ProviderInvocation) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let push_props = |props: &HashMap<String, TemplateValue>, out: &mut Vec<(String, String)>| {
        for (k, v) in props {
            if let TemplateValue::String(s) = v {
                out.push((format!("properties.{}", k), s.clone()));
            }
        }
    };
    let push_meta = |meta: &serde_json::Value, out: &mut Vec<(String, String)>| {
        walk_meta_strings(meta, "meta", out);
    };
    match inv {
        ProviderInvocation::ByName(InvokeByName {
            properties, meta, ..
        }) => {
            if let Some(p) = properties {
                push_props(p, &mut out);
            }
            if let Some(m) = meta {
                push_meta(m, &mut out);
            }
        }
        ProviderInvocation::ByDelegate(b) => {
            // 7b: ByDelegate.delegate.properties 也可能含 ${capture[N]} — 收集
            if let Some(p) = &b.delegate.properties {
                push_props(p, &mut out);
            }
            if let Some(p) = &b.properties {
                push_props(p, &mut out);
            }
            if let Some(m) = &b.meta {
                push_meta(m, &mut out);
            }
        }
        ProviderInvocation::Empty(e) => {
            if let Some(m) = &e.meta {
                push_meta(m, &mut out);
            }
        }
    }
    out
}

fn walk_meta_strings(v: &serde_json::Value, path: &str, out: &mut Vec<(String, String)>) {
    match v {
        serde_json::Value::String(s) => out.push((path.to_string(), s.clone())),
        serde_json::Value::Object(map) => {
            for (k, child) in map {
                walk_meta_strings(child, &format!("{}.{}", path, k), out);
            }
        }
        serde_json::Value::Array(arr) => {
            for (i, child) in arr.iter().enumerate() {
                walk_meta_strings(child, &format!("{}[{}]", path, i), out);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{
        Identifier, InvokeByDelegate, InvokeByName, List, ListEntry, Namespace, ProviderCall,
        ProviderDef, ProviderName, Resolve, SimpleName,
    };
    use crate::ProviderRegistry;
    use std::collections::HashMap;

    fn def(resolve: Resolve, list: Option<List>) -> ProviderDef {
        ProviderDef {
            schema: None,
            namespace: None,
            name: SimpleName("p".into()),
            properties: None,
            query: None,
            list,
            resolve: Some(resolve),
            note: None,
        }
    }

    fn run(resolve: Resolve, list: Option<List>) -> Vec<ValidateError> {
        let mut reg = ProviderRegistry::new();
        reg.register(def(resolve, list)).unwrap();
        let mut errs = Vec::new();
        validate_resolve(&reg, &mut errs);
        errs
    }

    fn by_name(name: &str) -> ProviderInvocation {
        ProviderInvocation::ByName(InvokeByName {
            provider: ProviderName(name.into()),
            properties: None,
            meta: None,
        })
    }

    fn by_name_with_props(name: &str, props: HashMap<String, TemplateValue>) -> ProviderInvocation {
        ProviderInvocation::ByName(InvokeByName {
            provider: ProviderName(name.into()),
            properties: Some(props),
            meta: None,
        })
    }

    fn by_delegate_child_ref_with_props() -> ProviderInvocation {
        let mut props = HashMap::new();
        props.insert(
            "ignored".into(),
            TemplateValue::String("${out.name}".into()),
        );
        ProviderInvocation::ByDelegate(InvokeByDelegate {
            delegate: ProviderCall {
                provider: ProviderName("target".into()),
                properties: None,
            },
            child_var: Some(Identifier("out".into())),
            provider: Some(DelegateProviderField::ChildRef("${out.provider}".into())),
            properties: Some(props),
            meta: Some(serde_json::json!("${out.meta}")),
        })
    }

    #[test]
    fn valid_resolve_pattern() {
        let mut r = Resolve::default();
        r.0.insert("^x([0-9]+)$".into(), by_name("foo"));
        assert!(run(r, None).is_empty());
    }

    #[test]
    fn invalid_regex_compile() {
        let mut r = Resolve::default();
        r.0.insert("[unclosed".into(), by_name("foo"));
        let errs = run(r, None);
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::RegexCompileError { .. })));
    }

    #[test]
    fn delegate_child_ref_rejects_properties() {
        let mut r = Resolve::default();
        r.0.insert(".*".into(), by_delegate_child_ref_with_props());
        let errs = run(r, None);
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::PropertiesRequireExplicitProvider)));
    }

    /// 7b: 不再检测 regex 与静态 list key 字面碰撞 — 运行期顺序 (list → regex) 决定。
    #[test]
    fn regex_overlapping_static_no_longer_errors() {
        let mut r = Resolve::default();
        r.0.insert("x([0-9]+)x".into(), by_name("p"));
        let list = List {
            entries: vec![("x100x".into(), ListEntry::Static(by_name("static_p")))],
        };
        // 7b: 不再报错; runtime 解析顺序保证作者意图
        assert!(run(r, Some(list)).is_empty());
    }

    /// 7b: 不再检测 regex vs regex 交集 — 实测 NFA 误判 + `.*` 转发场景合法重叠。
    #[test]
    fn regex_overlapping_pair_no_longer_errors() {
        let mut r = Resolve::default();
        r.0.insert("a.*".into(), by_name("p1"));
        r.0.insert("ab.*".into(), by_name("p2"));
        // 7b: 不再报错
        assert!(run(r, None).is_empty());
    }

    /// 7b: `.*` 转发模式 + 静态 list key 共存合法 (gallery_hide_router 模式)。
    #[test]
    fn wildcard_forward_with_static_list_ok() {
        let mut r = Resolve::default();
        r.0.insert(".*".into(), by_name("forward_target"));
        let list = List {
            entries: vec![("desc".into(), ListEntry::Static(by_name("desc_p")))],
        };
        assert!(run(r, Some(list)).is_empty());
    }

    #[test]
    fn capture_in_bounds() {
        let mut props = HashMap::new();
        props.insert(
            "page_size".into(),
            TemplateValue::String("${capture[1]}".into()),
        );
        let mut r = Resolve::default();
        r.0.insert(
            "x([1-9][0-9]*)x".into(),
            by_name_with_props("paginate", props),
        );
        assert!(run(r, None).is_empty());
    }

    #[test]
    fn capture_out_of_bounds() {
        let mut props = HashMap::new();
        props.insert("x".into(), TemplateValue::String("${capture[5]}".into()));
        let mut r = Resolve::default();
        r.0.insert("^([a-z]+)$".into(), by_name_with_props("p", props));
        let errs = run(r, None);
        assert!(errs.iter().any(|e| matches!(
            e.kind,
            ValidateErrorKind::CaptureIndexOutOfBounds {
                idx: 5,
                groups: 1,
                ..
            }
        )));
    }

    #[test]
    fn no_resolve_skipped() {
        let mut reg = ProviderRegistry::new();
        reg.register(ProviderDef {
            schema: None,
            namespace: None,
            name: SimpleName("p".into()),
            properties: None,
            query: None,
            list: None,
            resolve: None,
            note: None,
        })
        .unwrap();
        let mut errs = Vec::new();
        validate_resolve(&reg, &mut errs);
        assert!(errs.is_empty());
        let _ = Namespace(String::new()); // keep import
    }

    /// 7b: pattern 含 `${properties.X}` 模板 → 加载期跳过编译 (实例化期再编译)
    #[test]
    fn instance_static_pattern_skipped_at_load() {
        let mut r = Resolve::default();
        r.0.insert("${properties.prefix}_[a-z]+".into(), by_name("p"));
        // 不应报 RegexCompileError (因为根本没尝试编译)
        let errs = run(r, None);
        assert!(errs
            .iter()
            .all(|e| !matches!(e.kind, ValidateErrorKind::RegexCompileError { .. })));
    }
}
