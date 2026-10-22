//! 使用独立临时数据库验证写命令载荷，不启动爬虫或调度循环。
use kabegame_core::app_paths::AppPaths;
use kabegame_core::commands::task::{
    add_run_config, copy_run_config, delete_run_config, update_run_config,
};
use kabegame_core::emitter::GlobalEmitter;
use kabegame_core::plugin::PluginManager;
use kabegame_core::scheduler::Scheduler;
use kabegame_core::storage::Storage;
use serde_json::{json, Value};

fn assert_saved_row(row: &Value, id: &str, name: &str) {
    assert_eq!(row["id"], id);
    assert_eq!(row["name"], name);
    assert_eq!(row["plugin_id"], "test-plugin");
    assert_eq!(row["last_result"], "never");
    for wrapper_field in ["config", "configId", "reason", "seq", "view"] {
        assert!(
            row.get(wrapper_field).is_none(),
            "不应包含包装字段 {wrapper_field}"
        );
    }
}

#[tokio::test]
async fn run_config_commands_return_saved_rows_and_delete_returns_null() {
    // 集成测试拥有独立进程，单例与所有写入均限定在临时目录。
    let root = tempfile::tempdir().unwrap();
    let path = root.path();
    AppPaths::init(AppPaths {
        data_dir: path.join("data"),
        cache_dir: path.join("cache"),
        temp_dir: path.join("tmp"),
        resource_dir: path.join("resources"),
        exe_dir: None,
        external_data_dir: None,
        pictures_dir: None,
        compatibles_dir_path: path.join("compatibles"),
    })
    .unwrap();
    PluginManager::init_global_without_metadata_migrations().unwrap();
    Storage::init_global().unwrap();
    Scheduler::init_global().unwrap();
    GlobalEmitter::init_global().unwrap();
    #[cfg(feature = "ipc-server")]
    kabegame_core::ipc::server::EventBroadcaster::init_global(32).unwrap();

    let mut config = json!({
        "id": "config-a", "name": "原配置", "pluginId": "test-plugin",
        "url": "https://example.test", "createdAt": 1, "scheduleEnabled": false
    });
    let added = add_run_config(config.clone()).await.unwrap();
    assert_saved_row(&added, "config-a", "原配置");

    config["name"] = json!("改名配置");
    let updated = update_run_config(config).await.unwrap();
    assert_saved_row(&updated, "config-a", "改名配置");

    let copied = copy_run_config("config-a".into()).await.unwrap();
    let copied_id = copied["id"].as_str().unwrap();
    assert_ne!(copied_id, "config-a");
    assert_eq!(copied["plugin_id"], "test-plugin");
    assert_eq!(copied["last_result"], "never");
    assert!(copied.get("config").is_none());
    assert!(Storage::global()
        .get_run_config(copied_id)
        .unwrap()
        .is_some());

    assert_eq!(
        delete_run_config("config-a".into()).await.unwrap(),
        Value::Null
    );
    assert!(Storage::global()
        .get_run_config("config-a")
        .unwrap()
        .is_none());
    assert_eq!(
        delete_run_config(copied_id.into()).await.unwrap(),
        Value::Null
    );
}
