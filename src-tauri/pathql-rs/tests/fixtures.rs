use pathql_rs::ProviderDef;

fn parse(name: &str) -> ProviderDef {
    let path = format!("tests/fixtures/{}.json", name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("missing {}", path));
    serde_json::from_str::<ProviderDef>(&text)
        .unwrap_or_else(|e| panic!("parse {}: {}", path, e))
}

fn round_trip(name: &str) {
    let v = parse(name);
    let j = serde_json::to_string(&v).expect("serialize");
    let back: ProviderDef =
        serde_json::from_str(&j).unwrap_or_else(|e| panic!("re-parse {}: {}", name, e));
    assert_eq!(v, back, "round-trip mismatch for {}", name);
}

#[test]
fn root_provider_parses() {
    let d = parse("root_provider");
    assert_eq!(d.name.0, "root_provider");
    assert_eq!(d.namespace.as_ref().map(|n| n.0.as_str()), Some("kabegame"));
    let list = d.list.expect("list missing");
    assert_eq!(list.entries.len(), 2);
    assert_eq!(list.entries[0].0, "gallery");
    assert_eq!(list.entries[1].0, "vd");
}

#[test]
fn root_provider_round_trip() {
    round_trip("root_provider");
}

#[test]
fn gallery_route_parses() {
    let d = parse("gallery_route");
    assert_eq!(d.name.0, "gallery_route");
    assert!(matches!(d.query, Some(pathql_rs::Query::Contrib(_))));
    let list = d.list.expect("list missing");
    assert!(list.entries.len() >= 8);
}

#[test]
fn gallery_route_round_trip() {
    round_trip("gallery_route");
}

#[test]
fn gallery_all_router_parses() {
    let d = parse("gallery_all_router");
    assert!(matches!(d.query, Some(pathql_rs::Query::Delegate(_))));
    assert!(d.resolve.is_some());
    assert!(d.note.is_some());
}

#[test]
fn gallery_all_router_round_trip() {
    round_trip("gallery_all_router");
}

#[test]
fn gallery_paginate_router_parses() {
    let d = parse("gallery_paginate_router");
    assert_eq!(d.name.0, "gallery_paginate_router");
    let props = d.properties.expect("properties");
    assert!(props.contains_key("page_size"));
    let list = d.list.expect("list");
    assert_eq!(list.entries.len(), 1);
    let key = &list.entries[0].0;
    assert_eq!(key, "${out.meta.page_num}");
    match &list.entries[0].1 {
        pathql_rs::ListEntry::Dynamic(pathql_rs::DynamicListEntry::Delegate(_)) => {}
        _ => panic!("expected dynamic delegate entry"),
    }
}

#[test]
fn gallery_paginate_router_round_trip() {
    round_trip("gallery_paginate_router");
}

#[test]
fn gallery_page_router_parses() {
    let d = parse("gallery_page_router");
    assert_eq!(d.name.0, "gallery_page_router");
    let props = d.properties.expect("properties");
    assert!(props.contains_key("page_size"));
    assert!(props.contains_key("page_num"));
    assert!(matches!(d.query, Some(pathql_rs::Query::Delegate(_))));
}

#[test]
fn gallery_page_router_round_trip() {
    round_trip("gallery_page_router");
}

#[test]
fn page_size_provider_parses() {
    let d = parse("page_size_provider");
    assert_eq!(d.name.0, "page_size_provider");
    let list = d.list.expect("list");
    assert_eq!(list.entries.len(), 1);
    match &list.entries[0].1 {
        pathql_rs::ListEntry::Dynamic(pathql_rs::DynamicListEntry::Sql(e)) => {
            assert_eq!(e.data_var.0, "out");
            assert!(e.provider.is_none());
        }
        _ => panic!("expected dynamic sql entry"),
    }
}

#[test]
fn page_size_provider_round_trip() {
    round_trip("page_size_provider");
}

#[test]
fn query_page_provider_parses() {
    let d = parse("query_page_provider");
    assert_eq!(d.name.0, "query_page_provider");
    let q = d.query.expect("query");
    match q {
        pathql_rs::Query::Contrib(c) => {
            assert!(c.offset.is_some());
            assert!(c.limit.is_some());
        }
        _ => panic!("expected Contrib"),
    }
}

#[test]
fn query_page_provider_round_trip() {
    round_trip("query_page_provider");
}

#[test]
fn vd_root_router_parses() {
    let d = parse("vd_root_router");
    let list = d.list.expect("list");
    assert_eq!(list.entries.len(), 2);
    assert_eq!(list.entries[0].0, "i18n-zh_CN");
}

#[test]
fn vd_root_router_round_trip() {
    round_trip("vd_root_router");
}

#[test]
fn vd_zh_cn_root_router_parses() {
    let d = parse("vd_zh_CN_root_router");
    let list = d.list.expect("list");
    assert_eq!(list.entries.len(), 7);
    assert_eq!(list.entries[0].0, "按画册");
}

#[test]
fn vd_zh_cn_root_router_round_trip() {
    round_trip("vd_zh_CN_root_router");
}
