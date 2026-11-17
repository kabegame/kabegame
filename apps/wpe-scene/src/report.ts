import { invoke } from "@tauri-apps/api/core";
import { postSceneProgress, type SceneProgressStage } from "./progress";

type SceneReport =
  | { kind: "ready"; instance: string }
  | { kind: "fallback"; instance: string; reasons: string[] }
  | { kind: "unsupported"; instance: string; image: string; keys: string[] }
  | { kind: "log"; level: "info" | "warn" | "error"; message: string };

export interface SceneReporter {
  ready(): void;
  fallback(reasons: string[]): void;
  info(message: string): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
  debug(message: string, detail?: unknown): void;
  /** 首次加载的进度（`progress.ts`），已节流；经 postMessage 交给父页面。dev 探针等别的上报器可以不给 */
  progress?(stage: SceneProgressStage, done: number, total: number): void;
  /**
   * 运行中出现的不支持项（活的场景图 L5 点 5）：场景不退回，只是相关对象没画出，所以另外告诉用户。
   * 同一个宿主实例里报过的键不再报；Rust 记 warn 并转给主窗口的看板娘。加载时的不支持项仍走 `fallback`。
   * dev 探针等别的上报器可以不给。
   */
  unsupported?(keys: readonly string[]): void;
}

/** 宿主地址里的图片 id（`kbScene`）；取不到给空串。 */
function sceneImageId(): string {
  if (typeof location === "undefined") return "";
  return new URLSearchParams(location.search).get("kbScene") ?? "";
}

export function createReporter(instance: string): SceneReporter {
  const image = sceneImageId();
  /** 本实例报过的不支持项键 */
  const reported = new Set<string>();
  function send(report: SceneReport) {
    void invoke("wpe_scene_report", { report }).catch((error) => console.error("场景宿主上报失败", error));
  }
  function log(level: "info" | "warn" | "error", message: string, detail?: unknown) {
    const full =
      detail === undefined ? message : `${message} ${Array.isArray(detail) ? detail.join("; ") : String(detail)}`;
    console[level](full);
    send({ kind: "log", level, message: full });
  }
  return {
    ready: () => send({ kind: "ready", instance }),
    fallback: (reasons) => send({ kind: "fallback", instance, reasons }),
    info: (message) => log("info", message),
    warn: (message, detail) => log("warn", message, detail),
    error: (message, detail) => log("error", message, detail),
    debug: (message, detail) => (detail === undefined ? console.debug(message) : console.debug(message, detail)),
    progress: postSceneProgress,
    unsupported: (keys) => {
      const fresh: string[] = [];
      for (const key of keys) {
        if (reported.has(key)) continue;
        reported.add(key);
        fresh.push(key);
      }
      if (fresh.length === 0) return;
      // 只在宿主控制台记 warn：Rust 收到 unsupported 时自己记一条带窗口、图片与全部键的 warn，
      // 这里再走 `log` 会让后端日志同一件事出现两行
      console.warn(`场景运行中用到不支持的特性：${fresh.join(", ")}`);
      send({ kind: "unsupported", instance, image, keys: fresh });
    },
  };
}
