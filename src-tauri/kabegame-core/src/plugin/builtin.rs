use super::webpage::{self, WEBPAGE_PLUGIN_ID};
use super::{
    pack_plugin_version, validate_var_defs, var_definition_to_frontend_value, Plugin,
    PluginBackend, PluginScript,
};
use crate::local_folder::import::LOCAL_FOLDER_PLUGIN_ID;
use crate::wpe::WPE_IMPORT_PLUGIN_ID;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

// 所有内建插件共用的图标。来源: src-tauri/kabegame/icons/128x128.png；更新应用图标时需同步复制。
const BUILTIN_PLUGIN_ICON_PNG: &[u8] = include_bytes!("builtin_icon.png");

/// 内建插件统一版本：需求版本 1.0，按 `pack_plugin_version` 的 a.b.c 契约写为 1.0.0。
const BUILTIN_PLUGIN_VERSION: &str = "1.0.0";

/// 内建插件静态表（local-import / webpage / wpe-import），不进入已安装插件列表。
pub fn builtin_plugins() -> &'static HashMap<String, Arc<Plugin>> {
    static BUILTIN_PLUGINS: OnceLock<HashMap<String, Arc<Plugin>>> = OnceLock::new();
    BUILTIN_PLUGINS.get_or_init(|| {
        let local_import_var_defs: Vec<super::VarDefinition> = serde_json::from_value(json!([
            {
                "key": "paths",
                "type": "list",
                "required": true,
                "name": "Path list",
                "name.zh": "路径列表",
                "name.zhtw": "路徑列表",
                "name.ja": "パス一覧",
                "name.ko": "경로 목록"
            },
            {
                "key": "recursive",
                "type": "boolean",
                "default": true,
                "name": "Recurse subfolders",
                "name.zh": "递归子文件夹",
                "name.zhtw": "遞迴子資料夾",
                "name.ja": "サブフォルダを再帰",
                "name.ko": "하위 폴더 재귀"
            }
        ]))
        .expect("local-import 内建插件变量定义必须合法");
        validate_var_defs(&local_import_var_defs).expect("local-import 内建插件变量定义校验失败");
        let local_import_vars = local_import_var_defs
            .iter()
            .map(var_definition_to_frontend_value)
            .collect();
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
            HashMap::from([("vars".to_string(), Value::Array(local_import_vars))]),
            local_import_var_defs,
            String::new(),
        );

        // 「壁纸」入口：自动发现 Steam 库里的 WPE 壁纸目录。第一阶段只导入 video 型；
        // `extraDirs` 由对话框「添加文件夹」识别后传入（未选时省略，缺失即空）。
        let wpe_import_var_defs: Vec<super::VarDefinition> = serde_json::from_value(json!([
            {
                "key": "sources",
                "type": "checkbox",
                "name": "Sources",
                "name.zh": "来源",
                "name.zhtw": "來源",
                "name.ja": "ソース",
                "name.ko": "소스",
                "default": ["workshop", "defaultprojects", "myprojects"],
                "options": [
                    {
                        "variable": "workshop",
                        "name": "Workshop subscriptions",
                        "name.zh": "创意工坊订阅",
                        "name.zhtw": "工作坊訂閱",
                        "name.ja": "ワークショップ購読",
                        "name.ko": "창작마당 구독"
                    },
                    {
                        "variable": "defaultprojects",
                        "name": "Wallpaper Engine defaults",
                        "name.zh": "官方默认壁纸",
                        "name.zhtw": "官方預設桌布",
                        "name.ja": "公式デフォルト",
                        "name.ko": "기본 월페이퍼"
                    },
                    {
                        "variable": "myprojects",
                        "name": "My projects",
                        "name.zh": "我的项目",
                        "name.zhtw": "我的專案",
                        "name.ja": "マイプロジェクト",
                        "name.ko": "내 프로젝트"
                    }
                ]
            },
            {
                "key": "extraDirs",
                "type": "list",
                "name": "Extra folders",
                "name.zh": "额外的文件夹",
                "name.zhtw": "額外的資料夾",
                "name.ja": "追加フォルダ",
                "name.ko": "추가 폴더"
            }
        ]))
        .expect("wpe-import 内建插件变量定义必须合法");
        validate_var_defs(&wpe_import_var_defs).expect("wpe-import 内建插件变量定义校验失败");
        let wpe_import_vars = wpe_import_var_defs
            .iter()
            .map(var_definition_to_frontend_value)
            .collect();
        let wpe_import = builtin_plugin(
            WPE_IMPORT_PLUGIN_ID,
            json!({
                "default": "Wallpaper Engine",
                "zh": "壁纸导入",
                "zhtw": "桌布匯入",
                "ja": "壁紙インポート",
                "ko": "월페이퍼 가져오기",
            }),
            json!({
                "default": "Import Wallpaper Engine wallpapers (video only in this phase)",
                "zh": "导入本机 Wallpaper Engine 壁纸（当前阶段仅视频）",
                "zhtw": "匯入本機 Wallpaper Engine 桌布（目前僅影片）",
                "ja": "ローカルの Wallpaper Engine 壁紙をインポート（現段階は動画のみ）",
                "ko": "로컬 Wallpaper Engine 월페이퍼 가져오기(현재 동영상만)",
            }),
            HashMap::from([("vars".to_string(), Value::Array(wpe_import_vars))]),
            wpe_import_var_defs,
            String::new(),
        );

        let webpage_var_defs = webpage::var_defs();        validate_var_defs(&webpage_var_defs).expect("webpage 内建插件变量定义校验失败");
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
            (WPE_IMPORT_PLUGIN_ID.to_string(), Arc::new(wpe_import)),
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

        icon_png_base64: Some(BASE64_STANDARD.encode(BUILTIN_PLUGIN_ICON_PNG)),
        // webpage 的页面快照由详情面板按 metadata.kind 专门渲染，不走 EJS 模板
        var_defs,
        script: PluginScript::new(PluginBackend::Builtin, builtin_source),

        providers: Vec::new(),
        metadata_migration_path: None,
        package_json: None,
        asset_keys: Vec::new(),
        file_origin: None,
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
            assert!(p.asset_keys.is_empty());
            assert!(p.package_json.is_none());
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

    #[test]
    fn builtin_var_defs_are_valid() {
        for plugin in builtin_plugins().values() {
            validate_var_defs(&plugin.var_defs).unwrap();
        }
        let local = builtin_plugins().get(LOCAL_FOLDER_PLUGIN_ID).unwrap();
        assert!(local.var_defs[0].required);
    }
}
