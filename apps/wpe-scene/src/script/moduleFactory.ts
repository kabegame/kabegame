// 把 moduleRewrite 产出的工厂源码在 realm 里编成可重复实例化的模块。
//
// 工厂参数 `P` 的协议（与 moduleRewrite.ts 约定，`P.ns` 的参数见那里的注释）：
//   P.lib(i)          第 i 个说明符对应的库命名空间（每次实例化拿到同一批对象）
//   P.meta()          一个新的 import.meta：原型为 null、没有任何键
//   P.dynamicImport   动态 import()：一律返回 reject 的 Promise（Error: Not supported）
//   P.ns(…)           建模块命名空间，返回 ModuleInstance
//
// 所有会被脚本看到的对象 / 函数 / 错误（Promise、Error、TypeError、Proxy、import.meta）都在 realm 里建：
// 辅助函数写成一段 JS 源码，用 realm 的 eval 求值一次、按 realm 全局缓存。
import type { ModuleRewrite } from "./moduleRewrite";

export interface ModuleInstance {
  /** 照 WPE 的模块命名空间（realm 里的 Proxy）：回调的 this、诊断的导出名、updateScriptProperties 的参数 */
  readonly namespace: Record<string, unknown>;
  /** 宿主自己取导出（不经 Proxy，现取活绑定；暂时性死区照常抛） */
  read(name: string): unknown;
}

export interface ScriptModule {
  readonly async: boolean;
  /** 同步求值一次模块顶层，得到一份新的模块状态；async 模块返回 Promise（顶层 await 结束才 resolve） */
  instantiate(): ModuleInstance | Promise<ModuleInstance>;
}

interface RealmHelpers {
  makeParam(libs: readonly object[]): object;
}

// 在 realm 里求值的辅助源码。先把要用的内建捕获到局部，之后脚本改全局也影响不到。
const HELPER_SOURCE = `(() => {
  "use strict";
  const create = Object.create;
  const defineProperty = Object.defineProperty;
  const getOwn = Object.getOwnPropertyDescriptor;
  const objectKeys = Object.keys;
  const preventExt = Object.preventExtensions;
  const reflectOwnKeys = Reflect.ownKeys;
  const NewProxy = Proxy;
  const NewMap = Map;
  const ErrorCtor = Error;
  const TypeErrorCtor = TypeError;
  const toStr = String;
  const reject = Promise.reject.bind(Promise);
  const TAG = Symbol.toStringTag;

  const dynamicImport = function dynamicImport(specifier) {
    try {
      toStr(specifier);
    } catch (error) {
      return reject(error);
    }
    return reject(new ErrorCtor("Not supported"));
  };

  const buildNamespace = (locals, reexports, stars, defaultName, libs) => {
    // 导出名 -> 取值函数；本地导出与具名再导出优先于星号
    const getters = new NewMap();
    for (const [name, getter] of locals) getters.set(name, getter);
    for (const [name, index, imported] of reexports) {
      const lib = libs[index];
      getters.set(name, imported === "*" ? () => lib : () => lib[imported]);
    }
    // 星号再导出：default 不经星号；来自不同库的同名项有歧义，去掉
    const starNames = new NewMap();
    for (const index of stars) {
      const lib = libs[index];
      for (const name of objectKeys(lib)) {
        if (name === "default" || getters.has(name)) continue;
        const previous = starNames.get(name);
        if (previous === undefined) starNames.set(name, index);
        else if (previous !== -1 && libs[previous] !== lib) starNames.set(name, -1);
      }
    }
    for (const [name, index] of starNames) {
      if (index !== -1) getters.set(name, () => libs[index][name]);
    }
    // 匿名默认值：name 还是生成名时改成 "default"（类自己定义了静态 name 的，值不是生成名，不动）
    if (defaultName !== null) {
      const value = getters.get("default")();
      if (typeof value === "function") {
        const descriptor = getOwn(value, "name");
        if (descriptor && descriptor.value === defaultName) defineProperty(value, "name", { value: "default" });
      }
    }

    const target = create(null);
    for (const name of [...getters.keys()].sort()) {
      defineProperty(target, name, { value: undefined, writable: true, enumerable: true, configurable: false });
    }
    defineProperty(target, TAG, { value: "Module", writable: false, enumerable: false, configurable: false });
    preventExt(target);

    const isExport = (key) => (typeof key === "symbol" ? key === TAG : getters.has(key));
    const handler = {
      get(_target, key) {
        if (typeof key === "symbol") return key === TAG ? "Module" : undefined;
        const getter = getters.get(key);
        return getter === undefined ? undefined : getter();
      },
      getOwnPropertyDescriptor(t, key) {
        if (typeof key === "symbol") return key === TAG ? getOwn(t, TAG) : undefined;
        const getter = getters.get(key);
        if (getter === undefined) return undefined;
        return { value: getter(), writable: true, enumerable: true, configurable: false };
      },
      set(_target, key) {
        throw new TypeErrorCtor("Cannot assign to property '" + toStr(key) + "' of [object Module]");
      },
      defineProperty() {
        return false;
      },
      // toStringTag 同样不可配置，Proxy 不变量要求它也返回 false
      deleteProperty(_target, key) {
        return !isExport(key);
      },
      has(_target, key) {
        return isExport(key);
      },
      ownKeys(t) {
        return reflectOwnKeys(t);
      },
      getPrototypeOf() {
        return null;
      },
      setPrototypeOf(_target, prototype) {
        return prototype === null;
      },
      isExtensible() {
        return false;
      },
      preventExtensions() {
        return true;
      },
    };
    return {
      namespace: new NewProxy(target, handler),
      read(name) {
        const getter = getters.get(name);
        return getter === undefined ? undefined : getter();
      },
    };
  };

  return {
    makeParam(libs) {
      return {
        lib(index) {
          return libs[index];
        },
        meta() {
          return create(null);
        },
        dynamicImport,
        ns(locals, reexports, stars, defaultName) {
          return buildNamespace(locals, reexports, stars, defaultName, libs);
        },
      };
    },
  };
})()`;

const helperCache = new WeakMap<object, RealmHelpers>();

/**
 * 在 realm 全局 `global`（浏览器 iframe 的 window，或单测里 Node vm 上下文的全局）里编工厂：间接 eval `rewrite.source`。
 * `libs` 与 `rewrite.specifiers` 一一对应，是库的模块命名空间。编译失败（SyntaxError 等）直接抛。
 */
export function compileModule(
  global: Record<string, unknown>,
  rewrite: ModuleRewrite,
  libs: readonly object[],
): ScriptModule {
  if (libs.length !== rewrite.specifiers.length) {
    throw new Error(`场景脚本工厂：库数量 ${libs.length} 与说明符数量 ${rewrite.specifiers.length} 不一致`);
  }
  // 局部变量名不叫 eval：这样是间接 eval，在 realm 的全局作用域求值
  const evaluate = global.eval as (source: string) => unknown;
  let helpers = helperCache.get(global);
  if (!helpers) {
    helpers = evaluate(HELPER_SOURCE) as RealmHelpers;
    helperCache.set(global, helpers);
  }
  const factory = evaluate(rewrite.source);
  if (typeof factory !== "function") throw new Error("场景脚本工厂：源码求值结果不是函数");
  const makeParam = helpers.makeParam;
  return {
    async: rewrite.async,
    instantiate() {
      return (factory as (param: object) => ModuleInstance | Promise<ModuleInstance>)(makeParam(libs));
    },
  };
}
