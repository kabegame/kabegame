import { useI18n } from "vue-i18n";
import type { PluginManifestText } from "@kabegame/core/stores/plugins";

/**
 * 从后端下发的 name/description 对象解析当前语言文案。
 * 对象结构：{ default: string, zh?: string, ja?: string, ... }，优先 value[locale]，没有则 value["default"]。
 */
export function resolveManifestText(
  value: PluginManifestText | null | undefined,
  locale: string,
): string {
  if (value == null || typeof value !== "object") return "";
  const m = value as Record<string, string>;
  return m[locale] ?? m["default"] ?? "";
}

/**
 * 从后端下发的 doc 对象解析当前语言的文档 Markdown。
 * 与 resolveManifestText 同构：优先 doc[locale]，没有则 doc["default"]。
 */
export function resolveManifestDoc(
  doc: Record<string, string> | null | undefined,
  locale: string,
): string {
  if (doc == null || typeof doc !== "object") return "";
  return doc[locale] ?? doc["default"] ?? "";
}

/**
 * 统一响应式入口：按当前 i18n locale 解析插件的 name / description。
 * 从 store 拿到的 plugin.name、plugin.description 用此 composable 解析后展示，name 为回退。
 */
export function usePluginManifestI18n() {
  const { locale } = useI18n();

  function pluginName(plugin: { name?: PluginManifestText }): string {
    return resolveManifestText(plugin?.name, locale.value);
  }

  function pluginDescription(plugin: {
    description?: PluginManifestText;
    desp?: PluginManifestText;
  }): string {
    const raw =
      (plugin as { description?: PluginManifestText }).description ??
      (plugin as { desp?: PluginManifestText }).desp;
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
