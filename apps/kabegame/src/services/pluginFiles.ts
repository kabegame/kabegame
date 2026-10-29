import { ref, watch, type Ref } from "vue";
import { useI18n, resolveManifestDoc } from "@kabegame/i18n";
import type { Plugin } from "@/stores/plugins";
import { initHttpServerBaseUrl, pluginFileUrl } from "@/utils/fileUrl";
import { invoke } from "@/api";
import { IS_ANDROID, IS_WEB } from "@/env";
import { useImageTypes } from "@/composables/useImageTypes";

const DESKTOP = !IS_WEB && !IS_ANDROID;
const texts = new Map<string, { pluginId: string; promise: Promise<string> }>();
const blobs = new Map<string, { pluginId: string; promise: Promise<string> }>();
export const pluginFilesGeneration = ref(0);
const imageTypes = useImageTypes();

export function pluginFileKey(plugin: Pick<Plugin, "id" | "version" | "fileOrigin">, path: string): string {
  const origin = plugin.fileOrigin;
  const source =
    origin?.kind === "store"
      ? `store:${origin.sourceId}`
      : origin?.kind === "preview"
        ? `preview:${origin.token}`
        : "installed";
  return `${plugin.id}@${plugin.version}@${source}/${path}`;
}

/** 插件文件原始字节：桌面走 IPC，Android / Web 走 HTTP。 */
export async function fetchPluginBytes(plugin: Plugin, path: string): Promise<ArrayBuffer> {
  if (DESKTOP) {
    const origin = plugin.fileOrigin;
    return invoke<ArrayBuffer>("read_plugin_file", {
      pluginId: plugin.id,
      version: plugin.version,
      path,
      source: origin?.kind === "store" ? origin.sourceId : null,
      preview: origin?.kind === "preview" ? origin.token : null,
    });
  }
  await initHttpServerBaseUrl();
  const response = await fetch(pluginFileUrl(plugin, path));
  if (!response.ok) throw new Error(`plugin_file: ${response.status}`);
  return response.arrayBuffer();
}

export function fetchPluginText(plugin: Plugin, path: string): Promise<string> {
  const key = pluginFileKey(plugin, path);
  const cached = texts.get(key);
  if (cached) return cached.promise;
  const promise = fetchPluginBytes(plugin, path).then((bytes) => new TextDecoder("utf-8").decode(bytes));
  const entry = { pluginId: plugin.id, promise };
  texts.set(key, entry);
  void promise.catch(() => {
    if (texts.get(key) === entry) texts.delete(key);
  });
  return promise;
}

async function mimeByExt(path: string): Promise<string> {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const textTypes: Record<string, string> = {
    svg: "image/svg+xml",
    md: "text/markdown",
    json: "application/json",
    ejs: "text/plain",
    txt: "text/plain",
  };
  if (textTypes[ext]) return textTypes[ext];
  await imageTypes.load();
  return imageTypes.getMimeType(ext);
}

/** 桌面按坐标缓存 blob URL；Android / Web 保留 HTTP 地址。 */
export function pluginAssetUrl(plugin: Plugin, key: string): Promise<string> {
  if (!DESKTOP) return initHttpServerBaseUrl().then(() => pluginFileUrl(plugin, key));
  const cacheKey = pluginFileKey(plugin, key);
  const cached = blobs.get(cacheKey);
  if (cached) return cached.promise;
  const promise = fetchPluginBytes(plugin, key).then(async (buf) =>
    URL.createObjectURL(new Blob([buf], { type: await mimeByExt(key) })),
  );
  const entry = { pluginId: plugin.id, promise };
  blobs.set(cacheKey, entry);
  void promise.catch(() => {
    if (blobs.get(cacheKey) === entry) blobs.delete(cacheKey);
  });
  return promise;
}

export function invalidatePluginFiles(pluginId: string) {
  pluginFilesGeneration.value++;
  for (const [key, entry] of texts) if (entry.pluginId === pluginId) texts.delete(key);
  for (const [key, entry] of blobs)
    if (entry.pluginId === pluginId) {
      blobs.delete(key);
      void entry.promise.then((url) => URL.revokeObjectURL(url)).catch(() => {});
    }
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
