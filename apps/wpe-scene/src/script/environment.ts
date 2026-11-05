/**
 * 与 WPE 同名但语义不同的全局，改写成 WPE 的形状；其余浏览器全局照常保留（环境对齐不是安全边界，3b 已定 4 / 3c 已定 4）。
 *
 * 子 frame 与宿主同一 `file:` 来源、同一份存储，`localStorage` 的读写一律经调用方传进来的 WPE 对象
 * （`script/storage.ts` 按场景前缀隔离）；子 frame 的全局名只用来挂这个对象。
 * 3b 步骤 0 已实测子 frame 的 `localStorage` 可删、可重定义。
 */
export function alignScriptEnvironment(
  child: Window,
  consoleOutput: { log(text: string): void; error(text: string): void },
  localStorage: object,
): void {
  const global = child as unknown as Record<string, unknown>;
  global.console = { log: consoleOutput.log, error: consoleOutput.error };
  Object.defineProperty(child, "localStorage", {
    value: localStorage,
    configurable: true,
    writable: false,
  });
}
