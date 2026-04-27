use crate::ast::{
    InvokeByDelegate, InvokeByName, ListEntry, ProviderInvocation, Resolve, TemplateValue,
};
use crate::template::{parse, Segment, VarRef};
use crate::validate::{ValidateError, ValidateErrorKind};

use regex::Regex;
use regex_automata::{
    dfa::{dense, Automaton},
    Anchored, Input,
};
use std::collections::{HashMap, HashSet, VecDeque};

const PRODUCT_DFA_STATE_LIMIT: usize = 100_000;

pub fn validate_resolve(
    registry: &crate::ProviderRegistry,
    errors: &mut Vec<ValidateError>,
) {
    for ((ns, name), def) in registry.iter() {
        let Some(resolve) = &def.resolve else {
            continue;
        };
        let fqn = super::fqn(ns, name);

        // 1) compile each key as anchored regex; track captures count for bounds checking
        let mut compiled: Vec<(String, Regex, usize)> = Vec::new();
        for (pat, _) in &resolve.0 {
            match Regex::new(&format!("^(?:{})$", pat)) {
                Ok(re) => {
                    // captures_len includes group 0 (whole-match)
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

        // 2) regex vs static list key literals
        if let Some(list) = &def.list {
            for (key, entry) in &list.entries {
                // skip dynamic keys (template-bearing) — they're not literals
                if is_template_key(key) {
                    continue;
                }
                // also skip dynamic ListEntry (its key may be runtime)
                if matches!(entry, ListEntry::Dynamic(_)) {
                    continue;
                }
                for (pat, re, _) in &compiled {
                    if re.is_match(key) {
                        errors.push(ValidateError::new(
                            &fqn,
                            format!("resolve[`{}`]", pat),
                            ValidateErrorKind::RegexMatchesStatic(pat.clone(), key.clone()),
                        ));
                    }
                }
            }
        }

        // 3) regex vs regex (pairwise intersection)
        for i in 0..compiled.len() {
            for j in (i + 1)..compiled.len() {
                let (pa, _, _) = &compiled[i];
                let (pb, _, _) = &compiled[j];
                if regexes_intersect(pa, pb).unwrap_or(false) {
                    errors.push(ValidateError::new(
                        &fqn,
                        format!("resolve"),
                        ValidateErrorKind::RegexIntersection(pa.clone(), pb.clone()),
                    ));
                }
            }
        }

        // 4) capture[N] bounds in invocation properties / meta
        // Build a map pattern -> groups for fast lookup
        let pattern_to_groups: HashMap<&str, usize> = compiled
            .iter()
            .map(|(p, _, g)| (p.as_str(), *g))
            .collect();
        for (pat, inv) in &resolve.0 {
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

        let _ = compiled; // silence unused
        let _ = pattern_to_groups;
        let _: &Resolve = resolve;
    }
}

fn is_template_key(s: &str) -> bool {
    s.contains("${")
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
        ProviderInvocation::ByDelegate(InvokeByDelegate {
            properties, meta, ..
        }) => {
            if let Some(p) = properties {
                push_props(p, &mut out);
            }
            if let Some(m) = meta {
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

/// 检测两个 regex 模式是否存在共同接受的字符串。
/// 通过两个 anchored DFA 的 product BFS 实现。
/// 状态数超过 PRODUCT_DFA_STATE_LIMIT 时保守返回 false（无重叠）。
pub(crate) fn regexes_intersect(a: &str, b: &str) -> Result<bool, regex_automata::dfa::dense::BuildError> {
    let pa = format!("^(?:{})$", a);
    let pb = format!("^(?:{})$", b);
    let dfa_a = dense::DFA::new(&pa)?;
    let dfa_b = dense::DFA::new(&pb)?;

    let input_a = Input::new("").anchored(Anchored::Yes);
    let input_b = Input::new("").anchored(Anchored::Yes);
    let start_a = match dfa_a.start_state_forward(&input_a) {
        Ok(s) => s,
        Err(_) => return Ok(false),
    };
    let start_b = match dfa_b.start_state_forward(&input_b) {
        Ok(s) => s,
        Err(_) => return Ok(false),
    };

    let mut visited: HashSet<(_, _)> = HashSet::new();
    let mut queue = VecDeque::new();
    visited.insert((start_a, start_b));
    queue.push_back((start_a, start_b));

    while let Some((sa, sb)) = queue.pop_front() {
        if visited.len() > PRODUCT_DFA_STATE_LIMIT {
            return Ok(false);
        }
        let eoi_a = dfa_a.next_eoi_state(sa);
        let eoi_b = dfa_b.next_eoi_state(sb);
        if dfa_a.is_match_state(eoi_a) && dfa_b.is_match_state(eoi_b) {
            return Ok(true);
        }
        for byte in 0u8..=255 {
            let na = dfa_a.next_state(sa, byte);
            let nb = dfa_b.next_state(sb, byte);
            if dfa_a.is_dead_state(na) || dfa_b.is_dead_state(nb) {
                continue;
            }
            if visited.insert((na, nb)) {
                queue.push_back((na, nb));
            }
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::{
        InvokeByName, List, ListEntry, Namespace, ProviderDef, ProviderName, Resolve, SimpleName,
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

    fn by_name_with_props(
        name: &str,
        props: HashMap<String, TemplateValue>,
    ) -> ProviderInvocation {
        ProviderInvocation::ByName(InvokeByName {
            provider: ProviderName(name.into()),
            properties: Some(props),
            meta: None,
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
    fn regex_matches_static() {
        let mut r = Resolve::default();
        r.0.insert("x([0-9]+)x".into(), by_name("p"));
        let list = List {
            entries: vec![("x100x".into(), ListEntry::Static(by_name("static_p")))],
        };
        let errs = run(r, Some(list));
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::RegexMatchesStatic(_, _))));
    }

    #[test]
    fn regex_not_matching_static_ok() {
        let mut r = Resolve::default();
        r.0.insert("x([0-9]+)x".into(), by_name("p"));
        let list = List {
            entries: vec![("desc".into(), ListEntry::Static(by_name("desc_p")))],
        };
        assert!(run(r, Some(list)).is_empty());
    }

    #[test]
    fn regex_pair_overlap_detected() {
        let mut r = Resolve::default();
        r.0.insert("a.*".into(), by_name("p1"));
        r.0.insert("ab.*".into(), by_name("p2"));
        let errs = run(r, None);
        assert!(errs
            .iter()
            .any(|e| matches!(e.kind, ValidateErrorKind::RegexIntersection(_, _))));
    }

    #[test]
    fn regex_pair_disjoint_ok() {
        let mut r = Resolve::default();
        r.0.insert("aaa".into(), by_name("p1"));
        r.0.insert("bbb".into(), by_name("p2"));
        assert!(run(r, None).is_empty());
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
        props.insert(
            "x".into(),
            TemplateValue::String("${capture[5]}".into()),
        );
        let mut r = Resolve::default();
        r.0.insert("^([a-z]+)$".into(), by_name_with_props("p", props));
        let errs = run(r, None);
        assert!(errs.iter().any(|e| matches!(
            e.kind,
            ValidateErrorKind::CaptureIndexOutOfBounds { idx: 5, groups: 1, .. }
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
    }

    #[test]
    fn intersect_helper_basic() {
        assert!(regexes_intersect("ab.*", "abc").unwrap());
        assert!(!regexes_intersect("aaa", "bbb").unwrap());
        assert!(regexes_intersect("x([0-9]+)x", "xxx").unwrap_or(false) == false);
    }
}
