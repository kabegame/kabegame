import { invoke } from "@tauri-apps/api/core";
import { postSceneProgress, type SceneProgressStage } from "./progress";

type SceneReport =
  | { kind: "ready"; instance: string }
  | { kind: "fallback"; instance: string; reasons: string[] }
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
}

export function createReporter(instance: string): SceneReporter {
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
  };
}
