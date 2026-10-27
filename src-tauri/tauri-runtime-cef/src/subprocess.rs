//! CEF renderer-process support shared by the browser runtime and helper binary.

use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
};

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

/// extra_info 是否带文件文档标记（见 `file_access::ALLOW_FILE_ACCESS_EXTRA_INFO_KEY`）。
fn allows_file_documents(extra_info: &DictionaryValue) -> bool {
    let key = CefString::from(crate::file_access::ALLOW_FILE_ACCESS_EXTRA_INFO_KEY);
    extra_info.has_key(Some(&key)) != 0
        && extra_info.get_type(Some(&key)) == ValueType::BOOL
        && extra_info.bool(Some(&key)) != 0
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
        // 建窗时带文件文档标记的 browser：它们的 `file:` 文档不注入任何初始化脚本。
        file_document_browsers: RefCell<HashSet<i32>>,
    }

    impl RenderProcessHandler {
        fn on_browser_created(
            &self,
            browser: Option<&mut Browser>,
            extra_info: Option<&mut DictionaryValue>,
        ) {
            let Some(browser) = browser else { return };
            if extra_info.as_deref().is_some_and(allows_file_documents) {
                self.file_document_browsers
                    .borrow_mut()
                    .insert(browser.identifier());
            }
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
                self.file_document_browsers
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
            let scripts = self.scripts_by_browser.borrow();
            let Some(scripts) = scripts.get(&browser.identifier()) else {
                return;
            };
            let is_main_frame = frame.is_main() == 1;
            let source_url = CefString::from(&frame.url()).to_string();
            // 开了文件访问的 browser 承载的是外部本地页面（WPE 网页壁纸）：`file:` 文档
            // 不注入任何初始化脚本，页面看不到 `__TAURI_INTERNALS__`。子 frame 若是
            // about:blank / srcdoc 这类继承父文档的页面，按主 frame 是否为 `file:` 判定。
            if self
                .file_document_browsers
                .borrow()
                .contains(&browser.identifier())
            {
                let main_is_file = || {
                    browser
                        .main_frame()
                        .map(|main| {
                            crate::file_access::is_file_url(&CefString::from(&main.url()).to_string())
                        })
                        .unwrap_or(false)
                };
                if crate::file_access::is_file_url(&source_url)
                    || (!is_main_frame && main_is_file())
                {
                    return;
                }
            }
            let source_url = CefString::from(source_url.as_str());
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
    InitializationRenderProcessHandler::new(
        RefCell::new(HashMap::new()),
        RefCell::new(HashSet::new()),
    )
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
