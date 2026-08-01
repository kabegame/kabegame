import { isNil } from "lodash-es";
import type { PluginConfigText } from "../stores/plugins";
import {
  formatPluginDateForBackend,
  parsePluginDateBound,
  parsePluginDateStored,
  shiftPluginDateByDays,
} from "./pluginDateVar";

export type VarOption =
  | string
  | { name: PluginConfigText | string; variable: string; when?: Record<string, (string | boolean)[]> };

/** 插件变量定义：name/descripts/options[].name 为后端下发的 record（default/zh/en）或兼容 string */
export type PluginVarDef = {
  key: string;
  type: string;
  name: PluginConfigText | string;
  descripts?: PluginConfigText | string;
  default?: any;
  options?: VarOption[];
  min?: number;
  max?: number;
  when?: Record<string, (string | boolean)[]>;
  /** type 为 date 时可选：dayjs 格式，提交给后端的日期字符串（默认 YYYY-MM-DD） */
  format?: string;
  /** type 为 date 时可选：最早/最晚可选日，`YYYY-MM-DD` 或 `today` / `yesterday` */
  dateMin?: string;
  dateMax?: string;
  /** 表单栅格宽度（1~4，缺省/非法值按 4 处理）；纯布局提示，不参与取值与校验 */
  width?: number;
};

export function optionValue(opt: VarOption) {
  return typeof opt === "string" ? opt : opt.variable;
}

// 判断配置项是否必填（没有 default 值则为必填）
export function isRequired(varDef: { default?: any }) {
  return varDef.default === undefined || varDef.default === null;
}

/** 校验单个插件变量值是否与定义兼容（与 useConfigCompatibility 逻辑一致） */
export function validateVarValue(
  value: any,
  varDef: PluginVarDef
): { valid: boolean; error?: string } {
  switch (varDef.type) {
    case "int":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return { valid: false, error: "值必须是整数" };
      }
      if (!isNil(varDef.min) && value < varDef.min) {
        return { valid: false, error: `值不能小于 ${varDef.min}` };
      }
      if (!isNil(varDef.max) && value > varDef.max) {
        return { valid: false, error: `值不能大于 ${varDef.max}` };
      }
      break;
    case "float":
      if (typeof value !== "number") {
        return { valid: false, error: "值必须是数字" };
      }
      if (!isNil(varDef.min) && value < varDef.min) {
        return { valid: false, error: `值不能小于 ${varDef.min}` };
      }
      if (!isNil(varDef.max) && value > varDef.max) {
        return { valid: false, error: `值不能大于 ${varDef.max}` };
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") {
        return { valid: false, error: "值必须是布尔值" };
      }
      break;
    case "options":
      if (varDef.options && Array.isArray(varDef.options)) {
        const validValues = varDef.options.map((opt) =>
          typeof opt === "string" ? opt : (opt as any).variable || (opt as any).value
        );
        if (!validValues.includes(value)) {
          return { valid: false, error: `值不在有效选项中` };
        }
      }
      break;
    case "checkbox":
      if (Array.isArray(value)) {
        if (varDef.options && Array.isArray(varDef.options)) {
          const validValues = varDef.options.map((opt) =>
            typeof opt === "string" ? opt : (opt as any).variable || (opt as any).value
          );
          const invalidValues = value.filter((v) => !validValues.includes(v));
          if (invalidValues.length > 0) {
            return { valid: false, error: `包含无效选项` };
          }
        }
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        break;
      } else {
        return { valid: false, error: "值必须是数组或对象" };
      }
      break;
    case "list":
      if (!Array.isArray(value)) {
        return { valid: false, error: "值必须是数组" };
      }
      break;
    case "date":
      if (typeof value !== "string") {
        return { valid: false, error: "值必须是字符串" };
      }
      if (value !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return { valid: false, error: "日期格式应为 YYYY-MM-DD" };
      }
      break;
  }
  return { valid: true };
}

/** 将默认配置中的 userConfig 按字段与 var 定义对齐（不兼容字段回退到 default） */
export function matchUserConfigFromDefaults(
  userConfig: Record<string, any>,
  defs: PluginVarDef[]
): Record<string, any> {
  const matched: Record<string, any> = {};
  const varDefMap = new Map(defs.map((d) => [d.key, d]));
  const explicitNullKeys = new Set<string>();

  for (const [key, value] of Object.entries(userConfig)) {
    const varDef = varDefMap.get(key);
    if (!varDef) continue;
    if (value === null) {
      explicitNullKeys.add(key);
      continue;
    }
    if (value === undefined) continue;
    const validation = validateVarValue(value, varDef);
    if (validation.valid) {
      matched[key] = value;
    } else if (varDef.default !== undefined) {
      matched[key] = varDef.default;
    }
  }

  for (const varDef of defs) {
    if (varDef.key in matched) continue;
    if (explicitNullKeys.has(varDef.key)) continue;
    if (varDef.default !== undefined) {
      matched[varDef.key] = varDef.default;
    }
  }
  return matched;
}

// 将 UI 表单中的 vars（checkbox 在 UI 层使用 string[]）转换为后端/脚本需要的对象：
// 例如 { foo: ["a","b"] } -> { foo: { a: true, b: true } }
export function expandVarsForBackend(
  uiVars: Record<string, any>,
  defs: PluginVarDef[]
) {
  const expanded: Record<string, any> = { ...uiVars };
  for (const def of defs) {
    if (def.type === "checkbox") {
      const options = def.options || [];
      const optionVars = options.map(optionValue);
      const selected = Array.isArray(uiVars[def.key])
        ? (uiVars[def.key] as string[])
        : [];
      const obj: Record<string, boolean> = {};
      for (const v of optionVars) obj[v] = selected.includes(v);
      expanded[def.key] = obj;
    } else if (def.type === "date") {
      const raw = expanded[def.key];
      if (typeof raw !== "string") continue;
      const fmt =
        def.format && def.format.trim() !== ""
          ? def.format.trim()
          : "YYYY-MM-DD";
      expanded[def.key] = formatPluginDateForBackend(raw, fmt);
    }
  }
  return expanded;
}

// 将后端保存/运行配置中的 checkbox 值聚合回 UI 用的 foo: string[]
// - 格式：foo: { a: true, b: false }（脚本中用 foo.a/foo.b）
export function normalizeVarsForUI(
  rawVars: Record<string, any>,
  defs: PluginVarDef[]
) {
  const normalized: Record<string, any> = {};
  for (const def of defs) {
    // 兼容：local-import 旧配置字段 file_path/folder_path -> 新字段 path
    if (def.key === "path" && rawVars?.[def.key] === undefined) {
      const legacyFile = rawVars?.["file_path"];
      const legacyFolder = rawVars?.["folder_path"];
      if (typeof legacyFile === "string" && legacyFile.trim() !== "") {
        normalized[def.key] = legacyFile;
        continue;
      }
      if (typeof legacyFolder === "string" && legacyFolder.trim() !== "") {
        normalized[def.key] = legacyFolder;
        continue;
      }
    }

    // 兼容：Pixiv 等旧配置 date_range（天）+ start_date -> end_date
    if (
      def.type === "date" &&
      def.key === "end_date" &&
      (rawVars[def.key] === undefined ||
        rawVars[def.key] === "" ||
        rawVars[def.key] === null)
    ) {
      const legacyRange = rawVars["date_range"];
      const start = rawVars["start_date"];
      if (
        typeof legacyRange === "number" &&
        legacyRange >= 1 &&
        typeof start === "string" &&
        start.trim() !== ""
      ) {
        const fmt =
          def.format && def.format.trim() !== ""
            ? def.format.trim()
            : "YYYY-MM-DD";
        const endStr = shiftPluginDateByDays(start, fmt, legacyRange - 1);
        if (endStr) {
          normalized[def.key] = endStr;
          continue;
        }
      }
    }

    if (def.type === "checkbox") {
      const options = def.options || [];
      const optionVars = options.map(optionValue);
      // foo 是对象（{a:true,b:false}）
      const raw = rawVars[def.key];
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        normalized[def.key] = optionVars.filter((v) => raw?.[v] === true);
        continue;
      }
      // default: 支持数组（["a","b"]）或对象（{a:true,b:false}）
      const d = def.default;
      if (Array.isArray(d)) {
        normalized[def.key] = d;
      } else if (d && typeof d === "object") {
        normalized[def.key] = optionVars.filter(
          (v) => (d as any)[v] === true
        );
      } else {
        normalized[def.key] = [];
      }
      continue;
    }

    if (def.type === "boolean") {
      const raw = rawVars[def.key];
      if (raw === true || raw === false) {
        normalized[def.key] = raw;
      } else if (def.default === true || def.default === false) {
        normalized[def.key] = def.default;
      } else {
        normalized[def.key] = false;
      }
      continue;
    }

    if (rawVars[def.key] !== undefined) {
      normalized[def.key] = rawVars[def.key];
    } else if (def.default !== undefined) {
      normalized[def.key] = def.default;
    }
  }
  return normalized;
}

/** 获取验证规则。displayName 为已按 locale 解析好的展示名（由调用方通过 i18n composable 解析后传入） */
export function getValidationRules(varDef: PluginVarDef, displayName: string) {
  if (!isRequired(varDef)) {
    return [];
  }
  const label = displayName;

  if (varDef.type === "list" || varDef.type === "checkbox") {
    return [
      {
        required: true,
        message: `请选择${label}`,
        trigger: "change",
        validator: (_rule: any, value: any, callback: any) => {
          if (!value || (Array.isArray(value) && value.length === 0)) {
            callback(new Error(`请选择${label}`));
          } else {
            callback();
          }
        },
      },
    ];
  } else if (varDef.type === "boolean") {
    return [];
  } else {
    return [
      {
        required: true,
        message: `请输入${label}`,
        trigger:
          varDef.type === "options" || varDef.type === "date"
            ? "change"
            : "blur",
        validator: (_rule: any, value: any, callback: any) => {
          if (value === undefined || value === null || value === "") {
            callback(new Error(`请输入${label}`));
            return;
          }
          if (
            (varDef.type === "int" || varDef.type === "float") &&
            typeof value === "number"
          ) {
            const varDefWithMinMax = varDef as PluginVarDef;
            if (
              varDefWithMinMax.min !== undefined &&
              value < varDefWithMinMax.min
            ) {
              callback(new Error(`${label}不能小于 ${varDefWithMinMax.min}`));
              return;
            }
            if (
              varDefWithMinMax.max !== undefined &&
              value > varDefWithMinMax.max
            ) {
              callback(new Error(`${label}不能大于 ${varDefWithMinMax.max}`));
              return;
            }
          }
          if (varDef.type === "date" && typeof value === "string") {
            const vd = varDef as PluginVarDef;
            const fmt =
              vd.format && vd.format.trim() !== ""
                ? vd.format.trim()
                : "YYYY-MM-DD";
            const d = parsePluginDateStored(value, fmt);
            if (!d) {
              callback(new Error(`请输入有效的${label}`));
              return;
            }
            if (vd.dateMin?.trim()) {
              const minD = parsePluginDateBound(vd.dateMin);
              if (minD && d.startOf("day").isBefore(minD, "day")) {
                callback(new Error(`${label}不能早于 ${vd.dateMin}`));
                return;
              }
            }
            if (vd.dateMax?.trim()) {
              const maxD = parsePluginDateBound(vd.dateMax);
              if (maxD && d.startOf("day").isAfter(maxD, "day")) {
                callback(new Error(`${label}不能晚于 ${vd.dateMax}`));
                return;
              }
            }
          }
          callback();
        },
      },
    ];
  }
}
