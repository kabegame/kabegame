import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { compileModule, type ModuleInstance, type ScriptModule } from "./moduleFactory";
import { rewriteModule, type ModuleRewrite } from "./moduleRewrite";

/** 单测里的 realm：一个 vm 上下文，全局对象取 globalThis */
function makeRealm() {
  const context = vm.createContext({});
  const global = vm.runInContext("globalThis", context) as Record<string, unknown>;
  const run = <T = unknown>(code: string): T => vm.runInContext(code, context) as T;
  return { global, run };
}

type Realm = ReturnType<typeof makeRealm>;

function build(realm: Realm, source: string, libs: object[] = [], url = "kb://s.js"): ScriptModule {
  return compileModule(realm.global, rewriteModule(source, url), libs);
}

const sync = (module: ScriptModule): ModuleInstance => module.instantiate() as ModuleInstance;

/** 取一个抛出的值（realm 里的错误不是宿主的 Error 实例，toThrow(TypeError) 认不出） */
function thrown(fn: () => unknown): { name: string; message: string; error: unknown } {
  try {
    fn();
  } catch (error) {
    const e = error as { name: string; message: string };
    return { name: e.name, message: e.message, error };
  }
  throw new Error("没有抛错");
}

describe("工厂：顶层 this / arguments / import.meta / 动态 import", () => {
  it("顶层 this 为 undefined；arguments 抛 ReferenceError；typeof arguments 为 undefined", () => {
    const realm = makeRealm();
    const instance = sync(
      build(
        realm,
        [
          "export const t = this;",
          "export const tt = typeof this;",
          "export let args;",
          "try { arguments; } catch (e) { args = e.name + ': ' + e.message; }",
          "export const typ = typeof arguments;",
          "export const inner = (function () { return typeof this; })();", // 普通函数里的 this 不动（严格模式下 undefined）
          "export const arrow = (() => this)();",
        ].join("\n"),
      ),
    );
    expect(instance.read("t")).toBeUndefined();
    expect(instance.read("tt")).toBe("undefined");
    expect(instance.read("args")).toBe("ReferenceError: arguments is not defined");
    expect(instance.read("typ")).toBe("undefined");
    expect(instance.read("inner")).toBe("undefined");
    expect(instance.read("arrow")).toBeUndefined();
  });

  it("import.meta：对象、无键、原型 null、url 为 undefined；同实例同一个，不同实例不同", () => {
    const realm = makeRealm();
    const module = build(
      realm,
      [
        "export const m = import.meta;",
        "export const same = import.meta === m;",
        "export const keys = Object.keys(import.meta).length;",
        "export const own = Reflect.ownKeys(import.meta).length;",
        "export const proto = Object.getPrototypeOf(import.meta);",
        "export const url = import.meta.url;",
        "export const type = typeof import.meta;",
      ].join("\n"),
    );
    const a = sync(module);
    const b = sync(module);
    expect(a.read("type")).toBe("object");
    expect(a.read("same")).toBe(true);
    expect(a.read("keys")).toBe(0);
    expect(a.read("own")).toBe(0);
    expect(a.read("proto")).toBeNull();
    expect(a.read("url")).toBeUndefined();
    expect(a.read("m")).not.toBe(b.read("m"));
  });

  it("动态 import：同步返回 realm 的 Promise，之后 reject（Error: Not supported）", async () => {
    const realm = makeRealm();
    const instance = sync(
      build(
        realm,
        [
          "export const p = import('WEMath');",
          "export const q = import({ toString() { throw new RangeError('bad specifier'); } });",
          "export const sym = import(Symbol('s'));",
        ].join("\n"),
      ),
    );
    const RealmPromise = realm.run<Function>("Promise");
    const RealmError = realm.run<Function>("Error");
    const p = instance.read("p") as Promise<unknown>;
    expect(p).toBeInstanceOf(RealmPromise);
    const error = (await p.then(
      () => null,
      (e: unknown) => e,
    )) as { name: string; message: string };
    expect(error).toBeInstanceOf(RealmError);
    expect(error.name).toBe("Error");
    expect(error.message).toBe("Not supported");
    // 说明符的 String() 抛错时，以那个错误 reject
    const q = (await (instance.read("q") as Promise<unknown>).then(
      () => null,
      (e: unknown) => e,
    )) as { name: string; message: string };
    expect(q.name).toBe("RangeError");
    expect(q.message).toBe("bad specifier");
    // Symbol 的 String() 不抛，同样 Not supported
    const sym = (await (instance.read("sym") as Promise<unknown>).then(
      () => null,
      (e: unknown) => e,
    )) as { message: string };
    expect(sym.message).toBe("Not supported");
  });
});

describe("工厂：模块命名空间", () => {
  const SOURCE = [
    "export let cnt = 0;",
    "export function upd() { cnt++; }",
    "export function init() {}",
    "export const V = 1;",
    "export default function () {}",
  ].join("\n");

  it("形状：toStringTag、键序、原型、可扩展性、描述符", () => {
    const realm = makeRealm();
    const instance = sync(build(realm, SOURCE));
    const ns = instance.namespace;
    expect(Object.prototype.toString.call(ns)).toBe("[object Module]");
    expect(Object.keys(ns)).toEqual(["V", "cnt", "default", "init", "upd"]);
    expect(Object.getPrototypeOf(ns)).toBeNull();
    expect(Object.isExtensible(ns)).toBe(false);
    expect(ns[Symbol.toStringTag as unknown as string]).toBe("Module");
    expect(Reflect.ownKeys(ns)).toEqual(["V", "cnt", "default", "init", "upd", Symbol.toStringTag]);
    const tag = Object.getOwnPropertyDescriptor(ns, Symbol.toStringTag)!;
    expect(tag).toEqual({ value: "Module", writable: false, enumerable: false, configurable: false });
    expect("cnt" in ns).toBe(true);
    expect("nope" in ns).toBe(false);
    expect(ns.nope).toBeUndefined();
    expect(Reflect.defineProperty(ns, "x", { value: 1 })).toBe(false);
    expect(Reflect.deleteProperty(ns, "cnt")).toBe(false);
    expect(Reflect.deleteProperty(ns, "nope")).toBe(true);
    expect(Reflect.setPrototypeOf(ns, null)).toBe(true);
    expect(Reflect.setPrototypeOf(ns, {})).toBe(false);
  });

  it("活绑定、写入抛 TypeError、描述符逐字", () => {
    const realm = makeRealm();
    const instance = sync(build(realm, SOURCE));
    const ns = instance.namespace;
    expect(ns.cnt).toBe(0);
    (instance.read("upd") as () => void)();
    expect(ns.cnt).toBe(1);
    expect(instance.read("cnt")).toBe(1);
    const write = thrown(() => {
      ns.cnt = 5;
    });
    expect(write.name).toBe("TypeError");
    expect(write.message).toBe("Cannot assign to property 'cnt' of [object Module]");
    expect(write.error).toBeInstanceOf(realm.run<Function>("TypeError"));
    const symbolWrite = thrown(() => {
      (ns as Record<symbol, unknown>)[Symbol.iterator] = 1;
    });
    expect(symbolWrite.message).toBe("Cannot assign to property 'Symbol(Symbol.iterator)' of [object Module]");
    expect(JSON.stringify(Object.getOwnPropertyDescriptor(ns, "cnt"))).toBe(
      '{"value":1,"writable":true,"enumerable":true,"configurable":false}',
    );
    // 经命名空间调用，this 不影响（模块函数不依赖 this）
    (ns.upd as () => void).call(ns);
    expect(ns.cnt).toBe(2);
  });

  it("暂时性死区：命名空间读未初始化的绑定抛 ReferenceError（read、Object.keys 同样）", () => {
    const realm = makeRealm();
    // 手写工厂源码：在 let 之前就把命名空间建出来，经 lib(0) 交给测试
    const rewrite: ModuleRewrite = {
      source: [
        "'use strict';((P) => {",
        'const early = P.ns([["x", () => x]],[],[],null);',
        "P.lib(0).escape(early);",
        "let x = 1;",
        "return early;",
        "})",
      ].join("\n"),
      specifiers: ["chan"],
      async: false,
    };
    const reads: string[] = [];
    let early: ModuleInstance | undefined;
    const probe = {
      escape(value: ModuleInstance) {
        early = value;
        reads.push(thrown(() => value.namespace.x).name);
        reads.push(thrown(() => value.read("x")).name);
        reads.push(thrown(() => Object.keys(value.namespace)).name);
      },
    };
    const final = compileModule(realm.global, rewrite, [probe]).instantiate() as ModuleInstance;
    expect(reads).toEqual(["ReferenceError", "ReferenceError", "ReferenceError"]);
    // 初始化之后同一个命名空间读得到
    expect(early!.namespace.x).toBe(1);
    expect(final.read("x")).toBe(1);
  });

  it("export default 匿名函数 / 类的 name 是 default；类自己的静态 name 不动", () => {
    const realm = makeRealm();
    const name = (source: string) => (sync(build(realm, source)).read("default") as { name: unknown }).name;
    expect(name("export default function () {}")).toBe("default");
    expect(name("export default async function () {}")).toBe("default");
    expect(name("export default function* () {}")).toBe("default");
    expect(name("export default async function* () {}")).toBe("default");
    expect(name("export default (function () {})")).toBe("default");
    expect(name("export default () => {}")).toBe("default");
    expect(name("export default (class {})")).toBe("default");
    expect(name("export default class {}")).toBe("default");
    expect(typeof name("export default class { static name() {} }")).toBe("function");
    expect(name("export default class { static name = 'mine'; }")).toBe("mine");
    // 有名字的不改；别的表达式不改
    expect(name("export default function f() {}")).toBe("f");
    expect(name("export default class C {}")).toBe("C");
    expect(name("export default (function g() {})")).toBe("g");
    expect(name("function h() {} export default h;")).toBe("h");
    // name 的其它属性保持（不可写、可配置）
    const fn = sync(build(realm, "export default function () {}")).read("default");
    expect(Object.getOwnPropertyDescriptor(fn, "name")).toEqual({
      value: "default",
      writable: false,
      enumerable: false,
      configurable: true,
    });
  });

  it("export default 匿名函数在声明之前就能用（提升）", () => {
    const realm = makeRealm();
    const instance = sync(
      build(realm, "export const r = typeof d;\nexport default function () { return 7; }\nfunction d() {}"),
    );
    expect(instance.read("r")).toBe("function");
    expect((instance.read("default") as () => number)()).toBe(7);
  });

  it("改名导出与字符串导出名", () => {
    const realm = makeRealm();
    const instance = sync(
      build(
        realm,
        "function upd() { return 'u'; }\nlet k = 3;\nexport { upd as update, k as 'str name', k as default };",
      ),
    );
    const update = instance.read("update") as () => string;
    expect(update()).toBe("u");
    expect(update.name).toBe("upd");
    expect(instance.read("str name")).toBe(3);
    expect(instance.read("default")).toBe(3);
    expect(Object.keys(instance.namespace)).toEqual(["default", "str name", "update"]);
    expect(instance.read("upd")).toBeUndefined();
    expect(instance.read("nope")).toBeUndefined();
  });

  it("导出名多个声明符与解构", () => {
    const realm = makeRealm();
    const instance = sync(
      build(
        realm,
        "const o = { x: 1, y: 2 }, r = [3, 4, 5];\nexport let a = 1, b = 2;\nexport const { x, y: z } = o, [p, ...q] = r;",
      ),
    );
    expect(Object.keys(instance.namespace)).toEqual(["a", "b", "p", "q", "x", "z"]);
    expect(instance.read("z")).toBe(2);
    expect(Array.from(instance.read("q") as number[])).toEqual([4, 5]);
  });
});

describe("工厂：库、再导出与星号", () => {
  it("导入：具名 / 默认 / 改名 / 命名空间；同一个库两次是同一个对象", () => {
    const realm = makeRealm();
    const lib = realm.run<object>(
      "Object.freeze({ mix(a, b, t) { return a + (b - a) * t; }, deg2rad: 0.5, default: 'LD', 'a-b': 9 })",
    );
    const module = build(
      realm,
      "import D, { mix, deg2rad as d2r, 'a-b' as ab } from 'WEMath';\nimport * as W from 'WEMath';\nexport const v = [mix(0, 10, 0.5), d2r, D, ab];\nexport const w = W;",
      [lib],
    );
    const a = sync(module);
    const b = sync(module);
    expect(Array.from(a.read("v") as unknown[])).toEqual([5, 0.5, "LD", 9]);
    expect(a.read("w")).toBe(lib);
    expect(b.read("w")).toBe(lib);
  });

  it("对导入绑定赋值抛 TypeError: Assignment to constant variable.", () => {
    const realm = makeRealm();
    const lib = realm.run<object>("Object.freeze({ mix: 1 })");
    const error = thrown(() => sync(build(realm, "import { mix } from 'L';\nmix = 2;", [lib])));
    expect(error.name).toBe("TypeError");
    expect(error.message).toBe("Assignment to constant variable.");
  });

  it("星号再导出：本地优先、不同库同名有歧义被去掉、default 不经星号", () => {
    const realm = makeRealm();
    const A = realm.run<object>("Object.freeze({ a: 1, b: 2, shared: 'A', same: 's', default: 'dA' })");
    const B = realm.run<object>("Object.freeze({ c: 3, shared: 'B' })");
    const instance = sync(build(realm, "export * from 'A';\nexport * from 'B';\nexport const b = 99;", [A, B]));
    expect(Object.keys(instance.namespace)).toEqual(["a", "b", "c", "same"]);
    expect(instance.read("b")).toBe(99);
    expect(instance.read("a")).toBe(1);
    expect(instance.read("c")).toBe(3);
    expect(instance.read("shared")).toBeUndefined();
    expect("shared" in instance.namespace).toBe(false);
    expect("default" in instance.namespace).toBe(false);
  });

  it("同一个库经两个说明符星号再导出不算歧义", () => {
    const realm = makeRealm();
    const A = realm.run<object>("Object.freeze({ a: 1 })");
    const instance = sync(build(realm, "export * from 'A1';\nexport * from 'A2';", [A, A]));
    expect(Object.keys(instance.namespace)).toEqual(["a"]);
  });

  it("export * as N、export { a as b } from、export { default as d } from", () => {
    const realm = makeRealm();
    const A = realm.run<object>("Object.freeze({ a: 1, default: 'dA' })");
    const instance = sync(build(realm, "export * as V from 'A';\nexport { a as b, default as dd } from 'A';", [A]));
    expect(Object.keys(instance.namespace)).toEqual(["V", "b", "dd"]);
    expect(instance.read("V")).toBe(A);
    expect(instance.read("b")).toBe(1);
    expect(instance.read("dd")).toBe("dA");
    expect(instance.namespace.V).toBe(A);
  });

  it("再导出另一个 compileModule 编出来的命名空间", () => {
    const realm = makeRealm();
    const lib = sync(build(realm, "export const x = 1;\nexport function f() { return 2; }", [], "kb://lib.js"));
    const instance = sync(
      build(realm, "import { x, f } from 'lib';\nexport * from 'lib';\nexport const y = x + f();", [lib.namespace]),
    );
    expect(Object.keys(instance.namespace)).toEqual(["f", "x", "y"]);
    expect(instance.read("y")).toBe(3);
  });
});

describe("工厂：实例化", () => {
  it("同一个 ScriptModule 实例化两次，模块级状态互不影响", () => {
    const realm = makeRealm();
    const module = build(realm, "export let n = 0;\nexport function inc() { return ++n; }");
    const a = sync(module);
    const b = sync(module);
    expect((a.read("inc") as () => number)()).toBe(1);
    expect((a.read("inc") as () => number)()).toBe(2);
    expect(b.read("n")).toBe(0);
    expect((b.read("inc") as () => number)()).toBe(1);
    expect(a.read("n")).toBe(2);
    expect(a.namespace).not.toBe(b.namespace);
  });

  it("顶层 await：同步跑到第一个 await，await 之后的代码跑完才 resolve", async () => {
    const realm = makeRealm();
    const lib = realm.run<{ trace: string[] }>("({ trace: [] })");
    const module = build(
      realm,
      "import { trace } from 'L';\ntrace.push('a');\nawait null;\ntrace.push('b');\nawait new Promise((r) => r());\ntrace.push('c');\nexport const done = true;",
      [lib],
    );
    expect(module.async).toBe(true);
    const pending = module.instantiate();
    expect(pending).toBeInstanceOf(realm.run<Function>("Promise"));
    expect(Array.from(lib.trace)).toEqual(["a"]);
    const instance = await pending;
    expect(Array.from(lib.trace)).toEqual(["a", "b", "c"]);
    expect(instance.read("done")).toBe(true);
  });

  it("顶层 for await", async () => {
    const realm = makeRealm();
    const module = build(realm, "export let sum = 0;\nfor await (const v of [1, Promise.resolve(2)]) sum += v;");
    expect(module.async).toBe(true);
    const instance = await module.instantiate();
    expect(instance.read("sum")).toBe(3);
  });

  it("同步模块的 instantiate 返回实例而不是 Promise", () => {
    const realm = makeRealm();
    const module = build(realm, "export const a = 1;");
    expect(module.async).toBe(false);
    expect(typeof (module.instantiate() as ModuleInstance).read).toBe("function");
  });

  it("库数量与说明符不一致、源码不是工厂时抛错", () => {
    const realm = makeRealm();
    expect(() => compileModule(realm.global, rewriteModule("import 'a';", "u"), [])).toThrow(/不一致/);
    expect(() => compileModule(realm.global, { source: "1", specifiers: [], async: false }, [])).toThrow(/不是函数/);
  });
});

describe("工厂：报错位置", () => {
  it("模块里第 k 行抛出的错误，stack 里是 <sourceUrl>:<k + 2>:", () => {
    const realm = makeRealm();
    const source = ["import { a } from 'L';", "export let b = 1;", "", "// 注释", "throw new Error('boom');"].join(
      "\n",
    );
    const lib = realm.run<object>("Object.freeze({ a: 1 })");
    const error = thrown(() => sync(build(realm, source, [lib], "kabegame-script:1")));
    expect(error.message).toBe("boom");
    const stack = (error.error as { stack: string }).stack;
    expect(stack).toContain("kabegame-script:1:7:");
  });

  it("回调里（模块函数）抛出的错误同样按偏移定位", () => {
    const realm = makeRealm();
    const instance = sync(
      build(realm, "export function go() {\n  const x = 1;\n  throw new Error('late');\n}", [], "kabegame-script:2"),
    );
    const error = thrown(() => (instance.read("go") as () => void)());
    expect((error.error as { stack: string }).stack).toContain("kabegame-script:2:5:9");
  });
});
