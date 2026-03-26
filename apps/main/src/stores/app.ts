import { defineStore } from "pinia";
import { ref } from "vue";

let versionLoadPromise: Promise<void> | null = null;

/**
 * 主进程 / 壳层侧应用级状态（可在此扩展更多字段）。
 * `version`：Tauri `getVersion()`，初始 null，异步写入；失败或非 Tauri 保持 null。
 * 首次 `useApp()` 时内部开始拉取版本。
 */
export const useApp = defineStore("app", () => {
  const version = ref<string | null>(null);

  if (!versionLoadPromise) {
    versionLoadPromise = import("@tauri-apps/api/core")
      .then(({ isTauri }) => {
        if (!isTauri()) return;
        return import("@tauri-apps/api/app").then(({ getVersion }) => getVersion());
      })
      .then((v) => {
        version.value = typeof v === "string" && v.trim() !== "" ? v.trim() : null;
      })
      .catch(() => {
        version.value = null;
      });
  }

  return { version };
});
