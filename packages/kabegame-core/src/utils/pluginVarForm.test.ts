import { describe, expect, it } from "vitest";
import AsyncValidator from "async-validator";
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

async function validateIntThroughForm(value: unknown, overrides: Partial<PluginVarDef> = {}): Promise<string | null> {
  const definition: PluginVarDef = {
    key: "page",
    type: "int",
    name: "页数",
    min: 1,
    max: 10,
    ...overrides,
  };
  const [rule] = getValidationRules(definition, "页数");
  const { trigger: _trigger, ...schemaRule } = rule;
  try {
    await new AsyncValidator({ page: [schemaRule] }).validate({ page: value });
    return null;
  } catch (error: any) {
    return error?.errors?.[0]?.message ?? String(error);
  }
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

  it("忽略插件 JSON 中显式为 null 的边界", async () => {
    const nullableMax = { default: 2, max: null };
    await expect(validateInt(4, nullableMax)).resolves.toBeUndefined();
    await expect(validateIntThroughForm(4, nullableMax)).resolves.toBeNull();
  });

  it("经表单校验时保留具体错误，不被必填提示覆盖", async () => {
    await expect(validateIntThroughForm(undefined)).resolves.toBe("请输入页数");
    await expect(validateIntThroughForm("bad")).resolves.toBe("页数必须是整数");
    await expect(validateIntThroughForm(0)).resolves.toBe("页数不能小于 1");
    await expect(validateIntThroughForm(11)).resolves.toBe("页数不能大于 10");
  });
});
