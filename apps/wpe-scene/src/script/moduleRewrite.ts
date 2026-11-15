// 场景脚本（ES 模块源码）改写成「工厂函数」源码。纯函数，不碰任何 realm。
//
// 工厂在 realm 全局里用间接 eval 编一次，之后每调一次同步执行一次模块顶层代码、返回一份新的模块命名空间（见 moduleFactory.ts）。
//
// 工厂源码布局（`\n` 换行）：
//   第 1 行  'use strict';((P) => {            （顶层有 await 时是 `(async (P) => {`）
//   第 2 行  前言：导入绑定与生成的常量（一行写完）
//   第 3 行起 改写后的原文：没被替换的每个字符，行 = 原文行 + FACTORY_LINE_OFFSET，列不变
//   另起一行  ;return P.ns(locals, reexports, stars, defaultName);
//   再一行    })
//   最后一行  //# sourceURL=<sourceUrl>
//
// `P.ns` 的参数协议（与 moduleFactory.ts 约定）：
//   locals:      Array<[导出名, () => 本地绑定]>          本地导出（含 export default 的 `default`）
//   reexports:   Array<[导出名, 库下标, 库里的名字]>       `export { a as b } from`；库里的名字为 "*" 表示整个命名空间（`export * as N from`）
//   stars:       number[]                                  `export * from` 的库下标
//   defaultName: string | null                             匿名默认值的生成名（建命名空间时把 name 从它改成 "default"），无则 null
// 数组而不是对象字面量：导出名可以叫 `__proto__`，写成字面量键会改原型。
import * as acorn from "acorn";

export interface ModuleRewrite {
  /** 工厂源码（见上面的布局），交给 realm 的间接 eval，求值结果是工厂函数 */
  source: string;
  /** 静态导入与再导出（含 export * / export * as / export {…} from）用到的说明符，按源码顺序去重 */
  specifiers: string[];
  /** 顶层有 await（不在任何函数、类字段初值、静态块里）：工厂编成 async 箭头函数 */
  async: boolean;
}

/** 工厂源码里原文第 1 行之前的行数（第 1 行是包装头，第 2 行是前言） */
export const FACTORY_LINE_OFFSET = 2;

// 只用到的 AST 字段，其余按需取
// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface AstNode {
  type: string;
  start: number;
  end: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

interface Edit {
  start: number;
  end: number;
  /** null：整段换成空白；否则 text 放在段首、其余换成空白（text 不得长于这一段） */
  text: string | null;
}

const LINE_TERMINATORS = /[\n\r\u2028\u2029]/;
const NON_LINE_TERMINATORS = /[^\n\r\u2028\u2029]/g;

/** 换成等长空白，换行符（V8 认的四种）原样保留 */
function blank(text: string): string {
  return text.replace(NON_LINE_TERMINATORS, " ");
}

function applyEdits(source: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let out = "";
  let pos = 0;
  for (const edit of sorted) {
    if (edit.start < pos) throw new Error(`场景脚本改写失败：替换范围重叠（偏移 ${edit.start}）`);
    out += source.slice(pos, edit.start);
    const original = source.slice(edit.start, edit.end);
    if (edit.text === null) {
      out += blank(original);
    } else {
      if (edit.text.length > original.length || LINE_TERMINATORS.test(original.slice(0, edit.text.length))) {
        throw new Error(
          `场景脚本改写失败：替换「${edit.text}」放不下（偏移 ${edit.start}，只有 ${original.length} 个字符或跨行）`,
        );
      }
      out += edit.text + blank(original.slice(edit.text.length));
    }
    pos = edit.end;
  }
  return out + source.slice(pos);
}

function patternNames(pattern: AstNode | null, out: string[]): void {
  if (!pattern) return;
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern.name);
      break;
    case "ObjectPattern":
      for (const prop of pattern.properties as AstNode[]) {
        patternNames(prop.type === "RestElement" ? prop.argument : prop.value, out);
      }
      break;
    case "ArrayPattern":
      for (const element of pattern.elements as Array<AstNode | null>) patternNames(element, out);
      break;
    case "AssignmentPattern":
      patternNames(pattern.left, out);
      break;
    case "RestElement":
      patternNames(pattern.argument, out);
      break;
  }
}

/** 声明里的全部绑定名（多个声明符、解构模式、默认值、rest） */
function declarationNames(declaration: AstNode): string[] {
  const out: string[] = [];
  if (declaration.type === "VariableDeclaration") {
    for (const declarator of declaration.declarations as AstNode[]) patternNames(declarator.id, out);
  } else if (declaration.id) {
    out.push(declaration.id.name);
  }
  return out;
}

/** ModuleExportName：Identifier 或字符串 Literal */
function moduleName(node: AstNode): string {
  return node.type === "Identifier" ? node.name : String(node.value);
}

/** 生成源码里的字符串字面量；U+2028 / U+2029 转义，不让它们成为行终止符 */
function literal(value: string): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function rewriteModule(source: string, sourceUrl: string): ModuleRewrite {
  const tokens: acorn.Token[] = [];
  const program = acorn.parse(source, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowHashBang: true,
    locations: false,
    onToken: tokens,
  }) as unknown as AstNode;

  // —— 1. 遍历：标识符名、顶层 await / this、import.meta、动态 import
  const identifiers = new Set<string>();
  const thisNodes: AstNode[] = [];
  const metaNodes: AstNode[] = [];
  const dynamicNodes: AstNode[] = [];
  let isAsync = false;

  const walk = (node: AstNode, thisTop: boolean, awaitTop: boolean): void => {
    switch (node.type) {
      case "Identifier":
      case "PrivateIdentifier":
        identifiers.add(node.name);
        return;
      case "ThisExpression":
        if (thisTop) thisNodes.push(node);
        return;
      case "MetaProperty":
        if (node.meta.name === "import") metaNodes.push(node);
        return;
      case "ImportExpression":
        dynamicNodes.push(node);
        break;
      case "AwaitExpression":
        if (awaitTop) isAsync = true;
        break;
      case "ForOfStatement":
        if (node.await && awaitTop) isAsync = true;
        break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "StaticBlock":
        thisTop = false;
        awaitTop = false;
        break;
      case "ArrowFunctionExpression":
        awaitTop = false; // 箭头函数不改 this
        break;
      case "PropertyDefinition":
      case "AccessorProperty":
        // 计算属性键属于外层；初值是自己的 this / await 边界
        if (node.key) walk(node.key as AstNode, thisTop, awaitTop);
        if (node.value) walk(node.value as AstNode, false, false);
        return;
    }
    for (const key of Object.keys(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value)
          if (item && typeof item === "object" && typeof item.type === "string") walk(item, thisTop, awaitTop);
      } else if (value && typeof value === "object" && typeof value.type === "string") {
        walk(value as AstNode, thisTop, awaitTop);
      }
    }
  };
  walk(program, true, true);

  // —— 2. 生成的标识符：避开原文里出现过的一切名字；候选序列固定，结果只取决于源码
  const used = new Set<string>();
  const taken = (name: string): boolean => identifiers.has(name) || used.has(name) || source.includes(name);
  /** 不定长：$kb<tag>、$kb<tag>1、$kb<tag>2 … */
  const freeName = (tag: string): string => {
    for (let i = 0; ; i++) {
      const name = `$kb${tag}${i === 0 ? "" : i}`;
      if (!taken(name)) {
        used.add(name);
        return name;
      }
    }
  };
  /** 定长：`$<tag><i>` 右补 `_` 到 length，i 从 0 起（例：`$T0_`、`$I0____`） */
  const fixedName = (tag: string, length: number): string => {
    for (let i = 0; `$${tag}${i}`.length <= length; i++) {
      const name = `$${tag}${i}`.padEnd(length, "_");
      if (!taken(name)) {
        used.add(name);
        return name;
      }
    }
    throw new Error(`场景脚本改写失败：找不到可用的 ${length} 字符生成标识符`);
  };
  const P = freeName("P");
  const D = freeName("D");
  const M = fixedName("M", "import.meta".length);
  const I = fixedName("I", "import".length);
  const T = fixedName("T", "this".length);

  // —— 3. 顶层语句：导入 / 导出
  const edits: Edit[] = [];
  const specifiers: string[] = [];
  const specIndex = (specifier: string): number => {
    let index = specifiers.indexOf(specifier);
    if (index < 0) {
      index = specifiers.length;
      specifiers.push(specifier);
    }
    return index;
  };
  const preamble: string[] = [];
  const locals: Array<[string, string]> = [];
  const reexports: Array<[string, number, string]> = [];
  const stars: number[] = [];
  let needDefaultVar = false;
  let anonymousDefault = false;

  const tokenIndexAt = (start: number): number => {
    let lo = 0;
    let hi = tokens.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tokens[mid].start < start) lo = mid + 1;
      else if (tokens[mid].start > start) hi = mid - 1;
      else return mid;
    }
    throw new Error(`场景脚本改写失败：找不到偏移 ${start} 处的 token`);
  };
  const blankNode = (node: AstNode): void => void edits.push({ start: node.start, end: node.end, text: null });

  for (const node of program.body as AstNode[]) {
    switch (node.type) {
      case "ImportDeclaration": {
        const index = specIndex(node.source.value);
        const named: string[] = [];
        for (const spec of node.specifiers as AstNode[]) {
          if (spec.type === "ImportNamespaceSpecifier") {
            preamble.push(`const ${spec.local.name}=${P}.lib(${index});`);
          } else if (spec.type === "ImportDefaultSpecifier") {
            named.push(`default:${spec.local.name}`);
          } else {
            const key = spec.imported.type === "Identifier" ? spec.imported.name : literal(String(spec.imported.value));
            named.push(`${key}:${spec.local.name}`);
          }
        }
        if (named.length > 0) preamble.push(`const {${named.join(",")}}=${P}.lib(${index});`);
        blankNode(node);
        break;
      }
      case "ExportAllDeclaration": {
        const index = specIndex(node.source.value);
        if (node.exported) reexports.push([moduleName(node.exported), index, "*"]);
        else if (!stars.includes(index)) stars.push(index);
        blankNode(node);
        break;
      }
      case "ExportNamedDeclaration": {
        if (node.declaration) {
          // `export` 到声明开头（中间的注释一起）换成空白
          edits.push({ start: node.start, end: node.declaration.start, text: null });
          for (const name of declarationNames(node.declaration)) locals.push([name, name]);
        } else if (node.source) {
          const index = specIndex(node.source.value);
          for (const spec of node.specifiers as AstNode[])
            reexports.push([moduleName(spec.exported), index, moduleName(spec.local)]);
          blankNode(node);
        } else {
          for (const spec of node.specifiers as AstNode[]) locals.push([moduleName(spec.exported), spec.local.name]);
          blankNode(node);
        }
        break;
      }
      case "ExportDefaultDeclaration": {
        const declaration = node.declaration as AstNode;
        const exportToken = tokenIndexAt(node.start);
        const defaultToken = tokens[exportToken + 1]; // `export` 之后紧跟的 token 一定是 `default`
        if (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") {
          if (declaration.id) {
            // 有名字：只去掉 `export default`，导出 default 指向这个名字
            edits.push({ start: node.start, end: declaration.start, text: null });
            locals.push(["default", declaration.id.name]);
          } else {
            // 匿名：换成带名字的同类声明，保持函数声明的提升，也不会被下一行的 `(` 接成调用
            let index = tokenIndexAt(declaration.start);
            let text: string;
            if (declaration.type === "ClassDeclaration") {
              text = `class ${D}`;
            } else {
              const prefix = declaration.async ? "async " : "";
              if (declaration.async) index++; // tokens[index] 是 `async`，下一个是 `function`
              if (declaration.generator) index++; // `function` 后面的 `*`
              text = `${prefix}function${declaration.generator ? "*" : ""} ${D}`;
            }
            edits.push({ start: node.start, end: tokens[index].end, text });
            locals.push(["default", D]);
            anonymousDefault = true;
          }
        } else {
          // 表达式：`export default` 换成 `D=`；括号等留在原处
          edits.push({ start: node.start, end: defaultToken.end, text: `${D}=` });
          needDefaultVar = true;
          locals.push(["default", D]);
          if (
            (declaration.type === "FunctionExpression" && !declaration.id) ||
            (declaration.type === "ClassExpression" && !declaration.id) ||
            declaration.type === "ArrowFunctionExpression"
          ) {
            anonymousDefault = true;
          }
        }
        break;
      }
    }
  }

  // —— 4. 其它原地替换
  for (const node of metaNodes) edits.push({ start: node.start, end: node.end, text: M });
  for (const node of dynamicNodes) edits.push({ start: node.start, end: node.start + "import".length, text: I });
  for (const node of thisNodes) edits.push({ start: node.start, end: node.end, text: T });
  if (source.startsWith("#!")) edits.push({ start: 0, end: 2, text: "//" });

  // —— 5. 组装
  if (needDefaultVar) preamble.push(`let ${D};`);
  if (metaNodes.length > 0) preamble.push(`const ${M}=${P}.meta();`);
  if (dynamicNodes.length > 0) preamble.push(`const ${I}=${P}.dynamicImport;`);
  if (thisNodes.length > 0) preamble.push(`const ${T}=void 0;`);

  const body = applyEdits(source, edits);
  const localsLiteral = locals.map(([name, local]) => `[${literal(name)},()=>${local}]`).join(",");
  const reexportsLiteral = reexports
    .map(([name, index, imported]) => `[${literal(name)},${index},${literal(imported)}]`)
    .join(",");
  const result = [
    `'use strict';(${isAsync ? "async " : ""}(${P}) => {`,
    preamble.join(""),
    body,
    `;return ${P}.ns([${localsLiteral}],[${reexportsLiteral}],[${stars.join(",")}],${anonymousDefault ? literal(D) : "null"});`,
    "})",
    `//# sourceURL=${sourceUrl.replace(/[\r\n\u2028\u2029]/g, "")}`,
  ].join("\n");

  return { source: result, specifiers, async: isAsync };
}
