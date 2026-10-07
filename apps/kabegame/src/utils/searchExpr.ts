/**
 * 搜索框表达式：把输入解析成且 / 或 / 非组成的语法树，并能把语法树打印回规范的输入。
 *
 * 语法（优先级从低到高）：
 *
 *   or      := and (";" and)*          分号：或
 *   and     := unary ("," unary)*      逗号：且
 *   unary   := "!" unary | primary     前置感叹号：非
 *   primary := "(" or ")" | term       小括号：分组
 *
 * 词（term）的规则：
 * - `\X` 恒表示字面字符 X：`\(`、`\)`、`\!`、`\,`、`\;`、`\"`、`\\`，`\ ` 是不会被裁掉的空白；
 * - `"…"` 内除 `\` 转义与闭合引号外全部按字面处理（含空白与 `,;()!`），可与裸字符拼在同一个词里；
 * - 词两端未转义、未加引号的空白被裁掉，词中间的空白原样保留；
 * - `(` 与 `!` 只在一个词的开头才是语法符号，词中间的按字面处理（`Foo (1).jpg`、`hello!`）；
 * - 词内未配对的 `(` 让随后的 `)` 也按字面处理；词里多出来的 `)` 在括号组内闭合分组，
 *   不在组内时按字面处理。`,` 与 `;` 永远是分隔符，词里需要时得转义或加引号。
 *
 * 空项（`a,,b`、`a;`）丢弃，与旧的逗号 / 分号语义一致；整串没有任何词时结果为 null（不过滤）。
 *
 * 结果恒为规范形（见 `normalizeSearchExpr`）：同类且 / 或拍平、单项坍缩、双重取非抵消
 * （`!!a` = `a`，`!(!a, b)` 这类非直接嵌套的不动）。抵消是硬约束而非美化——查询条用
 * `~not/~not/…/~end/~end` 标记高级条件的边界，搜索展开出来的路径不能长成这个样子。
 * 本模块只管文本 ↔ 语法树，不关心搜索维度与路径序列化。
 */

export type SearchExpr =
  | { kind: "term"; value: string }
  | { kind: "and"; items: SearchExpr[] }
  | { kind: "or"; items: SearchExpr[] }
  | { kind: "not"; item: SearchExpr };

export type SearchExprErrorCode =
  /** `(` 没有对应的 `)`；position 指向这个 `(`。 */
  | "unclosedGroup"
  /** `"` 没有闭合；position 指向开引号。 */
  | "unclosedQuote"
  /** 输入以单个 `\` 结尾；position 指向这个 `\`。 */
  | "danglingEscape"
  /** `!` 后面没有可取非的内容；position 指向这个 `!`。 */
  | "missingOperand"
  /** `()` 里没有任何词；position 指向 `(`。 */
  | "emptyGroup"
  /** `""` 这类只由引号构成的空词；position 指向词首。 */
  | "emptyTerm"
  /** `)` 之后既不是分隔符也不是结尾（如 `(a)b`）；position 指向多出来的字符。 */
  | "expectedSeparator";

export interface SearchExprError {
  code: SearchExprErrorCode;
  /** 出错位置在输入串里的下标（UTF-16 码元）。 */
  position: number;
}

export type SearchExprParseResult = { ok: true; expr: SearchExpr | null } | { ok: false; error: SearchExprError };

class ParseFailure extends Error {
  constructor(readonly detail: SearchExprError) {
    super(detail.code);
  }
}

function isWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

/** 同类节点拍平、单项坍缩、空表返回 null。 */
function combine(kind: "and" | "or", items: SearchExpr[]): SearchExpr | null {
  const flat = items.flatMap((item) => (item.kind === kind ? item.items : [item]));
  if (flat.length === 0) return null;
  if (flat.length === 1) return flat[0]!;
  return { kind, items: flat };
}

/** 取非：对取非再取非直接抵消。 */
function negate(item: SearchExpr): SearchExpr {
  return item.kind === "not" ? item.item : { kind: "not", item };
}

/**
 * 规范形：双重取非抵消、同类且 / 或拍平、单项坍缩。`parseSearchExpr` 的结果已是规范形；
 * 外部构造的树（如 phase 2 从路径还原）经此收敛，打印前也会先过一遍。
 */
export function normalizeSearchExpr(expr: SearchExpr): SearchExpr {
  switch (expr.kind) {
    case "term":
      return expr;
    case "not":
      return negate(normalizeSearchExpr(expr.item));
    case "and":
    case "or":
      return combine(expr.kind, expr.items.map(normalizeSearchExpr))!;
  }
}

export function parseSearchExpr(input: string): SearchExprParseResult {
  let pos = 0;
  /** 当前所处的括号组深度：决定词里的 `)` 是闭合分组还是字面字符。 */
  let depth = 0;

  const fail = (code: SearchExprErrorCode, position: number): never => {
    throw new ParseFailure({ code, position });
  };

  const skipWhitespace = () => {
    while (pos < input.length && isWhitespace(input[pos]!)) pos += 1;
  };

  /** 分组 / 取非之后只能接分隔符、组的 `)` 或结尾。 */
  const expectBoundary = () => {
    skipWhitespace();
    const ch = input[pos];
    if (ch === undefined || ch === "," || ch === ";" || (ch === ")" && depth > 0)) return;
    fail("expectedSeparator", pos);
  };

  const parseTerm = (): SearchExpr | null => {
    const start = pos;
    // protected：转义或引号里的字符，裁剪两端空白时不动它们。
    const chars: Array<{ ch: string; protected: boolean }> = [];
    let termDepth = 0;
    let quoted = false;

    while (pos < input.length) {
      const ch = input[pos]!;
      if (ch === "\\") {
        if (pos + 1 >= input.length) fail("danglingEscape", pos);
        chars.push({ ch: input[pos + 1]!, protected: true });
        pos += 2;
        continue;
      }
      if (ch === '"') {
        const open = pos;
        quoted = true;
        pos += 1;
        while (true) {
          if (pos >= input.length) fail("unclosedQuote", open);
          const inner = input[pos]!;
          if (inner === "\\") {
            if (pos + 1 >= input.length) fail("unclosedQuote", open);
            chars.push({ ch: input[pos + 1]!, protected: true });
            pos += 2;
            continue;
          }
          pos += 1;
          if (inner === '"') break;
          chars.push({ ch: inner, protected: true });
        }
        continue;
      }
      if (ch === "," || ch === ";") break;
      if (ch === "(") {
        termDepth += 1;
      } else if (ch === ")") {
        if (termDepth > 0) termDepth -= 1;
        else if (depth > 0) break;
      }
      chars.push({ ch, protected: false });
      pos += 1;
    }

    let begin = 0;
    let end = chars.length;
    while (begin < end && !chars[begin]!.protected && isWhitespace(chars[begin]!.ch)) begin += 1;
    while (end > begin && !chars[end - 1]!.protected && isWhitespace(chars[end - 1]!.ch)) end -= 1;
    if (begin === end) {
      if (quoted) fail("emptyTerm", start);
      return null;
    }
    return {
      kind: "term",
      value: chars
        .slice(begin, end)
        .map((item) => item.ch)
        .join(""),
    };
  };

  const parseUnary = (): SearchExpr | null => {
    skipWhitespace();
    const ch = input[pos];
    if (ch === "!") {
      const at = pos;
      pos += 1;
      const operand = parseUnary();
      if (!operand) fail("missingOperand", at);
      return negate(operand!);
    }
    if (ch === "(") {
      const at = pos;
      pos += 1;
      depth += 1;
      const inner = parseOr();
      if (input[pos] !== ")") fail("unclosedGroup", at);
      pos += 1;
      depth -= 1;
      if (!inner) fail("emptyGroup", at);
      expectBoundary();
      return inner;
    }
    return parseTerm();
  };

  const parseAnd = (): SearchExpr | null => {
    const items: SearchExpr[] = [];
    while (true) {
      const item = parseUnary();
      if (item) items.push(item);
      if (input[pos] !== ",") break;
      pos += 1;
    }
    return combine("and", items);
  };

  function parseOr(): SearchExpr | null {
    const items: SearchExpr[] = [];
    while (true) {
      const item = parseAnd();
      if (item) items.push(item);
      if (input[pos] !== ";") break;
      pos += 1;
    }
    return combine("or", items);
  }

  try {
    const expr = parseOr();
    // 顶层的 `)` 会被词吞成字面字符，走到这里还没读完只能是防御性兜底。
    if (pos < input.length) fail("expectedSeparator", pos);
    return { ok: true, expr };
  } catch (error) {
    if (error instanceof ParseFailure) return { ok: false, error: error.detail };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 打印
// ---------------------------------------------------------------------------

const PRECEDENCE: Record<SearchExpr["kind"], number> = { or: 1, and: 2, not: 3, term: 4 };

/**
 * 词 → 输入片段：只转义解析时会被当成语法的字符，其余原样输出。
 * 永远转义 `\`、`"`、`,`、`;`；词首的 `(`、`!` 与两端空白；以及词内没配对的括号——
 * 未配对的 `)` 会闭合分组，未配对的 `(` 会让分组自己的 `)` 被当成字面字符。
 */
function printTerm(value: string): string {
  if (value.length === 0) return '""';
  let leading = 0;
  while (leading < value.length && isWhitespace(value[leading]!)) leading += 1;
  let trailing = value.length;
  while (trailing > leading && isWhitespace(value[trailing - 1]!)) trailing -= 1;

  // 词首的 `(` 反正要转义，不参与配对。
  const matched = new Set<number>();
  const open: number[] = [];
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === "(") open.push(index);
    else if (value[index] === ")" && open.length > 0) {
      matched.add(open.pop()!);
      matched.add(index);
    }
  }

  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index]!;
    let escape: boolean;
    if (ch === "\\" || ch === '"' || ch === "," || ch === ";") escape = true;
    else if (index < leading || index >= trailing) escape = true;
    else if (index === 0 && ch === "!") escape = true;
    else if (ch === "(" || ch === ")") escape = !matched.has(index);
    else escape = false;
    out += escape ? `\\${ch}` : ch;
  }
  return out;
}

function printNode(expr: SearchExpr, minPrecedence: number): string {
  let text: string;
  switch (expr.kind) {
    case "term":
      text = printTerm(expr.value);
      break;
    case "not":
      text = `!${printNode(expr.item, PRECEDENCE.not)}`;
      break;
    case "and":
      text = expr.items.map((item) => printNode(item, PRECEDENCE.and)).join(", ");
      break;
    case "or":
      text = expr.items.map((item) => printNode(item, PRECEDENCE.or)).join("; ");
      break;
  }
  return PRECEDENCE[expr.kind] < minPrecedence ? `(${text})` : text;
}

/**
 * 语法树 → 规范输入：先收敛成规范形，再以 `, ` / `; ` 分隔，只加必要的括号，只转义必要的字符。
 * `parseSearchExpr(printSearchExpr(e))` 还原出 `normalizeSearchExpr(e)`。
 * 空词无法表达，打印成 `""`（解析时报 emptyTerm）。
 */
export function printSearchExpr(expr: SearchExpr): string {
  return printNode(normalizeSearchExpr(expr), 0);
}
