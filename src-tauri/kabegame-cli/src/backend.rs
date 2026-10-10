use clap::ValueEnum;
use kabegame_core::app_paths::AppPaths;
use kabegame_core::commands::task::{PluginRunOutput, PluginRunParams};
use kabegame_core::ipc::events::{AppEvent, AppEventKind};
use kabegame_core::ipc::ipc::IPC_PROTOCOL_VERSION;
use kabegame_core::ipc::server::EventBroadcaster;
use kabegame_core::ipc::IpcClient;
use kabegame_core::plugin::PluginManager;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::{self, UnboundedReceiver};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, ValueEnum)]
pub enum Via {
    #[default]
    Auto,
    App,
    Local,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct LocalNeeds {
    pub plugin: bool,
    pub tasks: bool,
}

impl LocalNeeds {
    pub const DATA: Self = Self {
        plugin: false,
        tasks: false,
    };
    pub const PLUGIN: Self = Self {
        plugin: true,
        tasks: false,
    };
    pub const TASKS: Self = Self {
        plugin: true,
        tasks: true,
    };
}

#[derive(Clone)]
pub enum Backend {
    Local,
    App(IpcClient),
}

enum AppProbeError {
    NotRunning(String),
    Incompatible(String),
}

fn normalized(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

async fn probe_app() -> Result<(IpcClient, String), AppProbeError> {
    let client = IpcClient::new();
    tokio::time::timeout(Duration::from_millis(750), client.connect())
        .await
        .map_err(|_| AppProbeError::NotRunning("连接 Kabegame 主程序超时".to_string()))?
        .map_err(AppProbeError::NotRunning)?;
    let status = tokio::time::timeout(Duration::from_millis(750), client.status())
        .await
        .map_err(|_| AppProbeError::Incompatible("读取主程序状态超时".to_string()))?
        .map_err(AppProbeError::Incompatible)?;

    let protocol = status
        .get("ipcProtocol")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    if protocol < u64::from(IPC_PROTOCOL_VERSION) {
        return Err(AppProbeError::Incompatible(format!(
            "主程序 IPC 协议过旧（需要 >= {IPC_PROTOCOL_VERSION}，实际 {protocol}）"
        )));
    }

    let app_data_dir = status
        .get("dataDir")
        .and_then(Value::as_str)
        .ok_or_else(|| AppProbeError::Incompatible("主程序未返回 dataDir".to_string()))?;
    let cli_data_dir = normalized(&AppPaths::global().data_dir);
    let app_data_dir = normalized(Path::new(app_data_dir));
    if app_data_dir != cli_data_dir {
        return Err(AppProbeError::Incompatible(format!(
            "数据目录不同：主程序={}，CLI={}",
            app_data_dir.display(),
            cli_data_dir.display()
        )));
    }

    let version = status
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("未知")
        .to_string();
    Ok((client, version))
}

pub async fn choose_backend(via: Via, needs: LocalNeeds) -> Result<Backend, String> {
    let backend = select_backend(via, needs).await?;
    // 任务日志按应用设置的界面语言渲染（只有提交任务的命令会打日志）。
    if needs.tasks {
        crate::task_log::set_language(backend.language().await);
    }
    Ok(backend)
}

async fn select_backend(via: Via, needs: LocalNeeds) -> Result<Backend, String> {
    if via == Via::Local {
        crate::init_local_runtime(needs).await?;
        return Ok(Backend::Local);
    }

    match probe_app().await {
        Ok((client, version)) => {
            eprintln!(
                "{}",
                console::style(format!("经主程序执行（版本 {version}）")).dim()
            );
            Ok(Backend::App(client))
        }
        Err(AppProbeError::NotRunning(error)) if via == Via::App => Err(error),
        Err(AppProbeError::Incompatible(error)) if via == Via::App => Err(error),
        Err(AppProbeError::NotRunning(_)) => {
            crate::init_local_runtime(needs).await?;
            Ok(Backend::Local)
        }
        Err(AppProbeError::Incompatible(error)) => {
            eprintln!(
                "{}",
                console::style(format!("未使用主程序：{error}；已回退本地模式")).dim()
            );
            crate::init_local_runtime(needs).await?;
            Ok(Backend::Local)
        }
    }
}

impl Backend {
    /// 应用设置里的界面语言；app 模式读取失败时按 en。
    pub async fn language(&self) -> String {
        match self {
            Self::Local => kabegame_core::settings::Settings::global()
                .get_resolved_language()
                .to_string(),
            Self::App(client) => client
                .settings_get_language()
                .await
                .unwrap_or_else(|_| "en".to_string()),
        }
    }

    pub async fn pathql_fetch(&self, path: &str) -> Result<Value, String> {
        match self {
            Self::Local => kabegame_core::commands::image::pathql_fetch(path.to_string()).await,
            Self::App(client) => client.pathql_fetch(path.to_string()).await,
        }
    }

    pub async fn install_plugin(&self, kgpg: &Path) -> Result<(), String> {
        match self {
            Self::Local => PluginManager::global()
                .install_plugin_from_kgpg(kgpg)
                .await
                .map(|_| ()),
            Self::App(client) => client
                .plugin_import(kgpg.to_string_lossy().into_owned())
                .await
                .map(|_| ()),
        }
    }

    pub async fn run_plugin(&self, params: PluginRunParams) -> Result<PluginRunOutput, String> {
        match self {
            Self::Local => kabegame_core::commands::task::run_plugin(params, false).await,
            Self::App(client) => client.plugin_run(params).await,
        }
    }

    pub async fn start_task(&self, params: Value) -> Result<String, String> {
        match self {
            Self::Local => kabegame_core::commands::task::start_task(params).await,
            Self::App(client) => client.task_start(params).await,
        }
    }

    pub async fn set_task_max_concurrent_downloads(
        &self,
        task_id: &str,
        value: Option<u32>,
    ) -> Result<(), String> {
        match self {
            Self::App(client) => {
                client
                    .task_set_max_concurrent_downloads(task_id.to_string(), value)
                    .await
            }
            Self::Local => Err("只能调整主程序中运行的任务".to_string()),
        }
    }

    pub async fn subscribe_task_events(&self) -> Result<UnboundedReceiver<Arc<AppEvent>>, String> {
        let kinds = [AppEventKind::TaskLog, AppEventKind::TasksChange];
        match self {
            Self::App(client) => client.subscribe_events(&kinds).await,
            Self::Local => {
                let mut source = EventBroadcaster::global().subscribe_filtered_stream(&kinds);
                let (tx, rx) = mpsc::unbounded_channel();
                tokio::spawn(async move {
                    while let Some((_id, event)) = source.recv().await {
                        if tx.send(event).is_err() {
                            break;
                        }
                    }
                });
                Ok(rx)
            }
        }
    }

    pub async fn cancel_task(&self, task_id: &str) {
        match self {
            Self::Local => {
                let _ = kabegame_core::commands::task::cancel_task(task_id.to_string()).await;
            }
            Self::App(client) => {
                let _ = client.task_cancel(task_id.to_string()).await;
            }
        }
    }
}
