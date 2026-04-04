type UrlKind = "thumbnail" | "original";
type ImageStage = "primary" | "fallback";

export interface CachedImageState {
  primaryUrl: string;
  fallbackUrl: string;
  primaryKind: UrlKind;
  displayUrl: string;
  isLost: boolean;
  originalMissing: boolean;
  stage: ImageStage;
  /** 桌面双图时：原图是否已加载（用于恢复时跳过骨架） */
  originalLoaded?: boolean;
}

const imageStateCache = new Map<string, CachedImageState>();

export function getImageStateCache(imageId: string): CachedImageState | undefined {
  if (!imageId) return undefined;
  return imageStateCache.get(imageId);
}

export function setImageStateCache(imageId: string, state: CachedImageState): void {
  if (!imageId) return;
  imageStateCache.set(imageId, state);
}

export function clearImageStateCache(): void {
  imageStateCache.clear();
}

export function removeFromImageStateCache(imageIds: string[]): void {
  for (const id of imageIds) {
    if (!id) continue;
    imageStateCache.delete(id);
  }
}
