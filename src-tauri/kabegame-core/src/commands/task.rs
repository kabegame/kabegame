use crate::emitter::GlobalEmitter;
use crate::plugin::{PluginManager, VarDefinition, VarOption};
use crate::scheduler::Scheduler;
use crate::storage::{RunConfig, Storage, TaskInfo, TaskStatus};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRunParams {
    pub plugin: String,
    pub id_override: Option<String>,
    pub args: Vec<String>,
    pub output_dir: Option<String>,
    pub output_album_id: Option<String>,
    pub http_headers: Option<HashMap<String, String>>,
    pub dry_run: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRunOutput {
    pub plugin_id: String,
    pub plugin_version: String,
    pub script_type: String,
    pub plugin_file_path: Option<String>,
    pub config: BTreeMap<String, Value>,
    pub task_id: Option<String>,
}

/// PluginRun 协议操作的唯一实现：主程序 IPC handler 与 CLI 本地模式共用。
/// `webview_available` 表示当前进程是否能执行 WebView 后端插件。
pub async fn run_plugin(
    p: PluginRunParams,
    webview_available: bool,
) -> Result<PluginRunOutput, String> {
    let pm = PluginManager::global();
    if let Err(error) = pm.ensure_installed_cache_initialized().await {
        eprintln!("[plugin-run] 插件目录扫描未全部成功: {error}");
    }

    let path = std::path::Path::new(&p.plugin);
    let is_path = path.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("kgpg");
    if !is_path && p.id_override.is_some() {
        return Err("--id 仅可用于 .kgpg 路径模式".to_string());
    }

    let (plugin, plugin_file_path, var_defs) = if is_path {
        pm.resolve_plugin_for_cli_run(&p.plugin, p.id_override.as_deref())
            .await?
    } else {
        let plugin = pm.get(&p.plugin).ok_or_else(|| {
            let mut ids = pm
                .get_all()
                .unwrap_or_default()
                .into_iter()
                .map(|plugin| plugin.id.clone())
                .chain(
                    pm.builtin_plugins()
                        .into_iter()
                        .map(|plugin| plugin.id.clone()),
                )
                .collect::<Vec<_>>();
            ids.sort();
            ids.dedup();
            format!(
                "找不到插件 `{}`。已安装的插件：{}",
                p.plugin,
                if ids.is_empty() {
                    "（无）".to_string()
                } else {
                    ids.join(", ")
                }
            )
        })?;
        let var_defs = plugin.var_defs.clone();
        ((*plugin).clone(), None, var_defs)
    };

    if !webview_available && plugin.script_type != "v8" {
        return Err(format!(
            "插件 {} 的后端是 `{}`，本地 CLI `plugin run` 只支持 v8 后端。",
            plugin.id, plugin.script_type
        ));
    }
    if let Some(min_version) = plugin.min_app_version.as_deref() {
        crate::plugin::check_min_app_version(env!("CARGO_PKG_VERSION"), min_version)?;
    }

    let saved = pm
        .read_plugin_default_config_file(&plugin.id)
        .ok()
        .flatten()
        .unwrap_or(Value::Null);
    let mut user_config: HashMap<String, Value> = saved
        .get("userConfig")
        .and_then(Value::as_object)
        .map(|values| values.clone().into_iter().collect())
        .unwrap_or_default();
    let mut http_headers: HashMap<String, String> = saved
        .get("httpHeaders")
        .and_then(Value::as_object)
        .map(|values| {
            values
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();
    if let Some(overrides) = p.http_headers.as_ref() {
        http_headers.extend(overrides.clone());
    }
    let output_dir = p.output_dir.clone().or_else(|| {
        saved
            .get("outputDir")
            .and_then(Value::as_str)
            .map(str::to_string)
    });

    user_config.extend(parse_plugin_args_to_user_config(&var_defs, &p.args)?);
    let effective = crate::crawler::task_scheduler::build_effective_user_config_from_var_defs(
        &var_defs,
        user_config,
    );
    let config = effective.clone().into_iter().collect::<BTreeMap<_, _>>();
    let plugin_file_path = plugin_file_path.map(|path| path.to_string_lossy().into_owned());

    if p.dry_run {
        return Ok(PluginRunOutput {
            plugin_id: plugin.id,
            plugin_version: plugin.version,
            script_type: plugin.script_type,
            plugin_file_path,
            config,
            task_id: None,
        });
    }

    let mut params = serde_json::json!({
        "pluginId": plugin.id,
        "userConfig": effective,
        "triggerSource": "cli",
    });
    if let Some(path) = plugin_file_path.as_ref() {
        params["pluginFilePath"] = Value::String(path.clone());
    }
    if !http_headers.is_empty() {
        params["httpHeaders"] = serde_json::to_value(http_headers).map_err(|e| e.to_string())?;
    }
    if let Some(output_dir) = output_dir {
        params["outputDir"] = Value::String(output_dir);
    }
    if let Some(album_id) = p.output_album_id {
        params["outputAlbumId"] = Value::String(album_id);
    }
    let task_id = start_task(params).await?;

    Ok(PluginRunOutput {
        plugin_id: plugin.id,
        plugin_version: plugin.version,
        script_type: plugin.script_type,
        plugin_file_path,
        config,
        task_id: Some(task_id),
    })
}

fn parse_plugin_args_to_user_config(
    var_defs: &[VarDefinition],
    args: &[String],
) -> Result<HashMap<String, Value>, String> {
    fn parse_one(def: &VarDefinition, raw: &str) -> Result<Value, String> {
        match def.var_type.trim().to_ascii_lowercase().as_str() {
            "int" => raw
                .trim()
                .parse::<i64>()
                .map(Value::from)
                .map_err(|e| format!("参数 {} 解析为 int 失败: {raw} ({e})", def.key)),
            "float" => raw
                .trim()
                .parse::<f64>()
                .ok()
                .and_then(serde_json::Number::from_f64)
                .map(Value::Number)
                .ok_or_else(|| format!("参数 {} 解析为 float 失败: {raw}", def.key)),
            "boolean" => {
                let value = match raw.trim().to_ascii_lowercase().as_str() {
                    "1" | "true" | "yes" | "y" | "on" => true,
                    "0" | "false" | "no" | "n" | "off" => false,
                    _ => return Err(format!("参数 {} 解析为 boolean 失败: {raw}", def.key)),
                };
                Ok(Value::Bool(value))
            }
            "list" => Ok(Value::Array(
                raw.split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| Value::String(value.to_string()))
                    .collect(),
            )),
            "options" => {
                let raw = raw.trim();
                if let Some(options) = def.options.as_ref() {
                    for option in options {
                        match option {
                            VarOption::String(value) if value == raw => {
                                return Ok(Value::String(raw.to_string()));
                            }
                            VarOption::Item { name, variable, .. }
                                if variable == raw || name.values().any(|value| value == raw) =>
                            {
                                return Ok(Value::String(variable.clone()));
                            }
                            _ => {}
                        }
                    }
                }
                Ok(Value::String(raw.to_string()))
            }
            _ => Ok(Value::String(raw.trim().to_string())),
        }
    }

    let mut values = HashMap::new();
    let mut next_positional = 0usize;
    for arg in args {
        let arg = arg.trim();
        if arg.is_empty() {
            continue;
        }
        if let Some((key, raw)) = arg.split_once('=') {
            let key = key.trim_start_matches('-').trim();
            if key.is_empty() {
                return Err(format!("无效参数: {arg}"));
            }
            let def = var_defs.iter().find(|def| def.key == key).ok_or_else(|| {
                let mut keys = var_defs
                    .iter()
                    .map(|def| def.key.as_str())
                    .collect::<Vec<_>>();
                keys.sort_unstable();
                format!("没有配置项 `{key}`。可用的有：{}", keys.join(", "))
            })?;
            values.insert(key.to_string(), parse_one(def, raw)?);
            continue;
        }

        let def = var_defs
            .get(next_positional)
            .ok_or_else(|| format!("多余的 positional 参数: {arg}"))?;
        values.insert(def.key.clone(), parse_one(def, arg)?);
        next_positional += 1;
    }
    Ok(values)
}

pub fn get_run_configs() -> Result<Value, String> {
    let configs = Storage::global().get_run_configs()?;
    serde_json::to_value(configs).map_err(|e| e.to_string())
}

pub fn get_all_tasks() -> Result<Value, String> {
    let tasks = Storage::global().get_all_tasks()?;
    serde_json::to_value(tasks).map_err(|e| e.to_string())
}

pub fn get_tasks_page(limit: u32, offset: u32) -> Result<Value, String> {
    let (tasks, total) = Storage::global().get_tasks_page(limit, offset)?;
    serde_json::to_value(serde_json::json!({ "tasks": tasks, "total": total }))
        .map_err(|e| e.to_string())
}

pub fn get_task(task_id: String) -> Result<Value, String> {
    let task = Storage::global().get_task(&task_id)?;
    serde_json::to_value(task).map_err(|e| e.to_string())
}

pub fn get_task_logs(task_id: String) -> Result<Value, String> {
    let logs = Storage::global().get_task_logs(&task_id)?;
    serde_json::to_value(logs).map_err(|e| e.to_string())
}

pub fn get_task_failed_images(task_id: String) -> Result<Value, String> {
    let images = Storage::get_task_failed_images(&task_id)?;
    serde_json::to_value(images).map_err(|e| e.to_string())
}

pub fn get_all_failed_images() -> Result<Value, String> {
    let images = Storage::get_all_failed_images()?;
    serde_json::to_value(images).map_err(|e| e.to_string())
}

pub async fn get_active_downloads() -> Result<Value, String> {
    use crate::crawler::TaskScheduler;
    let downloads = TaskScheduler::global().get_active_downloads().await?;
    serde_json::to_value(downloads).map_err(|e| e.to_string())
}

pub async fn start_task(task: Value) -> Result<String, String> {
    use std::collections::HashMap;

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct StartTaskParams {
        plugin_id: String,
        output_dir: Option<String>,
        user_config: Option<HashMap<String, Value>>,
        #[serde(default)]
        http_headers: Option<HashMap<String, String>>,
        output_album_id: Option<String>,
        plugin_file_path: Option<String>,
        run_config_id: Option<String>,
        #[serde(default = "default_trigger_source")]
        trigger_source: String,
    }

    fn default_trigger_source() -> String {
        "manual".to_string()
    }

    let p: StartTaskParams = serde_json::from_value(task).map_err(|e| e.to_string())?;
    // 网页收集：前端校验之外必须再校验一次，非法直接拒绝，不创建任务记录
    if p.plugin_id == crate::plugin::webpage::WEBPAGE_PLUGIN_ID {
        crate::crawler::webpage::validate_submission(
            p.user_config.as_ref(),
            p.http_headers.as_ref(),
        )?;
    }

    let task_id = uuid::Uuid::new_v4().to_string();
    let images_dir = crate::crawler::downloader::resolve_crawl_output_dir(p.output_dir.as_deref());
    let output_dir = Some(images_dir.to_string_lossy().into_owned());

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let t = TaskInfo {
        id: task_id.clone(),
        plugin_id: p.plugin_id,
        output_dir,
        user_config: p.user_config,
        http_headers: p.http_headers,
        output_album_id: p.output_album_id,
        run_config_id: p.run_config_id,
        trigger_source: p.trigger_source,
        status: TaskStatus::Pending,
        progress: 0.0,
        deleted_count: 0,
        dedup_count: 0,
        success_count: 0,
        failed_count: 0,
        start_time: Some(now_ms),
        end_time: None,
        error: None,
    };
    let payload = serde_json::to_value(&t).map_err(|e| e.to_string())?;
    Storage::global().add_task(t)?;
    GlobalEmitter::global().emit_task_added(&payload);

    let req = crate::crawler::CrawlTaskRequest {
        task_id: task_id.clone(),
        plugin_file_path: p.plugin_file_path,
    };
    crate::crawler::TaskScheduler::global()
        .submit_task(req)
        .await?;
    Ok(task_id)
}

pub async fn cancel_task(task_id: String) -> Result<Value, String> {
    use crate::crawler::TaskScheduler;
    TaskScheduler::global().cancel_task(&task_id).await;
    Ok(Value::Null)
}

pub fn delete_task(task_id: String) -> Result<Value, String> {
    let storage = Storage::global();
    storage.delete_task(&task_id)?;
    GlobalEmitter::global().emit_task_deleted(&task_id);
    GlobalEmitter::global().emit_images_change("change", &[], Some(&[task_id]), None, None);
    Ok(Value::Null)
}

pub async fn retry_task_failed_image(failed_id: i64) -> Result<Value, String> {
    use crate::crawler::TaskScheduler;
    TaskScheduler::global()
        .retry_failed_image(failed_id)
        .await?;
    Ok(Value::Null)
}

pub async fn retry_failed_images(ids: Vec<i64>) -> Result<Value, String> {
    use crate::crawler::TaskScheduler;
    let started = TaskScheduler::global().retry_failed_images(&ids).await?;
    serde_json::to_value(started).map_err(|e| e.to_string())
}

pub async fn cancel_retry_failed_image(failed_id: i64) -> Result<Value, String> {
    use crate::crawler::TaskScheduler;
    TaskScheduler::global()
        .cancel_retry_failed_image(failed_id)
        .await;
    Ok(Value::Null)
}

pub async fn cancel_retry_failed_images(ids: Vec<i64>) -> Result<Value, String> {
    use crate::crawler::TaskScheduler;
    TaskScheduler::global()
        .cancel_retry_failed_images(&ids)
        .await;
    Ok(Value::Null)
}

pub async fn delete_failed_images(ids: Vec<i64>) -> Result<Value, String> {
    use crate::crawler::TaskScheduler;
    TaskScheduler::global()
        .cancel_retry_failed_images(&ids)
        .await;
    let storage = Storage::global();
    let groups = storage.delete_failed_images(&ids)?;
    for (task_id, del_ids) in &groups {
        GlobalEmitter::global().emit_failed_images_removed(task_id, del_ids);
        if let Ok(Some(t)) = storage.get_task(task_id) {
            GlobalEmitter::global().emit_task_image_counts(
                task_id,
                Some(t.success_count),
                Some(t.deleted_count),
                Some(t.failed_count),
                Some(t.dedup_count),
            );
        }
    }
    Ok(Value::Null)
}

pub fn delete_task_failed_image(failed_id: i64) -> Result<Value, String> {
    let storage = Storage::global();
    let task_id = Storage::get_task_failed_image_by_id(failed_id)?.map(|item| item.task_id);
    storage.delete_task_failed_image(failed_id)?;
    if let Some(ref tid) = task_id {
        GlobalEmitter::global().emit_failed_images_removed(tid, &[failed_id]);
        if let Ok(Some(t)) = storage.get_task(tid) {
            GlobalEmitter::global().emit_task_image_counts(
                tid,
                Some(t.success_count),
                Some(t.deleted_count),
                Some(t.failed_count),
                Some(t.dedup_count),
            );
        }
    }
    Ok(Value::Null)
}

pub async fn add_run_config(config: Value) -> Result<Value, String> {
    let run_config: RunConfig = serde_json::from_value(config).map_err(|e| e.to_string())?;
    let config_id = run_config.id.clone();
    let result = Storage::global().add_run_config(run_config)?;
    let _ = Scheduler::global().reload_config(&config_id).await;
    GlobalEmitter::global().emit_auto_config_change("configadd", &config_id);
    serde_json::to_value(result).map_err(|e| e.to_string())
}

pub async fn update_run_config(config: Value) -> Result<Value, String> {
    let run_config: RunConfig = serde_json::from_value(config).map_err(|e| e.to_string())?;
    let config_id = run_config.id.clone();
    Storage::global().update_run_config(run_config)?;
    let _ = Scheduler::global().reload_config(&config_id).await;
    GlobalEmitter::global().emit_auto_config_change("configchange", &config_id);
    Ok(Value::Null)
}

pub async fn delete_run_config(config_id: String) -> Result<Value, String> {
    let _ = Scheduler::global().remove_config(&config_id).await;
    Storage::global().delete_run_config(&config_id)?;
    GlobalEmitter::global().emit_auto_config_change("configdelete", &config_id);
    Ok(Value::Null)
}

pub async fn run_missed_configs(config_ids: Vec<String>) -> Result<Value, String> {
    crate::scheduler::run_missed_configs(&config_ids);
    let _ = Scheduler::global().reload_config("").await;
    Ok(Value::Null)
}

pub async fn dismiss_missed_configs(config_ids: Vec<String>) -> Result<Value, String> {
    crate::scheduler::dismiss_missed_configs(&config_ids);
    let _ = Scheduler::global().reload_config("").await;
    Ok(Value::Null)
}

pub fn clear_finished_tasks() -> Result<Value, String> {
    let storage = Storage::global();
    let task_ids = storage.get_finished_task_ids()?;
    let count = storage.clear_finished_tasks()?;
    for tid in &task_ids {
        GlobalEmitter::global().emit_task_deleted(tid);
    }
    if !task_ids.is_empty() {
        GlobalEmitter::global().emit_images_change("change", &[], Some(&task_ids), None, None);
    }
    serde_json::to_value(count).map_err(|e| e.to_string())
}

pub async fn copy_run_config(config_id: String) -> Result<Value, String> {
    let new_id = uuid::Uuid::new_v4().to_string();
    let copied = Storage::global().copy_run_config(&config_id, &new_id)?;
    let _ = Scheduler::global().reload_config(&new_id).await;
    GlobalEmitter::global().emit_auto_config_change("configadd", &copied.id);
    serde_json::to_value(copied).map_err(|e| e.to_string())
}

pub fn get_run_config(config_id: String) -> Result<Value, String> {
    match Storage::global().get_run_config(&config_id)? {
        Some(cfg) => serde_json::to_value(cfg).map_err(|e| e.to_string()),
        None => Ok(Value::Null),
    }
}

pub fn get_missed_runs() -> Result<Value, String> {
    let items = crate::scheduler::collect_missed_runs_now()?;
    serde_json::to_value(items).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn var(value: Value) -> VarDefinition {
        serde_json::from_value(value).expect("var definition")
    }

    #[test]
    fn plugin_args_support_key_value_and_positional() {
        let defs = vec![
            var(serde_json::json!({ "key": "page", "type": "int", "name": "Page" })),
            var(serde_json::json!({ "key": "query", "type": "string", "name": "Query" })),
        ];
        let values = parse_plugin_args_to_user_config(
            &defs,
            &["3".to_string(), "query=kabegame".to_string()],
        )
        .expect("parse args");
        assert_eq!(values.get("page"), Some(&serde_json::json!(3)));
        assert_eq!(values.get("query"), Some(&serde_json::json!("kabegame")));
    }

    #[test]
    fn plugin_args_map_option_display_name_to_variable() {
        let defs = vec![var(serde_json::json!({
            "key": "quality",
            "type": "options",
            "name": "Quality",
            "options": [{ "name": "高清", "variable": "high" }]
        }))];
        let values = parse_plugin_args_to_user_config(&defs, &["quality=高清".to_string()])
            .expect("parse option");
        assert_eq!(values.get("quality"), Some(&serde_json::json!("high")));
    }

    #[test]
    fn plugin_args_reject_unknown_key_with_available_keys() {
        let defs = vec![var(serde_json::json!({
            "key": "known",
            "type": "string",
            "name": "Known"
        }))];
        let error = parse_plugin_args_to_user_config(&defs, &["missing=1".to_string()])
            .expect_err("unknown key must fail");
        assert!(error.contains("missing"));
        assert!(error.contains("known"));
    }
}
