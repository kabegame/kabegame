import { describe, expect, it } from "vitest";
import {
  normalizeSearchExpr,
  parseSearchExpr,
  printSearchExpr,
  type SearchExpr,
  type SearchExprErrorCode,
} from "./searchExpr";

const term = (value: string): SearchExpr => ({ kind: "term", value });
const and = (...items: SearchExpr[]): SearchExpr => ({ kind: "and", items });
const or = (...items: SearchExpr[]): SearchExpr => ({ kind: "or", items });
const not = (item: SearchExpr): SearchExpr => ({ kind: "not", item });

function parsed(input: string): SearchExpr | null {
  const result = parseSearchExpr(input);
  if (!result.ok) throw new Error(`解析失败：${JSON.stringify(result.error)}`);
  return result.expr;
}

describe("且 / 或 / 非 / 分组", () => {
  it("(girl;boy), cute, !genshin = 非原神的可爱的男孩或女孩", () => {
    expect(parsed("(girl;boy), cute, !genshin")).toEqual(
      and(or(term("girl"), term("boy")), term("cute"), not(term("genshin"))),
    );
  });

  it("逗号优先于分号", () => {
    expect(parsed("a, b; c")).toEqual(or(and(term("a"), term("b")), term("c")));
  });

  it("! 只作用于紧随的一项，可作用于分组", () => {
    expect(parsed("!a, b")).toEqual(and(not(term("a")), term("b")));
    expect(parsed("! (a; b)")).toEqual(not(or(term("a"), term("b"))));
  });

  it("多重 ! 两两抵消，抵消后照样拍平", () => {
    expect(parsed("!!a")).toEqual(term("a"));
    expect(parsed("!!!a")).toEqual(not(term("a")));
    expect(parsed("! ! (!a)")).toEqual(not(term("a")));
    expect(parsed("a, !!(b, c)")).toEqual(and(term("a"), term("b"), term("c")));
    expect(parsed("!(!(a; b)); c")).toEqual(or(term("a"), term("b"), term("c")));
    // 不是直接嵌套的取非不动：外层取非的是整个且组。
    expect(parsed("!(!a, b)")).toEqual(not(and(not(term("a")), term("b"))));
  });

  it("同类嵌套拍平，单项分组坍缩", () => {
    expect(parsed("(a, b), c")).toEqual(and(term("a"), term("b"), term("c")));
    expect(parsed("a; (b; c)")).toEqual(or(term("a"), term("b"), term("c")));
    expect(parsed("((a))")).toEqual(term("a"));
  });

  it("空项丢弃；整串没有词时为 null", () => {
    expect(parsed("a,, b ;")).toEqual(and(term("a"), term("b")));
    expect(parsed(";a;;")).toEqual(term("a"));
    for (const input of ["", "   ", ",", ";,;"]) {
      expect(parsed(input)).toBeNull();
    }
  });

  it("词两端空白裁掉，词中空白原样保留", () => {
    expect(parsed("  樱花  /  sakura ")).toEqual(term("樱花  /  sakura"));
  });
});

describe("转义与引号", () => {
  it("反斜线转义任意字符", () => {
    expect(parsed("\\(a\\)")).toEqual(term("(a)"));
    expect(parsed("a\\\\b")).toEqual(term("a\\b"));
    expect(parsed('\\"x\\"')).toEqual(term('"x"'));
    expect(parsed("a\\, b\\; c")).toEqual(term("a, b; c"));
    expect(parsed("\\!genshin")).toEqual(term("!genshin"));
  });

  it("\\  是不会被裁掉的空白", () => {
    expect(parsed("\\ a\\ ")).toEqual(term(" a "));
    expect(parsed("  \\  ")).toEqual(term(" "));
  });

  it("引号内按字面处理，可与裸字符拼接", () => {
    expect(parsed('" a, (b); !c "')).toEqual(term(" a, (b); !c "));
    expect(parsed('foo" bar"')).toEqual(term("foo bar"));
    expect(parsed('"a \\" b \\\\"')).toEqual(term('a " b \\'));
    expect(parsed('"x", "y"; !"z"')).toEqual(or(and(term("x"), term("y")), not(term("z"))));
  });
});

describe("宽松的字面括号与感叹号", () => {
  it("词中间的 ( 与 ! 按字面处理", () => {
    expect(parsed("Foo (1).jpg")).toEqual(term("Foo (1).jpg"));
    expect(parsed("hello!, a !b")).toEqual(and(term("hello!"), term("a !b")));
  });

  it("词内配对的括号在分组里不会提前闭合", () => {
    expect(parsed("(Foo (1).jpg; x), y")).toEqual(and(or(term("Foo (1).jpg"), term("x")), term("y")));
  });

  it("不在组内时多出的 ) 按字面处理", () => {
    expect(parsed("a)")).toEqual(term("a)"));
    expect(parsed("a), b")).toEqual(and(term("a)"), term("b")));
  });
});

describe("语法错误带位置", () => {
  it.each<[string, SearchExprErrorCode, number]>([
    ["(girl; boy", "unclosedGroup", 0],
    ["a, (b, (c)", "unclosedGroup", 3],
    ['a, "b', "unclosedQuote", 3],
    ['"a\\', "unclosedQuote", 0],
    ["a\\", "danglingEscape", 1],
    ["a, !", "missingOperand", 3],
    ["!, a", "missingOperand", 0],
    ["a; ()", "emptyGroup", 3],
    ["( , )", "emptyGroup", 0],
    ['a, ""', "emptyTerm", 3],
    ["(a)b", "expectedSeparator", 3],
    ["(a) )", "expectedSeparator", 4],
  ])("%s → %s @%d", (input, code, position) => {
    expect(parseSearchExpr(input)).toEqual({ ok: false, error: { code, position } });
  });
});

describe("规范打印", () => {
  it.each<[string, string]>([
    ["(girl;boy),cute,!genshin", "(girl; boy), cute, !genshin"],
    ["!(a,b); c", "!(a, b); c"],
    ["((a;b))", "a; b"],
    ['"a,b"', "a\\,b"],
    ['" x "', "\\ x\\ "],
    ['"(x)"', "\\(x\\)"],
    ['"!x"', "\\!x"],
    ["Foo (1).jpg", "Foo (1).jpg"],
    ['"a)"', "a\\)"],
    ['"a("', "a\\("],
    ['"x\\\\y\\"z"', 'x\\\\y\\"z'],
  ])("%s → %s", (input, printed) => {
    expect(printSearchExpr(parsed(input)!)).toBe(printed);
  });

  it("外部构造的树先收敛成规范形再打印", () => {
    const expr = and(not(not(or(term("a"), term("b")))), not(not(not(term("c")))), and(term("d")));
    expect(normalizeSearchExpr(expr)).toEqual(and(or(term("a"), term("b")), not(term("c")), term("d")));
    expect(printSearchExpr(expr)).toBe("(a; b), !c, d");
    expect(printSearchExpr(not(not(term("x"))))).toBe("x");
  });

  it("未配对的 ( 作为组内最后一个词也不会吞掉分组的 )", () => {
    const expr = and(or(term("b"), term("a(")), term("c"));
    expect(printSearchExpr(expr)).toBe("(b; a\\(), c");
    expect(parsed(printSearchExpr(expr))).toEqual(expr);
  });

  it("随机语法树经打印再解析还原出规范形，且不含直接嵌套的取非", () => {
    // 固定种子的线性同余发生器：失败可复现。
    let seed = 20261008;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
    const alphabet = ["a", "b", "樱", " ", "\t", ",", ";", "(", ")", "!", '"', "\\", "/", "."];
    const randomTerm = (): SearchExpr => {
      let value = "";
      const length = 1 + Math.floor(random() * 6);
      for (let index = 0; index < length; index += 1) value += pick(alphabet);
      return term(value);
    };
    const randomExpr = (budget: number): SearchExpr => {
      const roll = random();
      if (budget <= 0 || roll < 0.35) return randomTerm();
      // 故意生成多重取非与同类嵌套，由规范化收敛。
      if (roll < 0.5) return not(randomExpr(budget - 1));
      const count = 1 + Math.floor(random() * 3);
      const items = Array.from({ length: count }, () => randomExpr(budget - 1));
      return { kind: roll < 0.75 ? "and" : "or", items };
    };
    const hasDoubleNot = (expr: SearchExpr): boolean => {
      if (expr.kind === "term") return false;
      if (expr.kind === "not") return expr.item.kind === "not" || hasDoubleNot(expr.item);
      return expr.items.some(hasDoubleNot);
    };

    for (let round = 0; round < 500; round += 1) {
      const expr = randomExpr(5);
      const text = printSearchExpr(expr);
      const result = parseSearchExpr(text);
      expect(result, text).toEqual({ ok: true, expr: normalizeSearchExpr(expr) });
      expect(hasDoubleNot((result as { expr: SearchExpr }).expr), text).toBe(false);
    }
  });
});
