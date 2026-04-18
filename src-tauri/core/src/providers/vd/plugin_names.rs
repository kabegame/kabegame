//! VD 插件/任务目录名工具（迁自 vd_ops.rs）。

/// 从 PluginManager 缓存获取插件的显示名（Light/Android 编译下返回 None）。
#[allow(unused_variables)]
pub fn plugin_display_name_from_manifest(plugin_id: &str) -> Option<String> {
    #[cfg(kabegame_mode = "standard")]
    {
        let pid = plugin_id.trim();
        if pid.is_empty() {
            return None;
        }
        let pm = crate::plugin::PluginManager::global_opt()?;
        let name = pm.get_cached_plugin_display_name_sync(pid)?;
        if name.is_empty() { None } else { Some(name) }
    }
    #[cfg(any(kabegame_mode = "light", target_os = "android"))]
    {
        None
    }
}

/// 构造 VD 「按插件」目录名：`{manifest 展示名} - {plugin_id}`。
pub fn vd_plugin_dir_name(plugin_id: &str) -> String {
    let id = plugin_id.trim();
    if id == "local-import" {
        let locale = kabegame_i18n::current_vd_locale();
        let name = kabegame_i18n::translate_vd_canonical(locale, "local-import");
        return format!("{} - {}", name, id);
    }
    if let Some(name) = plugin_display_name_from_manifest(plugin_id) {
        let n = name.trim();
        if !n.is_empty() {
            return format!("{} - {}", n, plugin_id);
        }
    }
    plugin_id.to_string()
}

/// 从目录名反查 plugin_id（`{name} - {id}` 格式最后段，或原样）。
pub fn resolve_plugin_id_from_dir_name(name: &str) -> &str {
    name.rsplit_once(" - ")
        .map(|(_, id)| id)
        .unwrap_or(name)
        .trim()
}

/// 构造 VD 「按任务」目录名：`{插件展示名} - {task_id}`。
pub fn vd_task_dir_name(task_id: &str, plugin_id: &str) -> String {
    if plugin_id.trim() == "local-import" {
        let locale = kabegame_i18n::current_vd_locale();
        let name = kabegame_i18n::translate_vd_canonical(locale, "local-import");
        return format!("{} - {}", name, task_id);
    }
    if let Some(name) = plugin_display_name_from_manifest(plugin_id) {
        let n = name.trim();
        if !n.is_empty() {
            return format!("{} - {}", n, task_id);
        }
    }
    task_id.to_string()
}

/// 从目录名反查 task_id（取最后一段分隔 ` - ` 后部分）。
pub fn resolve_task_id_from_dir_name(name: &str) -> &str {
    name.rsplit_once(" - ")
        .map(|(_, id)| id)
        .unwrap_or(name)
        .trim()
}
