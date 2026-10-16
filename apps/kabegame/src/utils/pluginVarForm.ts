import type { PluginConfigText } from "../stores/plugins";
import {
  formatPluginDateForBackend,
  parsePluginDateBound,
  parsePluginDateStored,
  shiftPluginDateByDays,
} from "./pluginDateVar";

export type VarOption =
  string | { name: PluginConfigText | string; variable: string; when?: Record<string, (string | boolean)[]> };

/** 插件变量定义：name/descripts/options[].name 为后端下发的 record（default/zh/en）或兼容 string */
export type PluginVarDef = {
  key: string;
  type: string;
  name: PluginConfigText | string;
  descripts?: PluginConfigText | string;
  default?: any;
  required?: boolean;
  options?: VarOption[];
  min?: number | null;
  max?: number | null;
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

/** 插件清单来自 JSON，`min` / `max` 可能显式为 null；只有有限数字才是有效边界。 */
function finiteBound(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// 必填只由插件清单显式声明；没有 default 不再隐式等于必填。
export function isRequired(varDef: { required?: boolean }) {
  return varDef.required === true;
}

/** 控件层各种“未输入”表示的统一判断；options 声明过的空字符串是合法值。 */
export function isEmptyVarValue(varDef: PluginVarDef, value: any): boolean {
  if (varDef.type === "boolean") return false;
  if (value === undefined || value === null) return true;
  if (varDef.type === "options" && value === "") {
    return !(varDef.options ?? []).some((option) => optionValue(option) === "");
  }
  if (typeof value === "string") return value.trim() === "";
  if (varDef.type === "list") return !Array.isArray(value) || value.length === 0;
  if (varDef.type === "checkbox") {
    if (Array.isArray(value)) return value.length === 0;
    if (value && typeof value === "object") return !Object.values(value).some((item) => item === true);
    return true;
  }
  return false;
}

/** 校验单个插件变量值是否与定义兼容（与 useConfigCompatibility 逻辑一致） */
export function validateVarValue(value: any, varDef: PluginVarDef): { valid: boolean; error?: string } {
  const min = finiteBound(varDef.min);
  const max = finiteBound(varDef.max);
  switch (varDef.type) {
    case "int":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return { valid: false, error: "值必须是整数" };
      }
      if (min !== undefined && value < min) {
        return { valid: false, error: `值不能小于 ${min}` };
      }
      if (max !== undefined && value > max) {
        return { valid: false, error: `值不能大于 ${max}` };
      }
      break;
    case "float":
      if (typeof value !== "number") {
        return { valid: false, error: "值必须是数字" };
      }
      if (min !== undefined && value < min) {
        return { valid: false, error: `值不能小于 ${min}` };
      }
      if (max !== undefined && value > max) {
        return { valid: false, error: `值不能大于 ${max}` };
      }
      break;
    case "boolean":
      if (typeof value !== "boolean") {
        return { valid: false, error: "值必须是布尔值" };
      }
      break;
    case "options":
      if (varDef.options && Array.isArray(varDef.options)) {
        const validValues = varDef.options.map(optionValue);
        if (!validValues.includes(value)) {
          return { valid: false, error: `值不在有效选项中` };
        }
      }
      break;
    case "checkbox":
      if (Array.isArray(value)) {
        if (varDef.options && Array.isArray(varDef.options)) {
          const validValues = varDef.options.map(optionValue);
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
  defs: PluginVarDef[],
): Record<string, any> {
  const matched: Record<string, any> = {};
  const varDefMap = new Map(defs.map((d) => [d.key, d]));

  for (const [key, value] of Object.entries(userConfig)) {
    const varDef = varDefMap.get(key);
    if (!varDef) continue;
    if (value === null) {
      matched[key] = null;
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
    if (varDef.default !== undefined) {
      matched[varDef.key] = varDef.default;
    }
  }
  return matched;
}

// 将 UI 表单中的 vars（checkbox 在 UI 层使用 string[]）转换为后端/脚本需要的对象：
// 例如 { foo: ["a","b"] } -> { foo: { a: true, b: true } }
export function expandVarsForBackend(uiVars: Record<string, any>, defs: PluginVarDef[]) {
  const expanded: Record<string, any> = { ...uiVars };
  for (const def of defs) {
    const raw = uiVars[def.key];
    if (def.type === "boolean") {
      expanded[def.key] = raw === true;
      continue;
    }
    if (isEmptyVarValue(def, raw)) {
      expanded[def.key] = null;
      continue;
    }
    if (def.type === "checkbox") {
      const options = def.options || [];
      const optionVars = options.map(optionValue);
      const selected = Array.isArray(raw) ? (raw as string[]) : [];
      const obj: Record<string, boolean> = {};
      for (const v of optionVars) obj[v] = selected.includes(v);
      expanded[def.key] = obj;
    } else if (def.type === "date") {
      if (typeof raw !== "string") continue;
      const fmt = def.format && def.format.trim() !== "" ? def.format.trim() : "YYYY-MM-DD";
      expanded[def.key] = formatPluginDateForBackend(raw, fmt);
    }
  }
  return expanded;
}

/**
 * 把外部来源（插件推荐配置等）里的 userConfig 规范成后端接受的形态：只处理实际出现的键，
 * 不补默认值（缺省键运行时由后端按 default 合并）；`""` / `[]` / 未勾选等空表示转为 `null`，
 * checkbox 数组展开为完整对象，options 声明过的 `""` 保持原样。未声明的键原样保留。
 */
export function canonicalizeUserConfig(userConfig: Record<string, any>, defs: PluginVarDef[]): Record<string, any> {
  const out: Record<string, any> = { ...(userConfig ?? {}) };
  const present = defs.filter((d) => Object.prototype.hasOwnProperty.call(out, d.key));
  if (present.length === 0) return out;
  return { ...out, ...expandVarsForBackend(normalizeVarsForUI(out, present), present) };
}

// 将后端保存/运行配置中的 checkbox 值聚合回 UI 用的 foo: string[]
// - 格式：foo: { a: true, b: false }（脚本中用 foo.a/foo.b）
export function normalizeVarsForUI(rawVars: Record<string, any>, defs: PluginVarDef[]) {
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
      (rawVars[def.key] === undefined || rawVars[def.key] === "")
    ) {
      const legacyRange = rawVars["date_range"];
      const start = rawVars["start_date"];
      if (typeof legacyRange === "number" && legacyRange >= 1 && typeof start === "string" && start.trim() !== "") {
        const fmt = def.format && def.format.trim() !== "" ? def.format.trim() : "YYYY-MM-DD";
        const endStr = shiftPluginDateByDays(start, fmt, legacyRange - 1);
        if (endStr) {
          normalized[def.key] = endStr;
          continue;
        }
      }
    }

    if (rawVars[def.key] === null) {
      normalized[def.key] = def.type === "checkbox" || def.type === "list" ? [] : null;
      continue;
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
      // 数组写法（["a","b"]，常见于手写推荐配置 / 旧数据）：只保留声明过的 variable
      if (Array.isArray(raw)) {
        normalized[def.key] = optionVars.filter((v) => raw.includes(v));
        continue;
      }
      // default: 支持数组（["a","b"]）或对象（{a:true,b:false}）
      const d = def.default;
      if (Array.isArray(d)) {
        normalized[def.key] = d;
      } else if (d && typeof d === "object") {
        normalized[def.key] = optionVars.filter((v) => (d as any)[v] === true);
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

/**
 * 获取验证规则。displayName 为已按 locale 解析好的展示名（由调用方通过 i18n composable 解析后传入）。
 * `ignoreRequired`：编辑默认配置等不提交任务的场景，必填字段也允许为空。
 */
export function getValidationRules(
  varDef: PluginVarDef,
  displayName: string,
  options: { ignoreRequired?: boolean } = {},
) {
  const label = displayName;
  const required = !options.ignoreRequired && isRequired(varDef);
  const min = finiteBound(varDef.min);
  const max = finiteBound(varDef.max);

  if (varDef.type === "int") {
    return [
      {
        required,
        trigger: "change",
        validator: (_rule: any, value: any, callback: any) => {
          if (isEmptyVarValue(varDef, value)) {
            if (required) callback(new Error(`请输入${label}`));
            else callback();
            return;
          }
          if (typeof value !== "number" || !Number.isInteger(value)) {
            callback(new Error(`${label}必须是整数`));
            return;
          }
          if (min !== undefined && value < min) {
            callback(new Error(`${label}不能小于 ${min}`));
            return;
          }
          if (max !== undefined && value > max) {
            callback(new Error(`${label}不能大于 ${max}`));
            return;
          }
          callback();
        },
      },
    ];
  }

  if (!required) {
    return [];
  }

  if (varDef.type === "list" || varDef.type === "checkbox") {
    return [
      {
        required: true,
        message: `请选择${label}`,
        trigger: "change",
        validator: (_rule: any, value: any, callback: any) => {
          if (isEmptyVarValue(varDef, value)) {
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
        trigger: varDef.type === "options" || varDef.type === "date" ? "change" : "blur",
        validator: (_rule: any, value: any, callback: any) => {
          if (isEmptyVarValue(varDef, value)) {
            callback(new Error(`请输入${label}`));
            return;
          }
          if (varDef.type === "float" && typeof value === "number") {
            if (min !== undefined && value < min) {
              callback(new Error(`${label}不能小于 ${min}`));
              return;
            }
            if (max !== undefined && value > max) {
              callback(new Error(`${label}不能大于 ${max}`));
              return;
            }
          }
          if (varDef.type === "date" && typeof value === "string") {
            const vd = varDef as PluginVarDef;
            const fmt = vd.format && vd.format.trim() !== "" ? vd.format.trim() : "YYYY-MM-DD";
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
