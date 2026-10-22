#![allow(dead_code)]

use serde::Serialize;

#[derive(Serialize, Clone, Copy)]
pub struct McpCapability {
    pub id: &'static str,
    pub category: &'static str,
    pub kind: McpCapabilityKind,
    pub tool: Option<&'static str>,
    pub name_key: &'static str,
    pub desc_key: &'static str,
}

#[derive(Serialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum McpCapabilityKind {
    Read,
    Write,
}

macro_rules! mcp_capabilities {
    (
        $(
            $category_name:ident($category:literal) {
                read {
                    $(
                        $read_const:ident => $read_local:literal
                    ),* $(,)?
                }
                $(
                    write {
                        $(
                            $write_const:ident => $write_local:literal => $tool:literal
                        ),* $(,)?
                    }
                )?
            }
        )*
    ) => {
        mod ids {
            $(
                $(
                    pub const $read_const: &str =
                        concat!($category, ".read.", $read_local);
                )*
                $($(
                    pub const $write_const: &str =
                        concat!($category, ".write.", $write_local);
                )*)?
            )*
        }

        const ALL_MCP_CAPABILITIES: &[McpCapability] = &[
            $(
                $(
                    McpCapability {
                        id: ids::$read_const,
                        category: $category,
                        kind: McpCapabilityKind::Read,
                        tool: None,
                        name_key: concat!("mcp.cap.", $category, ".read.", $read_local),
                        desc_key: concat!("mcp.cap.", $category, ".read.", $read_local, ".desc"),
                    },
                )*
                $($(
                    McpCapability {
                        id: ids::$write_const,
                        category: $category,
                        kind: McpCapabilityKind::Write,
                        tool: Some($tool),
                        name_key: concat!("mcp.cap.", $category, ".write.", $write_local),
                        desc_key: concat!("mcp.cap.", $category, ".write.", $write_local, ".desc"),
                    },
                )*)?
            )*
        ];

        pub fn all_mcp_capabilities() -> &'static [McpCapability] {
            ALL_MCP_CAPABILITIES
        }

        pub fn capability_for_tool(tool_name: &str) -> Option<&'static str> {
            match tool_name {
                $($($(
                    $tool => Some(ids::$write_const),
                )*)?)*
                _ => None,
            }
        }
    };
}

mcp_capabilities! {
    Images("images") {
        read {
            IMAGES_READ_GALLERY => "gallery",
            IMAGES_READ_RAW => "raw",
            IMAGES_READ_BY_ID => "by_id",
            IMAGES_READ_METADATA => "metadata",
        }
        write {
            IMAGES_WRITE_RENAME_IMAGE => "rename_image" => "rename_image",
        }
    }
    Albums("albums") {
        read {
            ALBUMS_READ_LIST => "list",
            ALBUMS_READ_BY_ID => "by_id",
        }
        write {
            ALBUMS_WRITE_CREATE_ALBUM => "create_album" => "create_album",
            ALBUMS_WRITE_ADD_IMAGES_TO_ALBUM => "add_images_to_album" => "add_images_to_album",
            ALBUMS_WRITE_SET_ALBUM_IMAGES_ORDER => "set_album_images_order" => "set_album_images_order",
        }
    }
    Tasks("tasks") {
        read {
            TASKS_READ_LIST => "list",
            TASKS_READ_BY_ID => "by_id",
        }
    }
    SurfRecords("surf_records") {
        read {
            SURF_RECORDS_READ_LIST => "list",
            SURF_RECORDS_READ_BY_ID => "by_id",
        }
    }
    Plugin("plugin") {
        read {
            PLUGIN_READ_LIST => "list",
            PLUGIN_READ_INFO => "info",
            PLUGIN_READ_ICON => "icon",
            PLUGIN_READ_DESCRIPTION_TEMPLATE => "description_template",
            PLUGIN_READ_DOC => "doc",
            PLUGIN_READ_CHANGELOG => "changelog",
            PLUGIN_READ_ASSET => "asset",
            PLUGIN_READ_PROVIDER => "provider",
            PLUGIN_READ_RECOMMENDED => "recommended",
        }
    }
}

pub fn read_capability_id(scheme: &str, segments: &[&str]) -> Option<&'static str> {
    match scheme {
        "images" => read_images_capability_id(segments),
        "albums" => {
            read_collection_capability_id(segments, ids::ALBUMS_READ_LIST, ids::ALBUMS_READ_BY_ID)
        }
        "tasks" => {
            read_collection_capability_id(segments, ids::TASKS_READ_LIST, ids::TASKS_READ_BY_ID)
        }
        "surf_records" => read_collection_capability_id(
            segments,
            ids::SURF_RECORDS_READ_LIST,
            ids::SURF_RECORDS_READ_BY_ID,
        ),
        "plugin" => read_plugin_capability_id(segments),
        _ => None,
    }
}

pub fn is_capability_enabled(id: &str, disabled: &[String]) -> bool {
    !disabled.iter().any(|d| d == id)
}

fn read_images_capability_id(segments: &[&str]) -> Option<&'static str> {
    match segments {
        ["gallery", ..] => Some(ids::IMAGES_READ_GALLERY),
        [raw, ..] if is_raw_images_segment(raw) => Some(ids::IMAGES_READ_RAW),
        [id] if id.starts_with("id_") => Some(ids::IMAGES_READ_BY_ID),
        [id, "metadata"] if id.starts_with("id_") => Some(ids::IMAGES_READ_METADATA),
        _ => None,
    }
}

fn read_collection_capability_id(
    segments: &[&str],
    list_id: &'static str,
    by_id_id: &'static str,
) -> Option<&'static str> {
    match segments {
        [] | ["all"] => Some(list_id),
        [id] if id.starts_with("id_") => Some(by_id_id),
        _ => None,
    }
}

/// 去掉来源坐标，供权限判定和资源内容解包共用；id 层也返回插件 lite 行。
pub fn plugin_resource_subpath<'a>(segments: &'a [&'a str]) -> Option<&'a [&'a str]> {
    let entry = match segments {
        ["installed", entry @ ..] => entry,
        ["byStore" | "byPreview", _source, entry @ ..] => entry,
        _ => return None,
    };
    match entry {
        [_id] => Some(&entry[1..]),
        [_id, _version, rest @ ..] => Some(rest),
        _ => None,
    }
}

fn read_plugin_capability_id(segments: &[&str]) -> Option<&'static str> {
    match segments {
        [] | ["installed" | "byStore" | "byPreview"] | ["byStore" | "byPreview", _] => {
            return Some(ids::PLUGIN_READ_LIST)
        }
        _ => {}
    }
    match plugin_resource_subpath(segments)? {
        [] => Some(ids::PLUGIN_READ_INFO),
        ["icon"] => Some(ids::PLUGIN_READ_ICON),
        ["description_template"] => Some(ids::PLUGIN_READ_DESCRIPTION_TEMPLATE),
        ["doc"] => Some(ids::PLUGIN_READ_DOC),
        ["changelog"] => Some(ids::PLUGIN_READ_CHANGELOG),
        ["asset", ..] => Some(ids::PLUGIN_READ_ASSET),
        ["provider", ..] => Some(ids::PLUGIN_READ_PROVIDER),
        ["recommended"] | ["recommended", _] => Some(ids::PLUGIN_READ_RECOMMENDED),
        _ => None,
    }
}

#[cfg(test)]
mod plugin_resource_tests {
    use super::*;

    #[test]
    fn plugin_resource_capabilities_follow_origin_coordinates() {
        for base in [
            vec!["installed"],
            vec!["byStore", "source"],
            vec!["byPreview", "token"],
        ] {
            let mut path = base;
            path.extend(["plugin-id", "1.2.3"]);
            assert_eq!(
                read_capability_id("plugin", &path),
                Some(ids::PLUGIN_READ_INFO)
            );
            for (resource, capability) in [
                ("icon", ids::PLUGIN_READ_ICON),
                ("doc", ids::PLUGIN_READ_DOC),
                ("changelog", ids::PLUGIN_READ_CHANGELOG),
                (
                    "description_template",
                    ids::PLUGIN_READ_DESCRIPTION_TEMPLATE,
                ),
                ("asset", ids::PLUGIN_READ_ASSET),
                ("provider", ids::PLUGIN_READ_PROVIDER),
                ("recommended", ids::PLUGIN_READ_RECOMMENDED),
            ] {
                path.push(resource);
                assert_eq!(read_capability_id("plugin", &path), Some(capability));
                if resource == "recommended" {
                    path.push("configs/default.json");
                    assert_eq!(
                        plugin_resource_subpath(&path),
                        Some(&path[path.len() - 2..])
                    );
                    assert_eq!(read_capability_id("plugin", &path), Some(capability));
                    path.pop();
                }
                path.pop();
            }
        }
        assert_eq!(
            read_capability_id("plugin", &[]),
            Some(ids::PLUGIN_READ_LIST)
        );
        assert_eq!(
            read_capability_id("plugin", &["installed"]),
            Some(ids::PLUGIN_READ_LIST)
        );
        assert_eq!(read_capability_id("plugin", &["old-id", "doc"]), None);
    }
}

fn is_raw_images_segment(segment: &str) -> bool {
    segment
        .strip_prefix('x')
        .and_then(|s| s.strip_suffix('x'))
        .is_some_and(|digits| !digits.is_empty() && digits.chars().all(|ch| ch.is_ascii_digit()))
}
