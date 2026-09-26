use super::webpage::{self, WEBPAGE_PLUGIN_ID};
use super::{
    pack_plugin_version, var_definition_to_frontend_value, Plugin, PluginBackend, PluginScript,
};
use crate::local_folder::import::LOCAL_FOLDER_PLUGIN_ID;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

// 所有内建插件共用的图标。来源: src-tauri/kabegame/icons/128x128.png；更新应用图标时需同步复制。
const BUILTIN_PLUGIN_ICON_PNG: &[u8] = include_bytes!("builtin_icon.png");

/// 内建插件统一版本：需求版本 1.0，按 `pack_plugin_version` 的 a.b.c 契约写为 1.0.0。
const BUILTIN_PLUGIN_VERSION: &str = "1.0.0";

/// 内建插件静态表（local-import / webpage），不进入已安装插件列表。
pub fn builtin_plugins() -> &'static HashMap<String, Arc<Plugin>> {
    static BUILTIN_PLUGINS: OnceLock<HashMap<String, Arc<Plugin>>> = OnceLock::new();
    BUILTIN_PLUGINS.get_or_init(|| {
        let local_import = builtin_plugin(
            LOCAL_FOLDER_PLUGIN_ID,
            json!({
                "default": "Local Import",
                "zh": "本地导入",
                "zhtw": "本機匯入",
                "ja": "ローカルインポート",
                "ko": "로컬 가져오기",
            }),
            json!({
                "default": "Import images and videos from local folders",
                "zh": "从本地文件夹导入图片和视频",
                "zhtw": "從本機資料夾匯入圖片與影片",
                "ja": "ローカルフォルダから画像と動画をインポート",
                "ko": "로컬 폴더에서 이미지와 동영상을 가져오기",
            }),
            HashMap::from([(
                "vars".to_string(),
                json!([
                    {
                        "key": "paths",
                        "name": {
                            "default": "Path list",
                            "zh": "路径列表",
                            "zhtw": "路徑列表",
                            "ja": "パス一覧",
                            "ko": "경로 목록",
                        },
                    },
                    {
                        "key": "recursive",
                        "name": {
                            "default": "Recurse subfolders",
                            "zh": "递归子文件夹",
                            "zhtw": "遞迴子資料夾",
                            "ja": "サブフォルダを再帰",
                            "ko": "하위 폴더 재귀",
                        },
                    },
                ]),
            )]),
            Vec::new(),
            String::new(),
        );

        let webpage_var_defs = webpage::var_defs();
        let webpage_vars: Vec<Value> = webpage_var_defs
            .iter()
            .map(var_definition_to_frontend_value)
            .collect();
        let webpage = builtin_plugin(
            WEBPAGE_PLUGIN_ID,
            json!({
                "default": "Webpage",
                "zh": "网页收集",
                "zhtw": "網頁收集",
                "ja": "ウェブページ収集",
                "ko": "웹페이지 수집",
            }),
            json!({
                "default": "Collect images and videos from a single web page",
                "zh": "从单个网页收集图片和视频",
                "zhtw": "從單一網頁收集圖片與影片",
                "ja": "単一のウェブページから画像と動画を収集",
                "ko": "단일 웹페이지에서 이미지와 동영상을 수집",
            }),
            HashMap::from([("vars".to_string(), Value::Array(webpage_vars))]),
            webpage_var_defs,
            webpage::PAGE_DISCOVER_JS.to_string(),
        );

        HashMap::from([
            (LOCAL_FOLDER_PLUGIN_ID.to_string(), Arc::new(local_import)),
            (WEBPAGE_PLUGIN_ID.to_string(), Arc::new(webpage)),
        ])
    })
}

/// 内建插件的公共固定字段一律在此显式赋值，不从安装包、远端清单或运行配置推导。
fn builtin_plugin(
    id: &str,
    name: Value,
    description: Value,
    config: HashMap<String, Value>,
    var_defs: Vec<super::VarDefinition>,
    builtin_source: String,
) -> Plugin {
    Plugin {
        id: id.to_string(),
        name,
        description,
        version: BUILTIN_PLUGIN_VERSION.to_string(),
        base_url: String::new(),
        size_bytes: 0,
        config,
        script_type: "builtin".to_string(),
        min_app_version: None,
        labels: vec![],
        min_app_incompatible: false,
        file_path: None,
        doc: None,
        changelog: None,
        icon_png_base64: Some(BASE64_STANDARD.encode(BUILTIN_PLUGIN_ICON_PNG)),
        // webpage 的页面快照由详情面板按 metadata.kind 专门渲染，不走 EJS 模板
        description_template: None,
        recommended_configs: Vec::new(),
        var_defs,
        script: PluginScript::new(PluginBackend::Builtin, builtin_source),
        assets: None,
        providers: Vec::new(),
        metadata_migration: None,
        version_packed: pack_plugin_version(BUILTIN_PLUGIN_VERSION)
            .expect("内建插件版本号必须是有效的 a.b.c 格式"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_fixed_fields() {
        let table = builtin_plugins();
        let local = table.get(LOCAL_FOLDER_PLUGIN_ID).expect("local-import");
        let web = table.get(WEBPAGE_PLUGIN_ID).expect("webpage");
        for p in [local, web] {
            assert_eq!(p.version, "1.0.0");
            assert_eq!(p.version_packed, 0x0001_0000);
            assert_eq!(p.script_type, "builtin");
            assert!(p.script.is_builtin());
            assert!(p.recommended_configs.is_empty());
            assert!(p.description_template.is_none());
            assert_eq!(p.icon_png_base64, local.icon_png_base64);
        }
        assert_eq!(local.script.builtin_source(), Some(""));
        assert!(web
            .script
            .builtin_source()
            .is_some_and(|s| s.contains("function discoverMedia")));
        assert!(web.script.js_source().is_none());
    }

    #[test]
    fn webpage_vars_are_single_source() {
        let web = builtin_plugins().get(WEBPAGE_PLUGIN_ID).unwrap();
        let keys: Vec<&str> = web.var_defs.iter().map(|d| d.key.as_str()).collect();
        assert_eq!(
            keys,
            ["url", "backend", "injectSurfCookie", "injectCefUserAgent"]
        );
        let vars = web.config.get("vars").and_then(|v| v.as_array()).unwrap();
        assert_eq!(vars.len(), 4);
        assert_eq!(vars[1]["default"], "v8");
        assert_eq!(vars[1]["options"][0]["variable"], "v8");
        assert_eq!(vars[1]["options"][1]["variable"], "webview");
        assert_eq!(vars[0]["name"]["zh"], "完整 URL");
        assert_eq!(vars[2]["default"], true);
        assert_eq!(vars[3]["default"], true);
        assert_eq!(vars[2]["when"]["backend"][0], "v8");
    }
}
