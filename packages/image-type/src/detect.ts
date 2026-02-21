import type { ImageSupportResult } from "./types"

function testImage(base64: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve(true)
    img.onerror = () => resolve(false)
    img.src = base64
  })
}

/** 各格式的极小 base64 测试图（< 100 bytes 级） */
const TEST_IMAGES = {
  webp:
    "data:image/webp;base64,UklGRiIAAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=",

  avif:
    "data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAG1pZjFhdmlmAAACAG1ldGEAAAAgaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAA=",

  heic:
    "data:image/heic;base64,AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljAAACAG1ldGEAAAAgaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAA=",

  svg:
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiPjwvc3ZnPg==",
} as const

/**
 * 运行时检测当前环境（WebView/浏览器）对 WebP、AVIF、HEIC、SVG 的支持。
 * 通过实际加载 base64 小图，不依赖 UA。
 */
export async function detectImageSupport(): Promise<ImageSupportResult> {
  if (typeof window === "undefined") {
    return {
      webp: false,
      avif: false,
      heic: false,
      svg: false,
    }
  }

  const [webp, avif, heic, svg] = await Promise.all([
    testImage(TEST_IMAGES.webp),
    testImage(TEST_IMAGES.avif),
    testImage(TEST_IMAGES.heic),
    testImage(TEST_IMAGES.svg),
  ])

  return { webp, avif, heic, svg }
}
