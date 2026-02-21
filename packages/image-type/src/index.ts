import { detectImageSupport } from "./detect"
import type { ImageSupportResult, ImageFormat } from "./types"

const STORAGE_KEY = "image_support"

let memoryCache: ImageSupportResult | null = null

/**
 * 获取当前环境对 WebP、AVIF、HEIC、SVG 的支持结果。
 * 优先使用内存缓存，其次 localStorage（可选持久化），最后实时检测。
 */
export async function getImageSupport(
  options?: { useStorage?: boolean }
): Promise<ImageSupportResult> {
  const useStorage = options?.useStorage ?? true

  if (memoryCache) return memoryCache

  if (useStorage && typeof localStorage !== "undefined") {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as ImageSupportResult
        if (
          typeof parsed?.webp === "boolean" &&
          typeof parsed?.avif === "boolean" &&
          typeof parsed?.heic === "boolean" &&
          typeof parsed?.svg === "boolean"
        ) {
          memoryCache = parsed
          return memoryCache
        }
      }
    } catch {
      // ignore invalid storage
    }
  }

  const result = await detectImageSupport()
  memoryCache = result

  if (useStorage && typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(result))
    } catch {
      // ignore quota / disabled
    }
  }

  return result
}

/**
 * 清除内存与 localStorage 中的缓存，下次 getImageSupport 会重新检测。
 */
export function clearImageSupportCache(): void {
  memoryCache = null
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // ignore
    }
  }
}

/**
 * 将支持结果转为格式列表，便于传给后端或用于优先顺序选择。
 * 仅包含检测为 true 的格式。
 */
export function getSupportedFormats(result: ImageSupportResult): ImageFormat[] {
  const formats: ImageFormat[] = []
  if (result.webp) formats.push("webp")
  if (result.avif) formats.push("avif")
  if (result.heic) formats.push("heic")
  if (result.svg) formats.push("svg")
  return formats
}

export { detectImageSupport } from "./detect"
export type { ImageSupportResult, ImageFormat } from "./types"
