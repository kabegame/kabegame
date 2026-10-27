use crate::emitter::GlobalEmitter;
#[cfg(test)]
use crate::plugin::package_file::preset_content_matches;
use crate::plugin::{PluginManager, VarDefinition, VarOption};
use crate::providers::query::query_fetch;
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
    #[serde(default)]
    pub max_concurrent_downloads: Option<u32>,
    #[serde(default)]
    pub print_config: bool,
    #[serde(default)]
    pub is_dry_run: bool,
    /// 把插件描述模板冻结进本任务 metadata（CLI `--freeze-template`，v4 协议新增）
    #[serde(default)]
    pub freeze_template: bool,
}

/// 0 会让任务永远无法入队；不设上界，超过全局值时按全局值生效。
fn validate_task_max_downloads(value: Option<u32>) -> Result<Option<u32>, String> {
    match value {
        Some(0) => Err("任务最大并发下载数必须大于等于 1".to_string()),
        value => Ok(value),
    }
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
        .read_plugin_default_config_file(&plugin.id)?
        .unwrap_or(Value::Null);
    let user_default: HashMap<String, Value> = saved
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

    let user_config = parse_plugin_args_to_user_config(&var_defs, &p.args)?;
    let effective = crate::crawler::task_scheduler::build_effective_user_config_from_var_defs(
        &var_defs,
        user_config.clone(),
        Some(&user_default),
    )?;
    let config = effective.clone().into_iter().collect::<BTreeMap<_, _>>();
    let plugin_file_path = plugin_file_path.map(|path| path.to_string_lossy().into_owned());

    if p.print_config {
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
        "userConfig": user_config,
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
    if let Some(limit) = validate_task_max_downloads(p.max_concurrent_downloads)? {
        params["maxConcurrentDownloads"] = Value::from(limit);
    }
    params["isDryRun"] = Value::Bool(p.is_dry_run);
    if p.freeze_template {
        params["freezeTemplate"] = Value::Bool(true);
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
            "int" => {
                let raw = raw.trim();
                if raw.is_empty() {
                    return Ok(Value::Null);
                }
                raw.parse::<i64>()
                    .map(Value::from)
                    .map_err(|e| format!("参数 {} 解析为 int 失败: {raw} ({e})", def.key))
            }
            "float" => {
                let raw = raw.trim();
                if raw.is_empty() {
                    return Ok(Value::Null);
                }
                raw.parse::<f64>()
                    .ok()
                    .and_then(serde_json::Number::from_f64)
                    .map(Value::Number)
                    .ok_or_else(|| format!("参数 {} 解析为 float 失败: {raw}", def.key))
            }
            "boolean" => {
                let raw = raw.trim();
                if raw.is_empty() {
                    return Ok(Value::Null);
                }
                let value = match raw.to_ascii_lowercase().as_str() {
                    "1" | "true" | "yes" | "y" | "on" => true,
                    "0" | "false" | "no" | "n" | "off" => false,
                    _ => return Err(format!("参数 {} 解析为 boolean 失败: {raw}", def.key)),
                };
                Ok(Value::Bool(value))
            }
            "list" => {
                let values = raw
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| Value::String(value.to_string()))
                    .collect::<Vec<_>>();
                Ok(if values.is_empty() {
                    Value::Null
                } else {
                    Value::Array(values)
                })
            }
            "checkbox" => {
                let selected = raw
                    .split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>();
                if selected.is_empty() {
                    return Ok(Value::Null);
                }
                let variables = def
                    .options
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .map(|option| match option {
                        VarOption::String(value) => value.as_str(),
                        VarOption::Item { variable, .. } => variable.as_str(),
                    })
                    .collect::<Vec<_>>();
                for value in &selected {
                    if !variables.contains(value) {
                        return Err(format!("参数 {} 包含未知 checkbox 选项: {value}", def.key));
                    }
                }
                Ok(Value::Object(
                    variables
                        .into_iter()
                        .map(|variable| {
                            (
                                variable.to_string(),
                                Value::Bool(selected.contains(&variable)),
                            )
                        })
                        .collect(),
                ))
            }
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
                if raw.is_empty() {
                    Ok(Value::Null)
                } else {
                    Err(format!("参数 {} 不是有效 option: {raw}", def.key))
                }
            }
            _ => {
                let raw = raw.trim();
                Ok(if raw.is_empty() {
                    Value::Null
                } else {
                    Value::String(raw.to_string())
                })
            }
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
        #[serde(default)]
        max_concurrent_downloads: Option<u32>,
        #[serde(default)]
        is_dry_run: bool,
        /// 只经 CLI PluginRun 传入；前端不用
        #[serde(default)]
        freeze_template: bool,
    }

    fn default_trigger_source() -> String {
        "manual".to_string()
    }

    let p: StartTaskParams = serde_json::from_value(task).map_err(|e| e.to_string())?;
    let max_concurrent_downloads = validate_task_max_downloads(p.max_concurrent_downloads)?;
    let plugin_manager = PluginManager::global();
    let (plugin, _) = plugin_manager
        .resolve_plugin_for_task_request(&p.plugin_id, p.plugin_file_path.as_deref())
        .await?;
    let saved = plugin_manager
        .read_plugin_default_config_file(&plugin.id)?
        .unwrap_or(Value::Null);
    let user_default = saved
        .get("userConfig")
        .and_then(Value::as_object)
        .map(|values| values.clone().into_iter().collect::<HashMap<_, _>>())
        .unwrap_or_default();
    let effective = crate::crawler::task_scheduler::build_effective_user_config_from_var_defs(
        &plugin.var_defs,
        p.user_config.clone().unwrap_or_default(),
        Some(&user_default),
    )?;
    // 网页收集：前端校验之外必须再校验一次，非法直接拒绝，不创建任务记录
    if p.plugin_id == crate::plugin::webpage::WEBPAGE_PLUGIN_ID {
        crate::crawler::webpage::validate_submission(Some(&effective), p.http_headers.as_ref())?;
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
        user_config: Some(effective),
        http_headers: p.http_headers,
        output_album_id: p.output_album_id,
        run_config_id: p.run_config_id,
        trigger_source: p.trigger_source,
        max_concurrent_downloads,
        is_dry_run: p.is_dry_run,
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
        freeze_template: p.freeze_template,
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

/// 实时调整运行中（pending / running / waiting_downloads）任务的下载并发上限。
pub fn set_task_max_concurrent_downloads(
    task_id: String,
    max_concurrent_downloads: Option<u32>,
) -> Result<Value, String> {
    let limit = validate_task_max_downloads(max_concurrent_downloads)?;
    crate::crawler::TaskScheduler::global().set_task_max_concurrent_downloads(&task_id, limit)?;
    GlobalEmitter::global().emit_task_changed(
        &task_id,
        serde_json::json!({ "maxConcurrentDownloads": limit }),
    );
    Ok(query_fetch(&format!("tasks://id_{task_id}"))?
        .into_iter()
        .next()
        .unwrap_or(Value::Null))
}

pub fn delete_task(task_id: String) -> Result<Value, String> {
    let storage = Storage::global();
    storage.delete_task(&task_id)?;
    GlobalEmitter::global().emit_task_deleted(&task_id);
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

struct RecommendedPluginState {
    plugin_id: String,
    installed: bool,
    paths: BTreeMap<String, bool>,
}

struct RecommendedSnapshot {
    plugins: Vec<(bool, std::sync::Arc<crate::plugin::Plugin>)>,
    states: Vec<RecommendedPluginState>,
}

fn recommended_snapshot_states(
    plugins: &[(bool, std::sync::Arc<crate::plugin::Plugin>)],
    configs: &[RunConfig],
) -> Vec<RecommendedPluginState> {
    plugins
        .iter()
        .map(|(installed, plugin)| RecommendedPluginState {
            plugin_id: plugin.id.clone(),
            installed: *installed,
            paths: crate::plugin::package_file::recommended_import_states(plugin, configs)
                .into_iter()
                .collect(),
        })
        .collect()
}

fn recommended_diff_scope(plugin_ids: Vec<String>) -> Result<RecommendedSnapshot, String> {
    let ids: std::collections::BTreeSet<_> = plugin_ids.into_iter().collect();
    let plugins: Vec<_> = ids
        .iter()
        .flat_map(|id| PluginManager::global().recommended_diff_plugins(id))
        .collect();
    let configs = Storage::global().get_run_configs()?;
    let states = recommended_snapshot_states(&plugins, &configs);
    Ok(RecommendedSnapshot { plugins, states })
}

/// 前后使用同一来源集合；先合并实际变化的路径，再优先取已安装插件的新状态。
fn recommended_import_changes(
    before: &[RecommendedPluginState],
    after: &[RecommendedPluginState],
) -> BTreeMap<String, Value> {
    let mut changed: BTreeMap<String, BTreeMap<String, bool>> = BTreeMap::new();
    for (old, new) in before.iter().zip(after) {
        for (path, imported) in &new.paths {
            if old
                .paths
                .get(path)
                .is_some_and(|previous| previous != imported)
            {
                changed
                    .entry(new.plugin_id.clone())
                    .or_default()
                    .entry(path.clone())
                    .or_insert(*imported);
            }
        }
    }
    for installed in after.iter().filter(|state| state.installed) {
        if let Some(paths) = changed.get_mut(&installed.plugin_id) {
            for (path, imported) in paths {
                if let Some(value) = installed.paths.get(path) {
                    *imported = *value;
                }
            }
        }
    }
    changed
        .into_iter()
        .map(|(id, paths)| {
            let paths: serde_json::Map<String, Value> = paths
                .into_iter()
                .map(|(path, imported)| (path, serde_json::json!({ "imported": imported })))
                .collect();
            (id, serde_json::json!({ "recommendedConfigs": paths }))
        })
        .collect()
}

fn emit_recommended_diff(before: RecommendedSnapshot) {
    // 写库已经成功，附带快照失败不能把成功的写入报告成失败。
    let configs = match Storage::global().get_run_configs() {
        Ok(configs) => configs,
        Err(error) => {
            eprintln!("[WARN] 读取写后推荐配置导入态失败: {error}");
            return;
        }
    };
    let after = recommended_snapshot_states(&before.plugins, &configs);
    for (id, changes) in recommended_import_changes(&before.states, &after) {
        GlobalEmitter::global().emit_plugin_changed(&id, changes);
    }
}

pub async fn add_run_config(config: Value) -> Result<Value, String> {
    let run_config: RunConfig = serde_json::from_value(config).map_err(|e| e.to_string())?;
    let config_id = run_config.id.clone();
    let before = recommended_diff_scope(vec![run_config.plugin_id.clone()])?;
    Storage::global().add_run_config(run_config)?;
    emit_recommended_diff(before);
    let _ = Scheduler::global().reload_config(&config_id).await;
    GlobalEmitter::global().emit_auto_config_change("configadd", &config_id);
    let saved = query_fetch(&format!("run_configs://id_{config_id}"))?
        .into_iter()
        .next()
        .unwrap_or(Value::Null);
    Ok(saved)
}

pub async fn update_run_config(config: Value) -> Result<Value, String> {
    let run_config: RunConfig = serde_json::from_value(config).map_err(|e| e.to_string())?;
    let config_id = run_config.id.clone();
    let mut plugin_ids = vec![run_config.plugin_id.clone()];
    if let Some(old) = Storage::global().get_run_config(&config_id)? {
        plugin_ids.push(old.plugin_id);
    }
    let before = recommended_diff_scope(plugin_ids)?;
    Storage::global().update_run_config(run_config)?;
    emit_recommended_diff(before);
    let _ = Scheduler::global().reload_config(&config_id).await;
    GlobalEmitter::global().emit_auto_config_change("configchange", &config_id);
    let saved = query_fetch(&format!("run_configs://id_{config_id}"))?
        .into_iter()
        .next()
        .unwrap_or(Value::Null);
    Ok(saved)
}

pub async fn delete_run_config(config_id: String) -> Result<Value, String> {
    let plugin_ids = Storage::global()
        .get_run_config(&config_id)?
        .map(|config| vec![config.plugin_id])
        .unwrap_or_default();
    let before = recommended_diff_scope(plugin_ids)?;
    let _ = Scheduler::global().remove_config(&config_id).await;
    Storage::global().delete_run_config(&config_id)?;
    emit_recommended_diff(before);
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
    Ok(serde_json::json!({ "taskIds": task_ids, "count": count }))
}

pub async fn copy_run_config(config_id: String) -> Result<Value, String> {
    let new_id = uuid::Uuid::new_v4().to_string();
    let source = Storage::global()
        .get_run_config(&config_id)?
        .ok_or("运行配置不存在")?;
    let before = recommended_diff_scope(vec![source.plugin_id])?;
    let copied = Storage::global().copy_run_config(&config_id, &new_id)?;
    emit_recommended_diff(before);
    let _ = Scheduler::global().reload_config(&new_id).await;
    GlobalEmitter::global().emit_auto_config_change("configadd", &copied.id);
    let saved = query_fetch(&format!("run_configs://id_{}", copied.id))?
        .into_iter()
        .next()
        .unwrap_or(Value::Null);
    Ok(saved)
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

    #[tokio::test]
    async fn run_config_writes_reject_invalid_rows_without_runtime() {
        // 反序列化失败应直接返回错误，不需要初始化存储、插件或任务运行时。
        assert!(add_run_config(serde_json::json!({ "id": "a" }))
            .await
            .is_err());
        assert!(update_run_config(Value::Null).await.is_err());
    }

    fn recommended_config(plugin_id: &str) -> RunConfig {
        serde_json::from_value(serde_json::json!({
            "id": "config", "name": "名称", "pluginId": plugin_id,
            "url": "https://example.test", "createdAt": 1
        }))
        .unwrap()
    }

    fn recommended_states(configs: &[RunConfig]) -> Vec<RecommendedPluginState> {
        ["a", "b"]
            .into_iter()
            .map(|id| RecommendedPluginState {
                plugin_id: id.into(),
                installed: true,
                paths: [
                    ("default.json", "https://example.test"),
                    ("other.json", "https://other.test"),
                ]
                .into_iter()
                .map(|(path, url)| {
                    (
                        path.into(),
                        configs.iter().any(|config| {
                            preset_content_matches(id, url, &[], &serde_json::json!({}), config)
                        }),
                    )
                })
                .collect(),
            })
            .collect()
    }

    fn recommended_changes(before: &[RunConfig], after: &[RunConfig]) -> BTreeMap<String, Value> {
        recommended_import_changes(&recommended_states(before), &recommended_states(after))
    }

    #[test]
    fn recommended_diff_add_emits_only_new_matches() {
        let config = recommended_config("a");
        let changes = recommended_changes(&[], &[config.clone()]);
        assert_eq!(changes.len(), 1);
        assert_eq!(
            changes["a"],
            serde_json::json!({
                "recommendedConfigs": {"default.json": {"imported": true}}
            })
        );
        assert!(recommended_changes(&[config.clone()], &[config.clone(), config]).is_empty());
        assert!(recommended_changes(&[], &[recommended_config("unrelated")]).is_empty());
    }

    #[test]
    fn recommended_diff_update_checks_both_plugins_and_ignores_schedule() {
        let old = recommended_config("a");
        let mut new = old.clone();
        new.plugin_id = "b".into();
        let changes = recommended_changes(&[old.clone()], &[new]);
        assert_eq!(changes.len(), 2);
        assert_eq!(
            changes["a"]["recommendedConfigs"]["default.json"]["imported"],
            false
        );
        assert_eq!(
            changes["b"]["recommendedConfigs"]["default.json"]["imported"],
            true
        );
        let mut renamed = old.clone();
        renamed.name = "重命名".into();
        renamed.schedule_enabled = true;
        renamed.schedule_spec = Some(crate::storage::ScheduleSpec::Hourly { minute: 30 });
        renamed.schedule_planned_at = Some(100);
        assert!(recommended_changes(&[old], &[renamed]).is_empty());
    }

    #[test]
    fn recommended_diff_delete_emits_only_last_match_removal() {
        let config = recommended_config("a");
        let changes = recommended_changes(&[config.clone()], &[]);
        assert_eq!(changes.len(), 1);
        assert_eq!(
            changes["a"],
            serde_json::json!({
                "recommendedConfigs": {"default.json": {"imported": false}}
            })
        );
        assert!(recommended_changes(&[config.clone(), config.clone()], &[config]).is_empty());
        assert!(recommended_changes(&[recommended_config("unrelated")], &[]).is_empty());
    }

    #[test]
    fn recommended_diff_merges_sources_and_prefers_installed_new_state() {
        let state = |installed, imported| RecommendedPluginState {
            plugin_id: "a".into(),
            installed,
            paths: BTreeMap::from([("default.json".into(), imported)]),
        };
        let before = [state(true, false), state(false, false), state(false, false)];
        let after = [state(true, false), state(false, true), state(false, true)];
        let changes = recommended_import_changes(&before, &after);
        assert_eq!(changes.len(), 1);
        assert_eq!(
            changes["a"],
            serde_json::json!({
                "recommendedConfigs": {"default.json": {"imported": false}}
            })
        );
        let changes = recommended_import_changes(&before[1..], &after[1..]);
        assert_eq!(changes.len(), 1);
        assert_eq!(
            changes["a"]["recommendedConfigs"]["default.json"]["imported"],
            true
        );
    }

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
    fn plugin_args_empty_values_become_null_except_declared_empty_option() {
        let defs = vec![
            var(serde_json::json!({"key": "tag", "type": "string", "name": "Tag"})),
            var(serde_json::json!({"key": "items", "type": "list", "name": "Items"})),
            var(serde_json::json!({
                "key": "option", "type": "options", "name": "Option",
                "options": [{"name": "Any", "variable": ""}]
            })),
        ];
        let values = parse_plugin_args_to_user_config(
            &defs,
            &[
                "tag=".to_string(),
                "items=,,".to_string(),
                "option=".to_string(),
            ],
        )
        .unwrap();
        assert_eq!(values["tag"], Value::Null);
        assert_eq!(values["items"], Value::Null);
        assert_eq!(values["option"], serde_json::json!(""));
    }

    #[test]
    fn plugin_args_checkbox_produces_complete_object_and_rejects_unknown_option() {
        let defs = vec![var(serde_json::json!({
            "key": "kinds", "type": "checkbox", "name": "Kinds", "options": ["a", "b", "c"]
        }))];
        let values = parse_plugin_args_to_user_config(&defs, &["kinds=a,c".to_string()]).unwrap();
        assert_eq!(
            values["kinds"],
            serde_json::json!({"a": true, "b": false, "c": true})
        );
        assert_eq!(
            parse_plugin_args_to_user_config(&defs, &["kinds=".to_string()]).unwrap()["kinds"],
            Value::Null
        );
        assert!(
            parse_plugin_args_to_user_config(&defs, &["kinds=x".to_string()])
                .unwrap_err()
                .contains("未知 checkbox 选项")
        );
    }

    #[test]
    fn plugin_args_reject_unknown_option_value() {
        let defs = vec![var(serde_json::json!({
            "key": "quality", "type": "options", "name": "Quality", "options": ["high"]
        }))];
        assert!(
            parse_plugin_args_to_user_config(&defs, &["quality=low".to_string()])
                .unwrap_err()
                .contains("不是有效 option")
        );
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

    #[test]
    fn validate_task_max_downloads_rejects_zero_only() {
        assert!(validate_task_max_downloads(Some(0)).is_err());
        assert_eq!(validate_task_max_downloads(Some(1)).unwrap(), Some(1));
        assert_eq!(validate_task_max_downloads(Some(99)).unwrap(), Some(99));
        assert_eq!(validate_task_max_downloads(None).unwrap(), None);
    }

    #[test]
    fn imported_preset_comparison_normalizes_content_and_ignores_name_and_schedule() {
        let defs = vec![
            var(serde_json::json!({"key":"text","type":"string","name":"Text"})),
            var(serde_json::json!({"key":"items","type":"list","name":"Items"})),
            var(serde_json::json!({
                "key":"kinds","type":"checkbox","name":"Kinds","options":["a","b"]
            })),
        ];
        let mut config = RunConfig {
            id: "config-1".to_string(),
            name: "renamed".to_string(),
            description: None,
            plugin_id: "plugin-a".to_string(),
            url: " https://example.test ".to_string(),
            output_dir: None,
            output_album_id: None,
            user_config: Some(HashMap::from([(
                "kinds".to_string(),
                serde_json::json!({"a":true,"b":false}),
            )])),
            http_headers: None,
            max_concurrent_downloads: None,
            is_dry_run: false,
            created_at: 1,
            schedule_enabled: true,
            schedule_spec: Some(crate::storage::ScheduleSpec::Hourly { minute: 30 }),
            schedule_planned_at: Some(10),
            schedule_last_run_at: None,
        };
        let preset = serde_json::json!({
            "filename":"default.json",
            "name":"original",
            "userConfig":{"text":"","items":[],"kinds":["a"]},
            "httpHeaders":{},
            "isDryRun":false
        });
        assert!(preset_content_matches(
            "plugin-a",
            "https://example.test",
            &defs,
            &preset,
            &config
        ));

        config.is_dry_run = true;
        assert!(!preset_content_matches(
            "plugin-a",
            "https://example.test",
            &defs,
            &preset,
            &config
        ));
        config.is_dry_run = false;
        config.url = "https://changed.test".to_string();
        assert!(!preset_content_matches(
            "plugin-a",
            "https://example.test",
            &defs,
            &preset,
            &config
        ));
        config.url = "https://example.test".to_string();
        config.http_headers = Some(HashMap::from([(
            "Authorization".to_string(),
            "x".to_string(),
        )]));
        assert!(!preset_content_matches(
            "plugin-a",
            "https://example.test",
            &defs,
            &preset,
            &config
        ));
    }
}
