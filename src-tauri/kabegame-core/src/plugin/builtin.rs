use super::{Plugin, PluginBackend, PluginScript, pack_plugin_version};
use crate::local_folder::import::LOCAL_FOLDER_PLUGIN_ID;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

// 来源: src-tauri/kabegame/icons/128x128.png；更新应用图标时需同步复制。
const LOCAL_IMPORT_ICON_PNG: &[u8] = include_bytes!("local_import_icon.png");

/// 内建插件静态表。当前仅 local-import，且不进入已安装插件列表。
pub fn builtin_plugins() -> &'static HashMap<String, Arc<Plugin>> {
    static BUILTIN_PLUGINS: OnceLock<HashMap<String, Arc<Plugin>>> = OnceLock::new();
    BUILTIN_PLUGINS.get_or_init(|| {
        let version = "0.0.0".to_string();
        let plugin = Plugin {
            id: LOCAL_FOLDER_PLUGIN_ID.to_string(),
            name: json!({
                "default": "Local Import",
                "zh": "本地导入",
                "zhtw": "本機匯入",
                "ja": "ローカルインポート",
                "ko": "로컬 가져오기",
            }),
            description: json!({
                "default": "Import images and videos from local folders",
                "zh": "从本地文件夹导入图片和视频",
                "zhtw": "從本機資料夾匯入圖片與影片",
                "ja": "ローカルフォルダから画像と動画をインポート",
                "ko": "로컬 폴더에서 이미지와 동영상을 가져오기",
            }),
            version: version.clone(),
            base_url: String::new(),
            size_bytes: 0,
            config: HashMap::from([(
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
            script_type: "builtin".to_string(),
            min_app_version: None,
            labels: vec![],
            min_app_incompatible: false,
            file_path: None,
            doc: None,
            icon_png_base64: Some(BASE64_STANDARD.encode(LOCAL_IMPORT_ICON_PNG)),
            description_template: None,
            recommended_configs: Vec::new(),
            var_defs: Vec::new(),
            script: PluginScript::new(PluginBackend::Builtin, String::new()),
            doc_resources: None,
            providers: Vec::new(),
            metadata_migration: None,
            version_packed: pack_plugin_version(&version)
                .expect("内建插件版本号必须是有效的 a.b.c 格式"),
        };
        HashMap::from([(LOCAL_FOLDER_PLUGIN_ID.to_string(), Arc::new(plugin))])
    })
}
