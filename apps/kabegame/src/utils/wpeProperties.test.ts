// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { evaluateWpeCondition, hexToWpeColor, sanitizeWpeLabel, wpeColorToHex, wpeLabelText } from "./wpeProperties";

const values: Record<string, unknown> = {
  visible: true,
  scale: 150,
  mode: "contain",
  effect: "blue-pulse",
  alignment: 1,
  color: "#fff",
  tags: "a,b",
};
const valueOf = (key: string) => values[key];

describe("WPE 显示条件", () => {
  it("解释样例条件", () => {
    expect(evaluateWpeCondition("visible.value && scale.value > 100", valueOf)).toBe(true);
    expect(evaluateWpeCondition("mode.value == 'contain'", valueOf)).toBe(true);
    expect(evaluateWpeCondition("effect.value.endsWith('pulse') === true", valueOf)).toBe(true);
    expect(evaluateWpeCondition("effect.value.startsWith('red') === false", valueOf)).toBe(true);
    expect(evaluateWpeCondition("mode.value !== 'cover'", valueOf)).toBe(true);
    expect(evaluateWpeCondition("alignment.value<2", valueOf)).toBe(true);
  });
  it("解释白名单内的表达式", () => {
    expect(evaluateWpeCondition("['contain','cover'].includes(mode.value)", valueOf)).toBe(true);
    expect(evaluateWpeCondition("effect.value.indexOf('pulse') >= 0", valueOf)).toBe(true);
    expect(evaluateWpeCondition("tags.value.split(',').length === 2", valueOf)).toBe(true);
    expect(evaluateWpeCondition("color.value[0] == '#'", valueOf)).toBe(true);
    expect(evaluateWpeCondition("visible.value ? scale.value + 1 > 150 : false", valueOf)).toBe(true);
    expect(evaluateWpeCondition("missing.value === undefined", valueOf)).toBe(true);
    expect(evaluateWpeCondition("'1' == 1 && true == 1 && null == undefined", valueOf)).toBe(true);
  });
  it("一元运算作用于整个成员 / 调用链", () => {
    expect(evaluateWpeCondition("!effect.value.endsWith('pulse')", valueOf)).toBe(false);
    expect(evaluateWpeCondition("!effect.value.endsWith('red')", valueOf)).toBe(true);
    expect(evaluateWpeCondition("-scale.value < -100", valueOf)).toBe(true);
    expect(evaluateWpeCondition("!visible.value == false", valueOf)).toBe(true);
    expect(evaluateWpeCondition("[-1, 2].includes(-1)", valueOf)).toBe(true);
  });
  it("运行期出错不缓存，取值变化后照常求值", () => {
    let current: unknown = 5;
    const dynamic = (key: string) => (key === "dyn" ? current : undefined);
    expect(evaluateWpeCondition("dyn.value.startsWith('a')", dynamic)).toBe(true);
    current = "bcd";
    expect(evaluateWpeCondition("dyn.value.startsWith('a')", dynamic)).toBe(false);
  });
  it("不认识的表达式保持显示", () => {
    for (const expression of [
      "visible.value ?",
      "mode.value.toLowerCase()",
      "Math.max(1,2)",
      "visible",
      "mode.value.foo",
      "mode?.value",
      "scale.value.startsWith('1')",
      "x".repeat(2049),
    ]) {
      expect(evaluateWpeCondition(expression, valueOf)).toBe(true);
    }
    expect(evaluateWpeCondition("missing.value.startsWith('a') === undefined", valueOf)).toBe(true);
  });
});

describe("WPE 文案与颜色", () => {
  it("净化标签并保留允许的排版", () => {
    const cleaned = sanitizeWpeLabel(
      '<h3 class="x" onclick="bad()">标题</h3><font color="red" style="x">文字</font><a href="https://x">链接</a><img src="https://x"><script>bad()</script>',
    );
    expect(cleaned).toContain("<h3>标题</h3>");
    expect(cleaned).toContain('<font color="red">文字</font>');
    expect(cleaned).not.toMatch(/onclick|class=|style=|<a|<img|<script/);
    expect(wpeLabelText("<b>标题</b>")).toBe("标题");
  });
  it("颜色按完整分量精度往返", () => {
    expect(wpeColorToHex("1 0.5 0")).toBe("#ff8000");
    expect(hexToWpeColor("#ff8000")).toBe(`1 ${128 / 255} 0`);
  });
});
