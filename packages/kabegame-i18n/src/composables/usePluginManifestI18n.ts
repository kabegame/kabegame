import { useI18n } from "../vue-i18n";
import { resolveManifestDoc, resolveManifestText } from "../resolve";

/**
 * 统一响应式入口：按当前 i18n locale 解析插件的 name / description。
 * 从 store 拿到的 plugin.name、plugin.description 用此 composable 解析后展示，name 为回退。
 */
export function usePluginManifestI18n() {
  const { locale } = useI18n();

  function pluginName(plugin: { name?: Record<string, string> }): string {
    return resolveManifestText(plugin?.name, locale.value);
  }

  function pluginDescription(plugin: {
    description?: Record<string, string>;
    desp?: Record<string, string>;
  }): string {
    const raw =
      (plugin as { description?: Record<string, string> }).description ??
      (plugin as { desp?: Record<string, string> }).desp;
    return resolveManifestText(raw, locale.value);
  }

  function pluginDoc(plugin: { doc?: Record<string, string> | null }): string {
    return resolveManifestDoc(plugin?.doc ?? null, locale.value);
  }

  return {
    pluginName,
    pluginDescription,
    pluginDoc,
    resolveManifestText,
    resolveManifestDoc,
    locale,
  };
}
