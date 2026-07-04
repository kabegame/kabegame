import { useI18n } from "../vue-i18n";
import { resolveConfigText } from "../resolve";

/** 选项：后端下发的为 string 或 { name: Record<string, string> | string; variable: string } */
export type ConfigVarOption = string | { name: Record<string, string> | string; variable: string };

/** 单条变量定义（get_plugin_vars 返回项）：name/descripts 为 Record，options 项中 name 为 Record */
export type PluginVarDefI18n = {
  key: string;
  type: string;
  name: Record<string, string> | string;
  descripts?: Record<string, string> | string;
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

  function varDisplayName(varDef: { name?: Record<string, string> | string }): string {
    return resolveConfigText(varDef?.name, locale.value);
  }

  function varDescripts(varDef: { descripts?: Record<string, string> | string }): string {
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
