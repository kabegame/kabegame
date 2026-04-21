import { defineStore } from "pinia";
import { ref } from "vue";
import { APP_VERSION } from "@kabegame/core/env";
import { useSuper } from "@kabegame/core/composables/useSuper";

/**
 * 主进程 / 壳层侧应用级状态（可在此扩展更多字段）。
 * `version`：Vite 编译期由 `apps/main/.env` (`VITE_APP_VERSION`) 注入。
 * `isSuper` / `setSuper`：web 模式 super 权限，URL `?super=1` 为唯一真源；
 * 非 web 平台 isSuper 恒为 true、setSuper 为 no-op。
 */
export const useApp = defineStore("app", () => {
  const version = ref<string | null>(APP_VERSION);
  const { isSuper, setSuper } = useSuper();

  return { version, isSuper, setSuper };
});
