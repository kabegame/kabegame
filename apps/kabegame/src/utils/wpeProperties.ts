import DOMPurify from "dompurify";

type Atom = string | number | boolean | null | undefined;
type Node =
  | { type: "literal"; value: Atom }
  | { type: "value"; key: string }
  | { type: "array"; items: Atom[] }
  | { type: "unary"; op: string; right: Node }
  | { type: "binary"; op: string; left: Node; right: Node }
  | { type: "ternary"; test: Node; yes: Node; no: Node }
  | { type: "member"; object: Node; key: "length" | number }
  | { type: "call"; object: Node; name: string; args: Node[] };

const parsed = new Map<string, Node | null>();
const warned = new Set<string>();
const methods = new Set(["split", "includes", "indexOf", "startsWith", "endsWith"]);
const precedence: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "===": 3,
  "!==": 3,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let offset = 0;
  const token =
    /^(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|[A-Za-z_$][\w$]*|===|!==|&&|\|\||==|!=|<=|>=|[+\-*\/%<>!?:()[\].,])/;
  while (offset < source.length) {
    if (/\s/.test(source[offset])) {
      offset++;
      continue;
    }
    const match = token.exec(source.slice(offset));
    if (!match) throw new Error("invalid token");
    tokens.push(match[0]);
    offset += match[0].length;
  }
  return tokens;
}

function parse(source: string): Node {
  if (source.length > 2048) throw new Error("condition too long");
  const tokens = tokenize(source);
  let index = 0;
  let nodes = 0;
  const peek = () => tokens[index];
  const take = () => tokens[index++];
  function node<T extends Node>(value: T, depth: number): T {
    if (++nodes > 256 || depth > 32) throw new Error("condition too complex");
    return value;
  }
  function expect(value: string) {
    if (take() !== value) throw new Error("unexpected token");
  }
  function primary(depth: number): Node {
    const current = take();
    if (current === undefined) throw new Error("unexpected end");
    if (current === "(") {
      const inner = expression(0, depth + 1);
      expect(")");
      return inner;
    }
    if (current === "[") {
      const items: Atom[] = [];
      while (peek() !== "]") {
        // 元素只收原始值字面量；负数在词法上是「- 数字」，这里就地折叠
        const negative = peek() === "-" && /^\d/.test(tokens[index + 1] ?? "");
        if (negative) take();
        const item = primary(depth + 1);
        if (item.type !== "literal") throw new Error("array elements must be primitive");
        if (negative && typeof item.value !== "number") throw new Error("array elements must be primitive");
        items.push(negative ? -(item.value as number) : item.value);
        if (items.length > 1024) throw new Error("array too long");
        if (peek() !== ",") break;
        take();
      }
      expect("]");
      return node({ type: "array", items }, depth);
    }
    if (/^\d/.test(current)) return node({ type: "literal", value: Number(current) }, depth);
    if (current[0] === "'" || current[0] === '"') {
      const value = current
        .slice(1, -1)
        .replace(
          /\\([\\'"nrt])/g,
          (_all, char: string) => ({ n: "\n", r: "\r", t: "\t" })[char as "n" | "r" | "t"] ?? char,
        );
      return node({ type: "literal", value }, depth);
    }
    if (current === "true" || current === "false") return node({ type: "literal", value: current === "true" }, depth);
    if (current === "null" || current === "undefined")
      return node({ type: "literal", value: current === "null" ? null : undefined }, depth);
    if (/^[A-Za-z_$][\w$]*$/.test(current) && peek() === "." && tokens[index + 1] === "value") {
      take();
      take();
      return node({ type: "value", key: current }, depth);
    }
    throw new Error("identifier is not allowed");
  }
  function postfix(depth: number): Node {
    let left = primary(depth + 1);
    while (peek() === "." || peek() === "[") {
      const separator = take();
      if (separator === "[") {
        const key = take();
        if (!/^\d+$/.test(key ?? "")) throw new Error("index must be a nonnegative integer");
        expect("]");
        left = node({ type: "member", object: left, key: Number(key) }, depth);
      } else {
        const key = take();
        if (key === "length" && peek() !== "(") left = node({ type: "member", object: left, key }, depth);
        else if (key && methods.has(key) && peek() === "(") {
          take();
          const args: Node[] = [];
          while (peek() !== ")") {
            args.push(expression(0, depth + 1));
            if (args.length > 2) throw new Error("too many arguments");
            if (peek() !== ",") break;
            take();
          }
          expect(")");
          left = node({ type: "call", object: left, name: key, args }, depth);
        } else throw new Error("member is not allowed");
      }
    }
    return left;
  }
  // 一元运算比成员访问 / 方法调用低一级（同 JS）：`!a.value.endsWith('x')` 是对调用结果取反
  function unary(depth: number): Node {
    const op = peek();
    if (op === "!" || op === "+" || op === "-") {
      take();
      return node({ type: "unary", op, right: unary(depth + 1) }, depth);
    }
    return postfix(depth);
  }
  function expression(min: number, depth: number): Node {
    let left = unary(depth + 1);
    while (precedence[peek()] !== undefined && precedence[peek()] >= min) {
      const op = take();
      left = node({ type: "binary", op, left, right: expression(precedence[op] + 1, depth + 1) }, depth);
    }
    if (min === 0 && peek() === "?") {
      take();
      const yes = expression(0, depth + 1);
      expect(":");
      left = node({ type: "ternary", test: left, yes, no: expression(0, depth + 1) }, depth);
    }
    return left;
  }
  const result = expression(0, 0);
  if (index !== tokens.length) throw new Error("trailing token");
  return result;
}

function primitive(value: unknown): Atom {
  if (value === null || value === undefined || ["string", "number", "boolean"].includes(typeof value))
    return value as Atom;
  throw new Error("nonprimitive value");
}
function looseEqual(a: Atom, b: Atom): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === "boolean") return looseEqual(Number(a), b);
  if (typeof b === "boolean") return looseEqual(a, Number(b));
  if (typeof a === "string" && typeof b === "number") return Number(a) === b;
  if (typeof b === "string" && typeof a === "number") return a === Number(b);
  return false;
}
function relational(a: Atom, b: Atom, op: string): boolean {
  const left = typeof a === "string" && typeof b === "string" ? a : Number(a);
  const right = typeof a === "string" && typeof b === "string" ? b : Number(b);
  if (op === "<") return left < right;
  if (op === "<=") return left <= right;
  if (op === ">") return left > right;
  return left >= right;
}
function run(node: Node, valueOf: (key: string) => unknown): Atom | Atom[] {
  switch (node.type) {
    case "literal":
      return node.value;
    case "value":
      return primitive(valueOf(node.key));
    case "array":
      return node.items;
    case "unary": {
      const value = run(node.right, valueOf);
      return node.op === "!" ? !value : node.op === "+" ? Number(value) : -Number(value);
    }
    case "ternary":
      return run(node.test, valueOf) ? run(node.yes, valueOf) : run(node.no, valueOf);
    case "member": {
      const value = run(node.object, valueOf);
      if (value == null) return undefined;
      if (typeof value !== "string" && !Array.isArray(value)) throw new Error("invalid member receiver");
      return node.key === "length" ? value.length : primitive(value[node.key]);
    }
    case "call": {
      const value = run(node.object, valueOf);
      if (value == null) return undefined;
      const args = node.args.map((arg) => primitive(run(arg, valueOf)));
      if (typeof value === "string") {
        switch (node.name) {
          case "split":
            return value.split(String(args[0]));
          case "includes":
            return value.includes(String(args[0]));
          case "indexOf":
            return value.indexOf(String(args[0]));
          case "startsWith":
            return value.startsWith(String(args[0]));
          case "endsWith":
            return value.endsWith(String(args[0]));
        }
      }
      if (Array.isArray(value) && node.name === "includes") return value.includes(args[0]);
      if (Array.isArray(value) && node.name === "indexOf") return value.indexOf(args[0]);
      throw new Error("invalid method receiver");
    }
    case "binary": {
      const left = run(node.left, valueOf);
      if (node.op === "&&") return left ? run(node.right, valueOf) : left;
      if (node.op === "||") return left ? left : run(node.right, valueOf);
      const right = run(node.right, valueOf);
      if (Array.isArray(left) || Array.isArray(right)) throw new Error("array operand is not allowed");
      switch (node.op) {
        case "===":
          return left === right;
        case "!==":
          return left !== right;
        case "==":
          return looseEqual(left, right);
        case "!=":
          return !looseEqual(left, right);
        case "+":
          return left === undefined
            ? right
            : right === undefined
              ? left
              : typeof left === "string" || typeof right === "string"
                ? String(left) + String(right)
                : Number(left) + Number(right);
        case "-":
          return Number(left ?? 0) - Number(right ?? 0);
        case "*":
          return Number(left) * Number(right);
        case "/":
          return Number(left) / Number(right);
        case "%":
          return Number(left) % Number(right);
        case "<":
        case "<=":
        case ">":
        case ">=":
          return relational(left, right, node.op);
      }
    }
  }
}

export function evaluateWpeCondition(expr: string, valueOf: (key: string) => unknown): boolean {
  try {
    let ast = parsed.get(expr);
    if (ast === undefined) {
      // 只缓存解析结果（失败记 null）；运行期出错与当时的取值有关，不缓存，值变了下次照常求值
      try {
        ast = parse(expr);
      } catch (error) {
        parsed.set(expr, null);
        throw error;
      }
      parsed.set(expr, ast);
    }
    if (!ast) throw new Error("invalid condition");
    return Boolean(run(ast, valueOf));
  } catch (error) {
    if (!warned.has(expr)) {
      warned.add(expr);
      console.warn("[wpe] 无法解释显示条件", expr.slice(0, 160), error);
    }
    return true;
  }
}

const labels = new Map<string, string>();
const allowedTags = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "div",
  "p",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "hr",
  "pre",
  "blockquote",
  "b",
  "i",
  "u",
  "s",
  "small",
  "big",
  "strong",
  "em",
  "span",
  "font",
  "br",
  "sub",
  "sup",
  "code",
  "mark",
];
export function sanitizeWpeLabel(html: string): string {
  const cached = labels.get(html);
  if (cached !== undefined) return cached;
  const purified = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: allowedTags,
    ALLOWED_ATTR: ["color", "face", "size", "align", "title"],
  });
  // happy-dom 下 DOMPurify 对部分未知标签的移除不完整；最终输出再按同一白名单收口。
  const root = document.createElement("div");
  root.innerHTML = purified;
  const safeTags = new Set(allowedTags);
  const safeAttrs = new Set(["color", "face", "size", "align", "title"]);
  const dropTags = new Set([
    "script",
    "style",
    "img",
    "svg",
    "iframe",
    "object",
    "embed",
    "video",
    "audio",
    "link",
    "meta",
  ]);
  function clean(parent: Element) {
    for (const child of Array.from(parent.children)) {
      const tag = child.tagName.toLowerCase();
      if (dropTags.has(tag)) {
        child.remove();
        continue;
      }
      clean(child);
      if (!safeTags.has(tag)) {
        child.replaceWith(...Array.from(child.childNodes));
        continue;
      }
      for (const attr of Array.from(child.attributes))
        if (!safeAttrs.has(attr.name.toLowerCase())) child.removeAttribute(attr.name);
    }
  }
  clean(root);
  const result = root.innerHTML;
  labels.set(html, result);
  return result;
}
export function wpeLabelText(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = sanitizeWpeLabel(html);
  return div.textContent ?? "";
}
export function wpeColorToHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
  return `#${parts
    .map((part) =>
      Math.round(Math.min(1, Math.max(0, part)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
export function hexToWpeColor(hex: string): string {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (!match) throw new Error("invalid hex color");
  return match
    .slice(1)
    .map((part) => parseInt(part, 16) / 255)
    .join(" ");
}
