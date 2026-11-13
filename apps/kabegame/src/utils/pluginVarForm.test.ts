import { describe, expect, it } from "vitest";
import {
  canonicalizeUserConfig,
  expandVarsForBackend,
  isEmptyVarValue,
  normalizeVarsForUI,
  type PluginVarDef,
  varFieldError,
} from "./pluginVarForm";

function intError(value: unknown, overrides: Partial<PluginVarDef> = {}, ignoreRequired = false): string | undefined {
  const definition: PluginVarDef = {
    key: "page",
    type: "int",
    name: "页数",
    required: true,
    min: 1,
    max: 10,
    ...overrides,
  };
  return varFieldError(definition, value, "页数", { ignoreRequired });
}

describe("插件整数配置校验", () => {
  it("拒绝原始非法文本和非整数数字", () => {
    expect(intError("1.5")).toBe("页数必须是整数");
    expect(intError(1.5)).toBe("页数必须是整数");
  });

  it("拒绝超出上下限的整数", () => {
    expect(intError(0)).toBe("页数不能小于 1");
    expect(intError(11)).toBe("页数不能大于 10");
  });

  it("可选整数允许留空，但填写后仍校验", () => {
    const optional = { default: 1, required: false };
    expect(intError("", optional)).toBeUndefined();
    expect(intError("bad", optional)).toBe("页数必须是整数");
  });

  it("忽略插件 JSON 中显式为 null 的边界", () => {
    expect(intError(4, { default: 2, max: null })).toBeUndefined();
  });

  it("保留具体错误，不被必填提示覆盖", () => {
    expect(intError(undefined)).toBe("请输入页数");
    expect(intError("bad")).toBe("页数必须是整数");
    expect(intError(0)).toBe("页数不能小于 1");
    expect(intError(11)).toBe("页数不能大于 10");
  });
});

describe("ignoreRequired", () => {
  const defs: PluginVarDef[] = [
    { key: "text", type: "string", name: "文本", required: true },
    { key: "tags", type: "list", name: "标签", required: true },
    { key: "page", type: "int", name: "页数", required: true, min: 1 },
  ];

  it("提交任务时必填字段为空会报错", () => {
    for (const def of defs) expect(varFieldError(def, null, def.key)).toBeTruthy();
  });

  it("编辑默认配置时必填字段允许为空", () => {
    for (const def of defs) expect(varFieldError(def, null, def.key, { ignoreRequired: true })).toBeUndefined();
  });

  it("忽略必填时整数仍校验范围", () => {
    expect(varFieldError(defs[2], 0, "页数", { ignoreRequired: true })).toBe("页数不能小于 1");
  });
});

describe("其它类型", () => {
  it("float 填了值就校验范围（不论是否必填）", () => {
    const def: PluginVarDef = { key: "r", type: "float", name: "R", min: 0, max: 1 };
    expect(varFieldError(def, 1.5, "R")).toBe("R不能大于 1");
    expect(varFieldError(def, 0.5, "R")).toBeUndefined();
  });

  it("list / checkbox 必填为空时提示选择；options 声明过的空字符串合法", () => {
    expect(varFieldError({ key: "l", type: "list", name: "L", required: true }, [], "L")).toBe("请选择L");
    const opt: PluginVarDef = {
      key: "o",
      type: "options",
      name: "O",
      required: true,
      options: [{ name: "全部", variable: "" }],
    };
    expect(varFieldError(opt, "", "O")).toBeUndefined();
  });

  it("date 按 format 解析并校验上下界", () => {
    const def: PluginVarDef = { key: "d", type: "date", name: "D", format: "YYYYMMDD", dateMax: "2020-01-01" };
    expect(varFieldError(def, "20200102", "D")).toBe("D不能晚于 2020-01-01");
    expect(varFieldError(def, "2020-13", "D")).toBe("请输入有效的D");
    expect(varFieldError(def, "20191231", "D")).toBeUndefined();
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
    expect(expandVarsForBackend({ text: "", items: [], checks: [], option: "", flag: false }, defs)).toEqual({
      text: null,
      items: null,
      checks: null,
      option: "",
      flag: false,
    });
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
    {
      key: "any",
      type: "options",
      name: "O",
      options: [
        { name: "全部", variable: "" },
        { name: "X", variable: "x" },
      ],
    },
    { key: "mode", type: "options", name: "M", options: ["p", "q"] },
    { key: "untouched", type: "string", name: "U", default: "keep" },
  ];

  it("只规范出现的键：旧式空值转 null，checkbox 数组展开，声明的空选项保留，不补默认值", () => {
    expect(
      canonicalizeUserConfig({ text: "", date: "", tags: [], kinds: ["b"], any: "", mode: "", extra: 1 }, defs),
    ).toEqual({ text: null, date: null, tags: null, kinds: { a: false, b: true }, any: "", mode: null, extra: 1 });
  });
});
