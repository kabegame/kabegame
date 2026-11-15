import vm from "node:vm";
import { compileModule, type ScriptModule } from "../moduleFactory";
import { rewriteModule } from "../moduleRewrite";

/**
 * 测试用的真 realm 替身：一个 Node vm 上下文，`prepareModule` 走真的 `rewriteModule` + `compileModule`
 * （同源码缓存同一个 ScriptModule，同 `createIframeRealm`），没有库（不支持 import 说明符）。
 */
export function vmRealm() {
  const context = vm.createContext({});
  const global = vm.runInContext("globalThis", context) as Record<string, unknown>;
  const run = <T = unknown>(code: string): T => vm.runInContext(code, context) as T;
  const modules = new Map<string, Promise<ScriptModule>>();
  let sequence = 0;
  return {
    global,
    run,
    prepareModule(source: string, _label: string): Promise<ScriptModule> {
      let task = modules.get(source);
      if (!task) {
        task = Promise.resolve().then(() =>
          compileModule(global, rewriteModule(source, `kabegame-script:${++sequence}`), []),
        );
        modules.set(source, task);
      }
      return task;
    },
  };
}
