import { describe, expect, it } from "vitest";
import { FACTORY_LINE_OFFSET, rewriteModule } from "./moduleRewrite";

interface Protocol {
  locals: Array<[string, string]>;
  reexports: Array<[string, number, string]>;
  stars: number[];
  defaultName: string | null;
}

/** 执行工厂源码里的 `;return P.ns(…)` 一行，抓出 P.ns 的四个参数（取值函数不调，只看文本） */
function protocolOf(source: string): Protocol {
  const line = source.split("\n").find((l) => l.startsWith(";return "))!;
  const param = /^;return (\S+?)\.ns\(/.exec(line)![1];
  let captured: Protocol | undefined;
  const fake = {
    ns(
      locals: Array<[string, () => unknown]>,
      reexports: Array<[string, number, string]>,
      stars: number[],
      defaultName: string | null,
    ) {
      captured = {
        locals: locals.map(([name, getter]) => [name, /=>(.*)$/s.exec(String(getter))![1].trim()]),
        reexports,
        stars,
        defaultName,
      };
    },
  };
  new Function(param, line.slice(1))(fake);
  return captured!;
}

const exportNames = (rewrite: { source: string }): string[] => {
  const p = protocolOf(rewrite.source);
  return [...p.locals.map((e) => e[0]), ...p.reexports.map((e) => e[0])].sort();
};

/** 原文每行与工厂源码对应行（+偏移）等长，且 mark 开头的词位置完全一致 */
function expectAligned(source: string) {
  const { source: factory } = rewriteModule(source, "x://t");
  const original = source.split("\n");
  const lines = factory.split("\n");
  original.forEach((text, index) => {
    const mapped = lines[index + FACTORY_LINE_OFFSET];
    expect(mapped.length, `第 ${index + 1} 行长度`).toBe(text.length);
    for (const match of text.matchAll(/\bmark\w*/g)) {
      expect(mapped.slice(match.index, match.index! + match[0].length), `${match[0]} 位置`).toBe(match[0]);
    }
  });
  return factory;
}

describe("rewriteModule 行列对齐", () => {
  const fixtures: Record<string, string> = {
    "注释夹在 export 与声明之间":
      "export /* c\n  c2 */ function mark1() {}\nexport /* x */ let mark2 = 1, mark3 = 2;\nmark1(mark2, mark3);",
    多行导入: "import {\n  a,\n  b as q4,\n} from 'lib';\nimport * as q5 from 'lib2';\nmark4(a, q4, q5, mark5);",
    "默认导入 + 字符串导入名": "import q6, { 'a-b' as ab } from 'lib';\nmark6(ab, q6);",
    "export default 表达式": "export default (mark7 + 1);\nlet mark8;",
    "export default 紧贴括号": "export default(1);\nlet mark9;",
    "export default 匿名函数": "export default function () { return mark10; }\nvar mark10 = 1;",
    "export default async 生成器": "export default async function* (a) { yield mark11; }\nvar mark11;",
    "export default 匿名类": "export default class { mark12() {} }\nlet mark13;",
    "export default 有名函数": "export default function mark14() {}\nlet mark15;",
    "export default 箭头": "export default () => {\n  return mark16;\n};\nvar mark16;",
    "import.meta 与动态 import": "const mark17 = import.meta;\nconst mark18 = import ('x');\nmark17; mark18;",
    "顶层 this":
      "const mark19 = this;\nconst mark20 = () => this;\nfunction f() { return this; }\nclass C { mark21 = this; static { this; } }\nmark19;",
    hashbang: "#!/usr/bin/env node\nconst mark22 = 1;\nlet qq;\nexport { qq };\nmark22b;",
    "export 列表与再导出":
      "const mark23 = 1;\nexport { q23 as a, q23 as 'str name' };\nlet q23 = mark23;\nexport * from 'x';\nexport * as N from 'y';\nexport { q as r } from 'z';",
    "顶层 await": "const mark24 = await 1;\nfor await (const x of []) { }\nexport { q24 };\nlet q24 = mark24;",
    "export default 括号跨行": "export default\n(\n  mark25\n);\nvar mark25;",
    "export default 跨行但放得下": "export default\n/* c */ function () {}\nvar mark26;",
  };
  for (const [name, source] of Object.entries(fixtures)) {
    it(name, () => {
      expectAligned(source);
    });
  }

  it("前言与布局：第 1 行包装头、第 2 行前言、之后返回导出表", () => {
    const { source } = rewriteModule("import * as W from 'WEMath';\nexport var a = 1;\n", "x://t.js");
    const lines = source.split("\n");
    expect(lines[0]).toMatch(/^'use strict';\(\(\S+\) => \{$/);
    expect(lines[1]).toMatch(/^const W=\S+\.lib\(0\);$/);
    expect(lines[lines.length - 1]).toBe("//# sourceURL=x://t.js");
    expect(lines[lines.length - 2]).toBe("})");
    expect(lines[lines.length - 3]).toMatch(/^;return \S+\.ns\(/);
  });

  it("导入语句本身被替换成空白", () => {
    const { source } = rewriteModule("import { a } from 'lib';\nexport var b = a;", "u");
    const lines = source.split("\n");
    expect(lines[2].trim()).toBe("");
    expect(lines[3]).toBe("       var b = a;");
  });

  it("具名 / 默认 / 命名空间导入的前言", () => {
    const { source, specifiers } = rewriteModule(
      "import D0, { mix, 'a-b' as ab } from 'm';\nimport * as W from 'm';\nimport 'side';\nimport { z } from 'm2';",
      "u",
    );
    expect(specifiers).toEqual(["m", "side", "m2"]);
    const preamble = source.split("\n")[1];
    expect(preamble).toContain('const {default:D0,mix:mix,"a-b":ab}=');
    expect(preamble).toContain(".lib(0);");
    expect(preamble).toContain("const W=");
    expect(preamble).toContain("const {z:z}=");
    expect(preamble).toContain(".lib(2);");
    // 副作用导入什么都不写
    expect(preamble).not.toContain(".lib(1)");
  });
});

describe("rewriteModule 导出名与说明符", () => {
  it("多个声明符与解构模式取全部绑定名", () => {
    const r = rewriteModule(
      "export let a = 1, b = 2;\nexport const { x, y: z, w = 3, ...rest } = o, [p, , ...q] = r, { n: [m = 1] } = s;\nexport function f() {}\nexport async function g() {}\nexport function* h() {}\nexport class C {}\nexport var v;",
      "u",
    );
    expect(exportNames(r)).toEqual(["C", "a", "b", "f", "g", "h", "m", "p", "q", "rest", "v", "w", "x", "z"].sort());
  });

  it("export { … } 的改名、default、字符串导出名", () => {
    const r = rewriteModule("let k = 1;\nexport { k, k as kk, k as default, k as 'str name' };", "u");
    const p = protocolOf(r.source);
    expect(p.locals).toEqual([
      ["k", "k"],
      ["kk", "k"],
      ["default", "k"],
      ["str name", "k"],
    ]);
    expect(p.defaultName).toBeNull();
  });

  it("export default 各形式的导出与匿名标志", () => {
    const named = protocolOf(rewriteModule("export default function f() {}", "u").source);
    expect(named.locals).toEqual([["default", "f"]]);
    expect(named.defaultName).toBeNull();
    const namedClass = protocolOf(rewriteModule("export default class C {}", "u").source);
    expect(namedClass.locals).toEqual([["default", "C"]]);
    expect(namedClass.defaultName).toBeNull();
    for (const code of [
      "export default function () {}",
      "export default async function () {}",
      "export default function* () {}",
      "export default async function* () {}",
      "export default class {}",
      "export default (function () {})",
      "export default async () => 1",
      "export default (class {})",
    ]) {
      const p = protocolOf(rewriteModule(code, "u").source);
      expect(
        p.locals.map((e) => e[0]),
        code,
      ).toEqual(["default"]);
      expect(p.defaultName, code).toBe(p.locals[0][1]);
    }
    // 非匿名函数 / 普通表达式不标记
    for (const code of [
      "export default (function f() {})",
      "export default foo",
      "export default 1 + 2",
      "var foo; export default (foo)",
    ]) {
      expect(protocolOf(rewriteModule(code, "u").source).defaultName, code).toBeNull();
    }
  });

  it("匿名默认声明改成带名字的同类声明", () => {
    const r = rewriteModule("export default async function* (a) {}", "u");
    const body = r.source.split("\n")[2];
    expect(body).toMatch(/^async function\* \S+ +\(a\) \{\}$/);
    expect(r.source.split("\n")[1]).not.toContain("let "); // 不再 let 声明
    const cls = rewriteModule("export default class { }", "u").source.split("\n")[2];
    expect(cls).toMatch(/^class \S+ +\{ \}$/);
  });

  it("export default 表达式在前言里 let 声明、原位变成赋值", () => {
    const r = rewriteModule("export default(1)", "u");
    const lines = r.source.split("\n");
    expect(lines[1]).toMatch(/^let (\S+);$/);
    const name = /^let (\S+);$/.exec(lines[1])![1];
    expect(lines[2].startsWith(`${name}=`)).toBe(true);
    expect(lines[2].endsWith("(1)")).toBe(true);
    expect(lines[2].length).toBe("export default(1)".length);
  });

  it("再导出与星号", () => {
    const r = rewriteModule(
      "export * from 'a';\nexport * as N from 'b';\nexport { x as y, z } from 'a';\nexport * from 'c';\nexport * from 'a';\nimport 'd';\nimport { q } from 'b';",
      "u",
    );
    expect(r.specifiers).toEqual(["a", "b", "c", "d"]);
    const p = protocolOf(r.source);
    expect(p.stars).toEqual([0, 2]);
    expect(p.reexports).toEqual([
      ["N", 1, "*"],
      ["y", 0, "x"],
      ["z", 0, "z"],
    ]);
  });

  it("说明符按源码顺序去重（导入与再导出混合）", () => {
    const r = rewriteModule(
      "import b from 'B';\nexport { a } from 'A';\nimport { c } from 'B';\nexport * from 'C';",
      "u",
    );
    expect(r.specifiers).toEqual(["B", "A", "C"]);
  });

  it("导出名可以叫 __proto__", () => {
    const p = protocolOf(rewriteModule("let a = 1; export { a as __proto__ };", "u").source);
    expect(p.locals).toEqual([["__proto__", "a"]]);
  });
});

describe("rewriteModule async 判定", () => {
  it("顶层 await 与 for await", () => {
    expect(rewriteModule("await 1;", "u").async).toBe(true);
    expect(rewriteModule("const a = (await 1) + 1;", "u").async).toBe(true);
    expect(rewriteModule("for await (const x of y) {}", "u").async).toBe(true);
    expect(rewriteModule("if (a) { await b(); }", "u").async).toBe(true);
    expect(rewriteModule("await 1;", "u").source.startsWith("'use strict';(async (")).toBe(true);
  });
  it("函数 / 箭头 / 类成员里的 await 不算", () => {
    expect(rewriteModule("async function f() { await 1; for await (const x of y) {} }", "u").async).toBe(false);
    expect(rewriteModule("const f = async () => { await 1; };", "u").async).toBe(false);
    expect(
      rewriteModule("class C { async m() { await 1; } static { (async () => { await 1; })(); } }", "u").async,
    ).toBe(false);
    expect(rewriteModule("const o = { async m() { await 1; } };", "u").async).toBe(false);
    expect(rewriteModule("export var a;", "u").source.startsWith("'use strict';((")).toBe(true);
  });
});

describe("rewriteModule 顶层 this / import.meta / 动态 import", () => {
  it("只替换顶层 this", () => {
    const r = rewriteModule(
      "var a = this;\nvar b = () => this;\nfunction f() { return this; }\nclass C { x = this; static { this; } m() { return this; } static [this.k] = 1; }\nclass D extends this.B {}\nvar o = { g() { return this; }, get h() { return this; } };",
      "u",
    );
    const body = r.source.split("\n").slice(2);
    expect(body[0]).not.toContain("this");
    expect(body[1]).not.toContain("this");
    expect(body[2]).toContain("this");
    // 类字段初值、静态块、方法里的 this 不动；计算键 [this.k] 属于外层，被替换
    expect(body[3]).toContain("x = this");
    expect(body[3]).toContain("static { this; }");
    expect(body[3]).toContain("m() { return this; }");
    expect(body[3]).not.toContain("[this.k]");
    expect(body[4]).not.toContain("this");
    expect(body[5].match(/this/g)!.length).toBe(2);
    expect(r.source.split("\n")[1]).toMatch(/const \S{4}=void 0;/);
  });

  it("import.meta 是 11 字标识符，import( 是 6 字标识符", () => {
    const r = rewriteModule("const m = import.meta;\nimport('x');", "u");
    const lines = r.source.split("\n");
    expect(lines[1]).toMatch(/const (\S{11})=\S+\.meta\(\);/);
    expect(lines[1]).toMatch(/const (\S{6})=\S+\.dynamicImport;/);
    expect(lines[2]).not.toContain("import");
    // 动态 import 不进说明符
    expect(r.specifiers).toEqual([]);
  });

  it("hashbang 换成 //", () => {
    const r = rewriteModule("#!/x/y\nvar a;", "u");
    expect(r.source.split("\n")[2]).toBe("///x/y");
  });
});

describe("rewriteModule 生成标识符避开原文", () => {
  const names = (source: string) => {
    const r = rewriteModule(source, "u");
    const lines = r.source.split("\n");
    return {
      p: /\(\((\S+)\) => \{$/.exec(lines[0])![1],
      preamble: lines[1],
      source: r.source,
    };
  };

  it("原文用了第一个候选名，结果换到下一个，且确定", () => {
    const base = names("export default 1;");
    const used = names(`var ${base.p} = 1; export default 1;`);
    expect(used.p).not.toBe(base.p);
    expect(rewriteModule(`var ${base.p} = 1; export default 1;`, "u").source).toBe(used.source);
    expect(names(`var ${used.p} = 1; var ${base.p} = 1; export default 1;`).p).not.toBe(used.p);
  });

  it("定长名撞名后仍保持定长", () => {
    const first = rewriteModule("var a = this, b = import.meta; import('x');", "u").source.split("\n")[1];
    const t = /const (\S{4})=void 0;/.exec(first)![1];
    const m = /const (\S{11})=\S+\.meta\(\);/.exec(first)![1];
    const i = /const (\S{6})=\S+\.dynamicImport;/.exec(first)![1];
    const again = rewriteModule(`var ${t}, ${m}, ${i}; var a = this, b = import.meta; import('x');`, "u").source.split(
      "\n",
    )[1];
    const t2 = /const (\S{4})=void 0;/.exec(again)![1];
    const m2 = /const (\S{11})=\S+\.meta\(\);/.exec(again)![1];
    const i2 = /const (\S{6})=\S+\.dynamicImport;/.exec(again)![1];
    expect([t2, m2, i2]).not.toEqual([t, m, i]);
    expect(new Set([t2, m2, i2]).size).toBe(3);
  });

  it("export default 的值名也避开", () => {
    const first = rewriteModule("export default 1;", "u").source.split("\n")[1];
    const d = /^let (\S+);$/.exec(first)![1];
    const second = rewriteModule(`var ${d}; export default 1;`, "u").source.split("\n")[1];
    expect(/^let (\S+);$/.exec(second)![1]).not.toBe(d);
  });
});

describe("rewriteModule 错误", () => {
  it("语法错误抛 acorn 的错误", () => {
    expect(() => rewriteModule("export default (", "u")).toThrow(/Unexpected token/);
  });
  it("匿名默认声明跨行放不下时抛错", () => {
    expect(() => rewriteModule("export default\nasync function* () {}", "u")).toThrow(/改写失败/);
    expect(() => rewriteModule("export default\nclass {}", "u")).not.toThrow(); // `class $kbD` 只有 10 字符，放得进 `export def`
  });
});
