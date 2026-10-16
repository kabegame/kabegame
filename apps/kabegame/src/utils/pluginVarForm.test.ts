import { describe, expect, it } from "vitest";
import AsyncValidator from "async-validator";
import {
  canonicalizeUserConfig,
  expandVarsForBackend,
  getValidationRules,
  isEmptyVarValue,
  normalizeVarsForUI,
  type PluginVarDef,
} from "./pluginVarForm";

function validateInt(value: unknown, overrides: Partial<PluginVarDef> = {}): Promise<void> {
  const definition: PluginVarDef = {
    key: "page",
    type: "int",
    name: "页数",
    required: true,
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
    required: true,
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
    const optional = { default: 1, required: false };
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

describe("ignoreRequired", () => {
  const defs: PluginVarDef[] = [
    { key: "text", type: "string", name: "文本", required: true },
    { key: "tags", type: "list", name: "标签", required: true },
    { key: "page", type: "int", name: "页数", required: true, min: 1 },
  ];

  async function emptyError(def: PluginVarDef, ignoreRequired: boolean): Promise<string | null> {
    const rules = getValidationRules(def, def.key, { ignoreRequired });
    if (rules.length === 0) return null;
    const schema = rules.map(({ trigger: _trigger, ...rule }) => rule);
    try {
      await new AsyncValidator({ [def.key]: schema }).validate({ [def.key]: null });
      return null;
    } catch (error: any) {
      return error?.errors?.[0]?.message ?? String(error);
    }
  }

  it("提交任务时必填字段为空会报错", async () => {
    for (const def of defs) expect(await emptyError(def, false)).not.toBeNull();
  });

  it("编辑默认配置时必填字段允许为空", async () => {
    for (const def of defs) expect(await emptyError(def, true)).toBeNull();
  });

  it("忽略必填时整数仍校验范围", async () => {
    const [rule] = getValidationRules(defs[2], "页数", { ignoreRequired: true });
    const { trigger: _trigger, ...schema } = rule;
    await expect(new AsyncValidator({ page: [schema] }).validate({ page: 0 })).rejects.toBeTruthy();
  });
});

describe("插件变量空值转换", () => {
  const defs: PluginVarDef[] = [
    { key: "text", type: "string", name: "Text", default: "fallback" },
    { key: "items", type: "list", name: "Items", default: ["fallback"] },
    { key: "checks", type: "checkbox", name: "Checks", options: ["a", "b"], default: ["a"] },
    {
      key: "option",
      type: "options",
      name: "Option",
      options: [{ name: "任意", variable: "" }],
      default: "",
    },
    { key: "flag", type: "boolean", name: "Flag", default: true },
  ];

  it("把控件空表示转换为 null，同时保留合法空字符串 option", () => {
    expect(
      expandVarsForBackend({ text: "", items: [], checks: [], option: "", flag: false }, defs),
    ).toEqual({ text: null, items: null, checks: null, option: "", flag: false });
    expect(isEmptyVarValue(defs[3], "")).toBe(false);
  });

  it("显式 null 往返时不回落到 default", () => {
    expect(normalizeVarsForUI({ text: null, items: null, checks: null }, defs)).toMatchObject({
      text: null,
      items: [],
      checks: [],
      option: "",
      flag: true,
    });
  });
});

describe("canonicalizeUserConfig", () => {
  const defs: PluginVarDef[] = [
    { key: "text", type: "string", name: "T" },
    { key: "date", type: "date", name: "D" },
    { key: "tags", type: "list", name: "L" },
    { key: "kinds", type: "checkbox", name: "C", options: ["a", "b"] },
    { key: "any", type: "options", name: "O", options: [{ name: "全部", variable: "" }, { name: "X", variable: "x" }] },
    { key: "mode", type: "options", name: "M", options: ["p", "q"] },
    { key: "untouched", type: "string", name: "U", default: "keep" },
  ];

  it("只规范出现的键：旧式空值转 null，checkbox 数组展开，声明的空选项保留，不补默认值", () => {
    expect(
      canonicalizeUserConfig(
        { text: "", date: "", tags: [], kinds: ["b"], any: "", mode: "", extra: 1 },
        defs,
      ),
    ).toEqual({ text: null, date: null, tags: null, kinds: { a: false, b: true }, any: "", mode: null, extra: 1 });
  });
});
