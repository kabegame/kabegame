import { isNil } from "lodash-es";
import type { PluginVarDef } from "@/composables/usePluginConfig";

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
