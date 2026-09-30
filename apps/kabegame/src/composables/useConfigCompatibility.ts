import { unref } from "vue";
import { resolveConfigText, i18n } from "@kabegame/i18n";
import { usePluginStore } from "@/stores/plugins";
import { validateVarValue, type PluginVarDef } from "@kabegame/core/utils/pluginVarForm";

export interface ConfigCompatibility {
  versionCompatible: boolean; // 第一步：插件是否存在
  contentCompatible: boolean; // 第二步：配置内容是否符合
  versionReason?: string;
  contentErrors: string[]; // 内容不兼容的具体错误
  warnings: string[]; // 警告信息（如字段已删除但不算严重错误）
}

function isRequiredVar(varDef: { default?: any }) {
  return varDef.default === undefined || varDef.default === null;
}

/** 校验插件推荐配置的 userConfig 是否与当前插件变量定义兼容（导入前调用） */
export async function checkRecommendedPresetCompatibility(
  pluginId: string,
  userConfig: Record<string, any> | undefined,
): Promise<ConfigCompatibility> {
  const locale = String(unref(i18n.global.locale) ?? "zh");
  const result: ConfigCompatibility = {
    versionCompatible: true,
    contentCompatible: true,
    contentErrors: [],
    warnings: [],
  };
  const pluginStore = usePluginStore();
  if (!pluginStore.plugins.some((p) => p.id === pluginId)) {
    result.versionCompatible = false;
    result.versionReason = "插件不存在";
    result.contentCompatible = false;
    return result;
  }
  try {
    const plugin = pluginStore.plugins.find((p) => p.id === pluginId);
    const vars = (plugin?.config?.vars as Array<PluginVarDef> | undefined) ?? [];
    if (!vars || vars.length === 0) return result;
    const varDefMap = new Map(vars.map((def) => [def.key, def]));
    const uc = userConfig || {};
    for (const [key, value] of Object.entries(uc)) {
      const varDef = varDefMap.get(key);
      if (!varDef) {
        result.warnings.push(`字段 "${key}" 已在新版本中删除`);
        continue;
      }
      const validation = validateVarValue(value, varDef);
      if (!validation.valid) {
        result.contentCompatible = false;
        result.contentErrors.push(`${resolveConfigText(varDef.name, locale)} (${key}): ${validation.error}`);
      }
    }
    for (const varDef of vars) {
      if (!(varDef.key in uc)) {
        if (isRequiredVar(varDef)) {
          result.contentCompatible = false;
          result.contentErrors.push(`缺少必填字段: ${resolveConfigText(varDef.name, locale)} (${varDef.key})`);
        }
      }
    }
  } catch {
    result.contentCompatible = false;
    result.contentErrors.push("验证过程出错");
  }
  return result;
}
