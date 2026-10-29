// 启动页（Init app）：后端重型初始化（插件、数据库迁移与阻塞回填、各服务）完成之前，
// 主窗口只挂这个最小 Vue app。它只调用 get_startup_state / get_language、监听 startup-progress，
// 收到 ready 后卸载自己，再由 bootstrap/app.ts 创建并挂载主界面——主界面各 store 在 mount 时的 invoke
// 因而都发生在后端全局单例就绪之后，主界面代码不需要任何门控。
//
// 刻意不 app.use(i18n)：vue-i18n 在 app.unmount 时会 dispose 全局 composer 的 effect scope，
// 共用同一个 i18n 实例的主界面随后会失去语言响应性。这里直接用 i18n.global.t。
import { createApp, shallowRef } from "vue";
import { ElProgress } from "@kabegame/element-plus";
import { invoke, listen } from "@/api/rpc";
import { resolveBrowserLanguage, setLocale, tryResolveStoredLanguage } from "@kabegame/i18n";
import InitScreen from "@/views/InitScreen.vue";

export type StartupPhase =
  | { phase: "settings" }
  | { phase: "plugins" }
  | { phase: "schema"; version: number; name: string }
  | { phase: "backfill"; id: string; processed: number; total: number | null }
  | { phase: "services" }
  | { phase: "ready" }
  | { phase: "failed"; message: string };

/** 等到后端 ready 才 resolve；failed 永不 resolve，页面停在错误态（只能退出）。 */
export async function runInitScreen(): Promise<void> {
  const phase = shallowRef<StartupPhase>({ phase: "settings" });
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const apply = (next: StartupPhase) => {
    phase.value = next;
    if (next.phase === "ready") markReady();
  };

  // 先监听再取快照：两者之间到达的 ready 不会丢。
  const unlisten = await listen<StartupPhase>("startup-progress", (event) => apply(event.payload));
  try {
    apply(await invoke<StartupPhase>("get_startup_state"));
  } catch (error) {
    console.error("[init] get_startup_state failed:", error);
  }
  if (phase.value.phase === "ready") {
    unlisten();
    return;
  }

  try {
    const language = await invoke<string | null>("get_language");
    setLocale(tryResolveStoredLanguage(language) ?? resolveBrowserLanguage());
  } catch {
    // 读不到语言就用默认语言显示启动页，主界面会再按设置收敛。
  }

  const app = createApp(InitScreen, { phase });
  app.component("ElProgress", ElProgress);
  app.mount("#app");
  await ready;
  unlisten();
  app.unmount();
}
