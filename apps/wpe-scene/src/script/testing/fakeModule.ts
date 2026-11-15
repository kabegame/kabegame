import type { ModuleInstance, ScriptModule } from "../moduleFactory";

/** 测试用：把一个现成的导出对象包成 ScriptModule（instantiate 每次返回同一个对象，命名空间就是它本身）。 */
export function fakeModule(exports: Record<string, unknown>): ScriptModule {
  const instance: ModuleInstance = { namespace: exports, read: (name) => exports[name] };
  return { async: false, instantiate: () => instance };
}
