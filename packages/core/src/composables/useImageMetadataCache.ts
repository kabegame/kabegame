import { provide, type InjectionKey } from "vue";
import { invoke } from "@tauri-apps/api/core";

/** 按 imageId 解析插件 metadata（含 per-page Map 缓存；换页时 clearCache） */
export type ImageMetadataResolver = (
  imageId: string,
) => Promise<unknown | null>;

export const imageMetadataResolverKey: InjectionKey<ImageMetadataResolver> =
  Symbol("imageMetadataResolver");

/**
 * 在画廊/画册等视图根组件调用，向子树 provide 懒加载 metadata 解析器。
 * 换页或路径变化时调用 `clearCache()` 使缓存失效。
 */
export function useProvideImageMetadataCache() {
  const cache = new Map<string, unknown | null>();

  async function resolveMetadata(imageId: string): Promise<unknown | null> {
    if (cache.has(imageId)) {
      return cache.get(imageId) ?? null;
    }
    const raw = await invoke<unknown | null>("get_image_metadata", {
      imageId,
    });
    const v = raw ?? null;
    cache.set(imageId, v);
    return v;
  }

  function clearCache() {
    cache.clear();
  }

  provide(imageMetadataResolverKey, resolveMetadata);

  return { clearCache, resolveMetadata };
}
