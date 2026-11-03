/** WPE 脚本环境中没有的浏览器全局；仅在场景子 frame 上遮蔽。 */
export const SCRIPT_HIDDEN_GLOBALS = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "requestIdleCallback",
  "Worker",
  "SharedWorker",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "caches",
  "Intl",
  "WebAssembly",
  "parent",
  "self",
  "frames",
  "__TAURI_INTERNALS__",
  "window",
  "document",
  "top",
  "location",
] as const;

export type ScriptHiddenGlobal = (typeof SCRIPT_HIDDEN_GLOBALS)[number];

export function alignScriptEnvironment(
  child: Window,
  consoleOutput: { log(text: string): void; error(text: string): void },
  debug: (message: string) => void = () => {},
): void {
  const global = child as unknown as Record<string, unknown>;
  for (const name of SCRIPT_HIDDEN_GLOBALS) {
    try {
      if (!Reflect.deleteProperty(child, name)) {
        Object.defineProperty(child, name, { value: undefined, configurable: false });
      }
    } catch {
      // 同源 frame 的这些属性不可配置；保留原值并只记调试信息。
      debug(`场景脚本环境无法遮蔽 ${name}`);
    }
  }
  global.console = { log: consoleOutput.log, error: consoleOutput.error };
}
