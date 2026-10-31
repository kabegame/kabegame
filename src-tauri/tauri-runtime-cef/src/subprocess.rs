//! CEF renderer-process support shared by the browser runtime and helper binary.

use std::{cell::RefCell, collections::HashMap};

use cef::*;
use serde::{Deserialize, Serialize};

const INITIALIZATION_SCRIPTS_KEY: &str = "kabegame.init_scripts.v1";

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

pub(crate) fn initialization_scripts_extra_info(payload: &str) -> Result<DictionaryValue, String> {
    let dictionary = dictionary_value_create()
        .ok_or_else(|| "CEF failed to create initialization-script extra_info".to_string())?;
    let key = CefString::from(INITIALIZATION_SCRIPTS_KEY);
    let value = CefString::from(payload);
    if dictionary.set_string(Some(&key), Some(&value)) == 0 {
        return Err("CEF failed to write initialization-script extra_info".to_string());
    }
    Ok(dictionary)
}

fn initialization_scripts_from_extra_info(
    extra_info: Option<&mut DictionaryValue>,
) -> Result<Option<Vec<InitializationScript>>, String> {
    let Some(extra_info) = extra_info else {
        return Ok(None);
    };
    let key = CefString::from(INITIALIZATION_SCRIPTS_KEY);
    if extra_info.has_key(Some(&key)) == 0 {
        return Ok(None);
    }
    let payload = CefString::from(&extra_info.string(Some(&key))).to_string();
    decode_initialization_scripts(&payload).map(Some)
}

wrap_render_process_handler! {
    struct InitializationRenderProcessHandler {
        scripts_by_browser: RefCell<HashMap<i32, Vec<InitializationScript>>>,
    }

    impl RenderProcessHandler {
        fn on_browser_created(
            &self,
            browser: Option<&mut Browser>,
            extra_info: Option<&mut DictionaryValue>,
        ) {
            let Some(browser) = browser else { return };
            match initialization_scripts_from_extra_info(extra_info) {
                Ok(Some(scripts)) => {
                    self.scripts_by_browser
                        .borrow_mut()
                        .insert(browser.identifier(), scripts);
                }
                Ok(None) => {}
                Err(error) => eprintln!(
                    "[cef-runtime] browser={} {error}",
                    browser.identifier()
                ),
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
            // `file:` 文档（桌面 WPE 网页壁纸）也照常注入：Tauri 自身脚本只进主 frame，
            // IPC 权限由 ACL 按远程 `file:` 来源限定（浏览器进程按发起方 origin 把 `file:` 文档的
            // Origin 写成 `file:///`，见 `protocol::INITIATOR_ORIGIN_HEADER`）；all-frames 脚本自己按地址判断是否启用。
            let source_url = frame.url();
            let source_url = CefString::from(&source_url);
            for (index, script) in scripts.iter().enumerate() {
                if script.for_main_frame_only && !is_main_frame {
                    continue;
                }
                let mut retval = None;
                let mut exception = None;
                if context.eval(
                    Some(&CefString::from(script.script.as_str())),
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
                    eprintln!(
                        "[cef-runtime] browser={} initialization script #{index} failed: {message}",
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
}
