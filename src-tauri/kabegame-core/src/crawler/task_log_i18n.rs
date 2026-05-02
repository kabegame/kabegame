//! 非插件任务日志：内容存为 JSON，供前端按 `tasks.*` 键翻译。
//! 格式：`{"_i18n":{"k":"taskLogXxx","p":{...}}}`

use serde_json::{json, Value};

/// 构建写入 `task_logs.content` 的 i18n 载荷字符串。
pub fn task_log_i18n(key: &str, params: Value) -> String {
    json!({ "_i18n": { "k": key, "p": params } }).to_string()
}
