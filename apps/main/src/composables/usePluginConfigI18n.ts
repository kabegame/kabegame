import { useI18n } from "vue-i18n";
import type { PluginConfigText } from "@kabegame/core/stores/plugins";

/**
 * 从后端下发的 config 文案对象解析当前语言。
 * value 为 { default: string, zh?: string, en?: string, ... }，优先 value[locale]，否则 value["default"]，再否则 value["en"] 作为 fallback。
 * 兼容 value 为 string（旧数据或单语言）时直接返回。
 */
export function resolveConfigText(
  value: PluginConfigText | string | null | undefined,
  locale: string,
): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  const m = value as Record<string, string>;
  return m[locale] ?? m["default"] ?? m["en"] ?? "";
}

/** 选项：后端下发的为 string 或 { name: PluginConfigText, variable: string } */
export type ConfigVarOption = string | { name: PluginConfigText | string; variable: string };

/** 单条变量定义（get_plugin_vars 返回项）：name/descripts 为 Record，options 项中 name 为 Record */
export type PluginVarDefI18n = {
  key: string;
  type: string;
  name: PluginConfigText | string;
  descripts?: PluginConfigText | string;
  default?: unknown;
  options?: ConfigVarOption[];
  min?: number;
  max?: number;
  when?: Record<string, string[]>;
};

/**
 * 统一响应式入口：按当前 i18n locale 解析插件的 config 变量 name、descripts、options[].name。
 * 与 usePluginManifestI18n 同构，用于任务表单、CrawlerDialog、TaskDrawerContent 等。
 */
export function usePluginConfigI18n() {
  const { locale } = useI18n();

  function varDisplayName(varDef: { name?: PluginConfigText | string }): string {
    return resolveConfigText(varDef?.name, locale.value);
  }

  function varDescripts(varDef: { descripts?: PluginConfigText | string }): string {
    return resolveConfigText(varDef?.descripts, locale.value);
  }

  function optionDisplayName(opt: ConfigVarOption): string {
    if (typeof opt === "string") return opt;
    return resolveConfigText(opt.name, locale.value);
  }

  return {
    resolveConfigText,
    varDisplayName,
    varDescripts,
    optionDisplayName,
    locale,
  };
}
