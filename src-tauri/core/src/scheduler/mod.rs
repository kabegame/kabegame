use crate::crawler::{CrawlTaskRequest, TaskScheduler};
use crate::emitter::GlobalEmitter;
use crate::storage::{RunConfig, ScheduleSpec, Storage, TaskInfo};
use chrono::{Datelike, Local, TimeZone, Timelike};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::{Arc, OnceLock};
use tokio::sync::Notify;
use tokio::time::{sleep, Duration};

static SCHEDULER: OnceLock<Scheduler> = OnceLock::new();

const DUE_WINDOW_SECS: i64 = 5;
const IDLE_SLEEP_SECS: u64 = 60;
const MAX_SLEEP_SECS: i64 = 300;

pub struct Scheduler {
    notify: Arc<Notify>,
}

impl Scheduler {
    pub fn init_global() -> Result<(), String> {
        let notify = Arc::new(Notify::new());
        SCHEDULER
            .set(Self { notify })
            .map_err(|_| "Scheduler already initialized".to_string())?;
        Ok(())
    }

    pub fn global() -> &'static Scheduler {
        SCHEDULER
            .get()
            .expect("Scheduler not initialized. Call Scheduler::init_global() first.")
    }

    pub async fn start(&self) -> Result<(), String> {
        let notify = Arc::clone(&self.notify);
        tokio::spawn(async move {
            scheduler_loop(notify).await;
        });
        self.notify.notify_one();
        Ok(())
    }

    pub async fn reload_config(&self, _config_id: &str) -> Result<(), String> {
        self.notify.notify_one();
        Ok(())
    }

    pub async fn remove_config(&self, _config_id: &str) -> Result<(), String> {
        self.notify.notify_one();
        Ok(())
    }
}

async fn scheduler_loop(notify: Arc<Notify>) {
    loop {
        let now_ts = now_secs();
        let mut nearest_fire_at: Option<i64> = None;
        let mut due_configs: Vec<RunConfig> = Vec::new();

        let enabled_configs = Storage::global()
            .get_enabled_run_configs()
            .unwrap_or_default();

        for mut config in enabled_configs {
            match config.schedule_planned_at {
                Some(next_ts)
                    if next_ts >= now_ts - DUE_WINDOW_SECS
                        && next_ts <= now_ts + DUE_WINDOW_SECS =>
                {
                    due_configs.push(config);
                }
                Some(next_ts) if next_ts > now_ts + DUE_WINDOW_SECS => {
                    nearest_fire_at = Some(match nearest_fire_at {
                        Some(cur) => cur.min(next_ts),
                        None => next_ts,
                    });
                }
                Some(_) => {
                    // Stale (far in the past) -- ignore, let missed-runs dialog handle
                }
                None => {
                    if let Some(next) = compute_next_planned_at(&config, now_ts) {
                        let _ = Storage::global()
                            .set_run_config_schedule_planned_at(&config.id, Some(next));
                        if next >= now_ts - DUE_WINDOW_SECS && next <= now_ts + DUE_WINDOW_SECS {
                            config.schedule_planned_at = Some(next);
                            due_configs.push(config);
                        } else {
                            nearest_fire_at = Some(match nearest_fire_at {
                                Some(cur) => cur.min(next),
                                None => next,
                            });
                        }
                    }
                }
            }
        }

        for config in due_configs {
            let _ = schedule_trigger_once(&config).await;
        }

        let sleep_duration = match nearest_fire_at {
            None => Duration::from_secs(IDLE_SLEEP_SECS),
            Some(next) => {
                let wait = (next - now_ts).clamp(1, MAX_SLEEP_SECS) as u64;
                Duration::from_secs(wait)
            }
        };

        tokio::select! {
            _ = notify.notified() => {}
            _ = sleep(sleep_duration) => {}
        }
    }
}

async fn schedule_trigger_once(config: &RunConfig) -> Result<String, String> {
    let task_id = uuid::Uuid::new_v4().to_string();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let task = TaskInfo {
        id: task_id.clone(),
        plugin_id: config.plugin_id.clone(),
        output_dir: config.output_dir.clone(),
        user_config: config.user_config.clone(),
        http_headers: config.http_headers.clone(),
        output_album_id: None,
        run_config_id: Some(config.id.clone()),
        trigger_source: "scheduled".to_string(),
        status: "pending".to_string(),
        progress: 0.0,
        deleted_count: 0,
        dedup_count: 0,
        success_count: 0,
        failed_count: 0,
        start_time: Some(now_ms),
        end_time: None,
        error: None,
    };
    Storage::global().add_task(task)?;

    let req = CrawlTaskRequest {
        plugin_id: config.plugin_id.clone(),
        task_id: task_id.clone(),
        output_dir: config.output_dir.clone(),
        user_config: config.user_config.clone(),
        http_headers: config.http_headers.clone(),
        output_album_id: None,
        plugin_file_path: None,
        run_config_id: Some(config.id.clone()),
        trigger_source: "scheduled".to_string(),
    };
    TaskScheduler::global().submit_task(req)?;
    let now_s = now_secs();
    let _ = Storage::global().set_run_config_schedule_last_run_at(&config.id, Some(now_s));
    let next_planned = compute_next_planned_at(config, now_s);
    let _ = Storage::global().set_run_config_schedule_planned_at(&config.id, next_planned);
    GlobalEmitter::global().emit_auto_config_change("configchange", &config.id);
    Ok(task_id)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn ts_to_secs(ts: u64) -> i64 {
    if ts > 9_999_999_999 {
        (ts / 1000) as i64
    } else {
        ts as i64
    }
}

/// 在时刻 `after` 之后，下一次应触发的绝对 Unix 秒（`planned_at` 语义）。
pub fn compute_next_planned_at(config: &RunConfig, after: i64) -> Option<i64> {
    match &config.schedule_spec {
        Some(ScheduleSpec::Interval { interval_secs }) => {
            if *interval_secs <= 0 {
                return None;
            }
            let base = if after > 0 {
                after
            } else {
                ts_to_secs(config.created_at)
            };
            Some(base + *interval_secs)
        }
        Some(ScheduleSpec::Daily { hour, minute }) => {
            let minute = (*minute).clamp(0, 59) as u32;
            let hour = *hour;
            let t = if after > 0 {
                after
            } else {
                ts_to_secs(config.created_at)
            };
            compute_next_daily_fire_at(t, hour, minute)
        }
        Some(ScheduleSpec::Weekly {
            weekday,
            hour,
            minute,
        }) => {
            let minute = (*minute).clamp(0, 59) as u32;
            let hour = *hour;
            let t = if after > 0 {
                after
            } else {
                ts_to_secs(config.created_at)
            };
            compute_next_weekly_fire_at(t, *weekday, hour, minute)
        }
        None => None,
    }
}

fn compute_next_daily_fire_at(now_secs: i64, hour: i32, minute: u32) -> Option<i64> {
    let now_local = Local.timestamp_opt(now_secs, 0).single()?;
    if hour == -1 {
        let mut next = now_local.with_second(0)?.with_minute(minute)?;
        if next <= now_local {
            next = next + chrono::Duration::hours(1);
            next = next.with_minute(minute)?.with_second(0)?;
        }
        return Some(next.timestamp());
    }

    let safe_hour = hour.clamp(0, 23) as u32;
    let mut next = now_local
        .with_hour(safe_hour)?
        .with_minute(minute)?
        .with_second(0)?;
    if next <= now_local {
        next = next + chrono::Duration::days(1);
        next = next
            .with_hour(safe_hour)?
            .with_minute(minute)?
            .with_second(0)?;
    }
    Some(next.timestamp())
}

/// `weekday`: 0=周一 … 6=周日（`num_days_from_monday`）
fn compute_next_weekly_fire_at(now_secs: i64, weekday: i32, hour: i32, minute: u32) -> Option<i64> {
    let now_local = Local.timestamp_opt(now_secs, 0).single()?;
    let target_dow = weekday.clamp(0, 6) as u32;
    let safe_hour = hour.clamp(0, 23) as u32;
    let cur_dow = now_local.weekday().num_days_from_monday();
    let mut days = (target_dow as i64 - cur_dow as i64 + 7) % 7;
    let mut date = now_local
        .date_naive()
        .checked_add_signed(chrono::Duration::days(days))?;
    let mut naive = date.and_hms_opt(safe_hour, minute, 0)?;
    let mut dt = naive.and_local_timezone(Local).single()?;
    if dt <= now_local {
        days += 7;
        date = now_local
            .date_naive()
            .checked_add_signed(chrono::Duration::days(days))?;
        naive = date.and_hms_opt(safe_hour, minute, 0)?;
        dt = naive.and_local_timezone(Local).single()?;
    }
    Some(dt.timestamp())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissedRunItem {
    pub config_id: String,
    pub config_name: String,
    pub schedule_mode: String,
    pub missed_count: i64,
    pub last_due_at: i64,
}

/// 启动或调用漏跑检测时：只读计算漏跑列表（不修改 DB 中的 `planned_at`）。
pub fn recalc_all_planned_at(now_ts: i64) -> Result<Vec<MissedRunItem>, String> {
    let configs = Storage::global().get_enabled_run_configs()?;
    let active_scheduled_config_ids: HashSet<String> = Storage::global()
        .get_all_tasks()?
        .into_iter()
        .filter(|t| {
            t.trigger_source == "scheduled"
                && matches!(t.status.as_str(), "pending" | "running")
                && t.run_config_id.is_some()
        })
        .filter_map(|t| t.run_config_id)
        .collect();

    let mut out = Vec::new();

    for cfg in configs {
        if active_scheduled_config_ids.contains(&cfg.id) {
            continue;
        }
        let Some(spec) = &cfg.schedule_spec else {
            continue;
        };
        let mode_str = match spec {
            ScheduleSpec::Interval { .. } => "interval",
            ScheduleSpec::Daily { .. } => "daily",
            ScheduleSpec::Weekly { .. } => "weekly",
        };

        let mut next = cfg.schedule_planned_at.unwrap_or_else(|| {
            compute_next_planned_at(&cfg, 0).unwrap_or_else(|| ts_to_secs(cfg.created_at))
        });
        let mut missed_count = 0i64;
        let mut last_due: Option<i64> = None;

        while next <= now_ts {
            missed_count += 1;
            last_due = Some(next);
            match compute_next_planned_at(&cfg, next) {
                Some(t) => next = t,
                None => break,
            }
        }

        if missed_count > 0 {
            out.push(MissedRunItem {
                config_id: cfg.id.clone(),
                config_name: cfg.name.clone(),
                schedule_mode: mode_str.to_string(),
                missed_count,
                last_due_at: last_due.unwrap_or(next),
            });
        }
    }

    Ok(out)
}

pub fn collect_missed_runs_now() -> Result<Vec<MissedRunItem>, String> {
    recalc_all_planned_at(now_secs())
}

pub fn collect_missed_runs(now_ts: i64) -> Result<Vec<MissedRunItem>, String> {
    recalc_all_planned_at(now_ts)
}

/// User chose "run now" for missed configs.
/// Sets planned_at = now so the scheduler picks them up in the next loop.
pub fn run_missed_configs(config_ids: &[String]) {
    let now = now_secs();
    for config_id in config_ids {
        let _ = Storage::global().set_run_config_schedule_planned_at(config_id, Some(now));
        GlobalEmitter::global().emit_auto_config_change("configchange", config_id);
    }
}

/// User dismissed missed configs.
/// Sets planned_at = null so the scheduler recalculates the next run time.
pub fn dismiss_missed_configs(config_ids: &[String]) {
    for config_id in config_ids {
        let _ = Storage::global().set_run_config_schedule_planned_at(config_id, None);
        GlobalEmitter::global().emit_auto_config_change("configchange", config_id);
    }
}
