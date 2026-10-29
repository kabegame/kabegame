import { Channel } from "@tauri-apps/api/core";
import { invoke } from "@/api";
import { logSseUrl } from "@/api/web";
import { IS_WEB } from "@/env";

/** 后端 `kabegame_core::logging::LogRecord`。 */
export interface LogRecord {
  /** 进程内单调递增，用于去重与排序 */
  seq: number;
  /** 毫秒时间戳 */
  ts: number;
  level: LogLevel;
  /** 模块路径；前端日志为 `webview:<窗口>` */
  target: string;
  message: string;
  fields?: Record<string, unknown>;
}

export type LogLevel = "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE";

export const LOG_LEVELS: LogLevel[] = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"];

/** 后端环形缓冲里 `sinceSeq` 之后最新的至多 `limit` 条，按 seq 升序。 */
export function fetchAppLogs(sinceSeq?: number, limit?: number): Promise<LogRecord[]> {
  return invoke<LogRecord[]>("get_app_logs", { sinceSeq, limit });
}

/**
 * 订阅实时日志。Tauri：把一个 Channel 交给 `start_app_log_stream`，后端每 200ms 经它批量推送，
 * 只回到本页面（不用全局事件，畅游导航栏等窗口也能 `listen` 到全局事件）；
 * Web（仅 super）：独立的 `/logs` SSE。返回的函数关闭订阅。
 * 调用方应先订阅再拉历史，并按 seq 去重。
 */
export async function watchAppLogs(onRecords: (records: LogRecord[]) => void): Promise<() => void> {
  if (IS_WEB) {
    const es = new EventSource(logSseUrl());
    es.addEventListener("log", (event) => {
      try {
        onRecords([JSON.parse((event as MessageEvent<string>).data) as LogRecord]);
      } catch {
        // 单条解析失败不影响后续日志
      }
    });
    return () => es.close();
  }
  const channel = new Channel<LogRecord[]>();
  channel.onmessage = (records) => {
    if (Array.isArray(records)) onRecords(records);
  };
  await invoke("start_app_log_stream", { onLogs: channel });
  // 带上自己的 id：关了又立刻重开时，迟到的关闭请求不会停掉新的推送
  return () => {
    void invoke("stop_app_log_stream", { streamId: channel.id }).catch(() => {});
  };
}

/** 打开日志目录（仅桌面）。 */
export function openLogsDir(): Promise<void> {
  return invoke("open_logs_dir");
}
