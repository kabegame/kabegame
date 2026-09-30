import { describe, expect, it } from "vitest";
import { getValidationRules, type PluginVarDef } from "./pluginVarForm";

function validateInt(value: unknown, overrides: Partial<PluginVarDef> = {}): Promise<void> {
  const definition: PluginVarDef = {
    key: "page",
    type: "int",
    name: "页数",
    min: 1,
    max: 10,
    ...overrides,
  };
  const [rule] = getValidationRules(definition, "页数");
  return new Promise((resolve, reject) => {
    rule.validator({}, value, (error?: Error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

describe("插件整数配置校验", () => {
  it("拒绝原始非法文本和非整数数字", async () => {
    await expect(validateInt("1.5")).rejects.toThrow("页数必须是整数");
    await expect(validateInt(1.5)).rejects.toThrow("页数必须是整数");
  });

  it("拒绝超出上下限的整数", async () => {
    await expect(validateInt(0)).rejects.toThrow("页数不能小于 1");
    await expect(validateInt(11)).rejects.toThrow("页数不能大于 10");
  });

  it("可选整数允许留空，但填写后仍校验", async () => {
    const optional = { default: 1 };
    await expect(validateInt("", optional)).resolves.toBeUndefined();
    await expect(validateInt("bad", optional)).rejects.toThrow("页数必须是整数");
  });
});
