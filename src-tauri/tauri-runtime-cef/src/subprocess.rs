//! CEF renderer-process support shared by the browser runtime and helper binary.

use std::{cell::RefCell, collections::HashMap};

use cef::*;
use serde::{Deserialize, Serialize};

const INITIALIZATION_SCRIPTS_KEY: &str = "kabegame.init_scripts.v1";
/// Tauri 的 IPC 桥脚本(`WebviewAttributes::subframe_bridge_scripts`,JSON 字符串数组):无条件注入
/// 每个子 frame,先于其它初始化脚本。
const SUBFRAME_BRIDGE_SCRIPTS_KEY: &str = "kabegame.subframe_bridge_scripts.v1";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InitializationScript {
    pub(crate) script: String,
    pub(crate) for_main_frame_only: bool,
}

pub(crate) fn encode_initialization_scripts(
    scripts: &[InitializationScript],
) -> Result<String, serde_json::Error> {
    serde_json::to_string(scripts)
}

fn decode_initialization_scripts(payload: &str) -> Result<Vec<InitializationScript>, String> {
    serde_json::from_str(payload)
        .map_err(|error| format!("invalid CEF initialization-script payload: {error}"))
}

pub(crate) fn encode_subframe_bridge_scripts(
    scripts: &[String],
) -> Result<String, serde_json::Error> {
    serde_json::to_string(scripts)
}

fn decode_subframe_bridge_scripts(payload: &str) -> Result<Vec<String>, String> {
    serde_json::from_str(payload)
        .map_err(|error| format!("invalid CEF subframe-bridge payload: {error}"))
}

/// 建 browser 时的 `extra_info`:初始化脚本与子 frame 桥脚本各占一个键(都是 JSON 字符串)。
pub(crate) fn initialization_scripts_extra_info(
    payload: &str,
    subframe_bridge_payload: &str,
) -> Result<DictionaryValue, String> {
    let dictionary = dictionary_value_create()
        .ok_or_else(|| "CEF failed to create initialization-script extra_info".to_string())?;
    for (key, value) in [
        (INITIALIZATION_SCRIPTS_KEY, payload),
        (SUBFRAME_BRIDGE_SCRIPTS_KEY, subframe_bridge_payload),
    ] {
        if dictionary.set_string(Some(&CefString::from(key)), Some(&CefString::from(value))) == 0 {
            return Err(format!("CEF failed to write extra_info key '{key}'"));
        }
    }
    Ok(dictionary)
}

/// 一个 browser 在渲染进程里要注入的脚本。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct BrowserScripts {
    initialization: Vec<InitializationScript>,
    subframe_bridge: Vec<String>,
}

fn browser_scripts_from_extra_info(
    extra_info: Option<&mut DictionaryValue>,
) -> Result<Option<BrowserScripts>, String> {
    let Some(extra_info) = extra_info else {
        return Ok(None);
    };
    let read = |key: &str| {
        let key = CefString::from(key);
        (extra_info.has_key(Some(&key)) != 0)
            .then(|| CefString::from(&extra_info.string(Some(&key))).to_string())
    };
    let initialization = read(INITIALIZATION_SCRIPTS_KEY);
    let subframe_bridge = read(SUBFRAME_BRIDGE_SCRIPTS_KEY);
    if initialization.is_none() && subframe_bridge.is_none() {
        return Ok(None);
    }
    Ok(Some(BrowserScripts {
        initialization: initialization
            .as_deref()
            .map(decode_initialization_scripts)
            .transpose()?
            .unwrap_or_default(),
        subframe_bridge: subframe_bridge
            .as_deref()
            .map(decode_subframe_bridge_scripts)
            .transpose()?
            .unwrap_or_default(),
    }))
}

/// 一个 frame 要按顺序执行的脚本:子 frame 先无条件执行桥脚本(能调什么由 ACL 决定),再执行
/// 不限主 frame 的初始化脚本;主 frame 执行全部初始化脚本(Tauri 的桥已在其中)。
fn scripts_for_frame(scripts: &BrowserScripts, is_main_frame: bool) -> Vec<&str> {
    let bridge = (!is_main_frame)
        .then_some(scripts.subframe_bridge.iter())
        .into_iter()
        .flatten()
        .map(String::as_str);
    let initialization = scripts
        .initialization
        .iter()
        .filter(|script| is_main_frame || !script.for_main_frame_only)
        .map(|script| script.script.as_str());
    bridge.chain(initialization).collect()
}

wrap_render_process_handler! {
    struct InitializationRenderProcessHandler {
        scripts_by_browser: RefCell<HashMap<i32, BrowserScripts>>,
    }

    impl RenderProcessHandler {
        fn on_browser_created(
            &self,
            browser: Option<&mut Browser>,
            extra_info: Option<&mut DictionaryValue>,
        ) {
            let Some(browser) = browser else { return };
            match browser_scripts_from_extra_info(extra_info) {
                Ok(Some(scripts)) => {
                    self.scripts_by_browser
                        .borrow_mut()
                        .insert(browser.identifier(), scripts);
                }
                Ok(None) => {}
                Err(error) => tracing::warn!("browser={} {error}", browser.identifier()),
            }
        }

        fn on_browser_destroyed(&self, browser: Option<&mut Browser>) {
            if let Some(browser) = browser {
                self.scripts_by_browser
                    .borrow_mut()
                    .remove(&browser.identifier());
            }
        }

        fn on_context_created(
            &self,
            browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            context: Option<&mut V8Context>,
        ) {
            let (Some(browser), Some(frame), Some(context)) = (browser, frame, context) else {
                return;
            };
            // CEF 对每个 V8 世界都回调本函数（`DidCreateScriptContext` 不看 world_id）：主世界之外，
            // DevTools（如「DevTools Performance Metrics」）、CDP `Page.createIsolatedWorld` 等建的
            // 隔离世界也会进来。隔离世界与页面共享 DOM，再注入一遍会让事件监听、畅游右键菜单、
            // IPC 上报都多出一份，所以只注入 frame 的主世界。放在借用脚本表之前：取主世界上下文
            // 可能触发主世界初始化，进而嵌套回调本函数。
            let Some(mut main_world) = frame.v8_context() else {
                return;
            };
            if context.is_same(Some(&mut main_world)) != 1 {
                return;
            }
            let scripts = self.scripts_by_browser.borrow();
            let Some(scripts) = scripts.get(&browser.identifier()) else {
                return;
            };
            let is_main_frame = frame.is_main() == 1;
            // 每个子 frame 都先注入 Tauri 的 IPC 桥(无条件,不看地址):子 frame 的请求记为 `Sub`、带
            // `SubframeId`,能调什么完全由 ACL 决定。`file:` 文档(WPE 网页壁纸)也照常注入,IPC 来源由
            // ACL 按远程 `file:` 限定(运行时把 `file:` frame 的 Origin 改写成 frame URL,见
            // `protocol::pin_file_frame_origin`);all-frames 脚本自己按地址判断是否启用。
            let source_url = frame.url();
            let source_url = CefString::from(&source_url);
            for (index, script) in scripts_for_frame(scripts, is_main_frame).into_iter().enumerate() {
                let mut retval = None;
                let mut exception = None;
                if context.eval(
                    Some(&CefString::from(script)),
                    Some(&source_url),
                    0,
                    Some(&mut retval),
                    Some(&mut exception),
                ) == 0
                {
                    let message = exception
                        .as_ref()
                        .map(|exception| CefString::from(&exception.message()).to_string())
                        .unwrap_or_else(|| "unknown V8 exception".to_string());
                    tracing::warn!(
                        "browser={} script #{index} (main frame: {is_main_frame}) failed: {message}",
                        browser.identifier()
                    );
                }
            }
        }
    }
}

pub(crate) fn initialization_render_process_handler() -> RenderProcessHandler {
    InitializationRenderProcessHandler::new(RefCell::new(HashMap::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialization_script_payload_round_trips() {
        let scripts = vec![
            InitializationScript {
                script: "window.first = '墙纸';\n".to_string(),
                for_main_frame_only: true,
            },
            InitializationScript {
                script: "window.second = 2;".to_string(),
                for_main_frame_only: false,
            },
        ];

        let payload = encode_initialization_scripts(&scripts).unwrap();
        assert_eq!(decode_initialization_scripts(&payload).unwrap(), scripts);
    }

    #[test]
    fn initialization_script_payload_accepts_empty_list() {
        let payload = encode_initialization_scripts(&[]).unwrap();
        assert!(decode_initialization_scripts(&payload).unwrap().is_empty());
    }

    #[test]
    fn initialization_script_payload_rejects_invalid_json() {
        assert!(decode_initialization_scripts("not-json").is_err());
    }

    #[test]
    fn subframe_bridge_payload_round_trips() {
        let scripts = vec!["window.isTauri = 1;".to_string(), "壁纸".to_string()];
        let payload = encode_subframe_bridge_scripts(&scripts).unwrap();
        assert_eq!(decode_subframe_bridge_scripts(&payload).unwrap(), scripts);
        assert!(decode_subframe_bridge_scripts("not-json").is_err());
    }

    /// 子 frame:桥脚本无条件在前,随后只跑不限主 frame 的初始化脚本;主 frame:只跑初始化脚本。
    #[test]
    fn subframes_get_the_bridge_first_and_unconditionally() {
        let scripts = BrowserScripts {
            initialization: vec![
                InitializationScript {
                    script: "main-bridge".to_string(),
                    for_main_frame_only: true,
                },
                InitializationScript {
                    script: "all-frames".to_string(),
                    for_main_frame_only: false,
                },
            ],
            subframe_bridge: vec!["bridge-1".to_string(), "bridge-2".to_string()],
        };
        assert_eq!(
            scripts_for_frame(&scripts, false),
            vec!["bridge-1", "bridge-2", "all-frames"]
        );
        assert_eq!(
            scripts_for_frame(&scripts, true),
            vec!["main-bridge", "all-frames"]
        );
        // 没有桥脚本的 browser(弹窗以外的旧数据):子 frame 只跑 all-frames 脚本
        let no_bridge = BrowserScripts {
            subframe_bridge: Vec::new(),
            ..scripts
        };
        assert_eq!(scripts_for_frame(&no_bridge, false), vec!["all-frames"]);
    }
}
