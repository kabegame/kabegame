import { ref, watch, type Ref } from "vue";
import { useI18n, resolveManifestDoc } from "@kabegame/i18n";
import type { Plugin } from "@/stores/plugins";
import { initHttpServerBaseUrl, pluginFileUrl } from "@/utils/fileUrl";

const texts = new Map<string, { pluginId: string; promise: Promise<string> }>();

export async function fetchPluginText(plugin: Plugin, path: string): Promise<string> {
  await initHttpServerBaseUrl();
  const url = pluginFileUrl(plugin, path);
  const cached = texts.get(url);
  if (cached) return cached.promise;
  const promise = fetch(url).then((response) => {
    if (!response.ok) throw new Error(`plugin_file: ${response.status}`);
    return response.text();
  });
  const entry = { pluginId: plugin.id, promise };
  texts.set(url, entry);
  void promise.catch(() => {
    if (texts.get(url) === entry) texts.delete(url);
  });
  return promise;
}

export function invalidatePluginFiles(pluginId: string) {
  for (const [key, entry] of texts) if (entry.pluginId === pluginId) texts.delete(key);
}

export function resolvePluginLocalePath(map: Record<string, string> | null | undefined, locale: string): string {
  return resolveManifestDoc(map, locale);
}

function usePluginFile(pluginRef: Readonly<Ref<Plugin | null | undefined>>, path: () => string) {
  const text = ref("");
  const loading = ref(false);
  const error = ref<unknown>(null);
  watch(
    [pluginRef, path],
    async ([plugin, file], _, onCleanup) => {
      let current = true;
      onCleanup(() => {
        current = false;
      });
      text.value = "";
      error.value = null;
      loading.value = !!plugin && !!file;
      if (!plugin || !file) return;
      try {
        const result = await fetchPluginText(plugin, file);
        if (current) text.value = result;
      } catch (reason) {
        if (current) error.value = reason;
        console.warn("插件文件加载失败", reason);
      } finally {
        if (current) loading.value = false;
      }
    },
    { immediate: true },
  );
  return { text, loading, error };
}

export function usePluginLocaleFile(plugin: Readonly<Ref<Plugin | null | undefined>>, field: "kbDoc" | "kbChangelog") {
  const { locale } = useI18n();
  return usePluginFile(plugin, () => resolvePluginLocalePath(plugin.value?.packageJson?.[field], locale.value));
}

export function usePluginDescriptionTemplate(plugin: Readonly<Ref<Plugin | null | undefined>>) {
  return usePluginFile(plugin, () => plugin.value?.packageJson?.kbDescriptionTemplate ?? "");
}

export function recommendedConfigPaths(plugin: Plugin): string[] {
  const paths = plugin.packageJson?.kbRecommendedConfigs;
  return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : [];
}

/** 来源和版本各占一段，供插件子资源共用。 */
export function pluginResourceBase(plugin: Pick<Plugin, "id" | "version" | "fileOrigin">): string {
  const origin = plugin.fileOrigin;
  const segments =
    origin?.kind === "store"
      ? ["byStore", origin.sourceId]
      : origin?.kind === "preview"
        ? ["byPreview", origin.token]
        : ["installed"];
  return `plugin://${[...segments, plugin.id, plugin.version].map(encodeURIComponent).join("/")}`;
}
