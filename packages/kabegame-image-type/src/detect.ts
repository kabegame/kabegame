import type { ImageSupportResult } from "./types";

function testImage(base64: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.width > 0 && img.height > 0);
    img.onerror = () => resolve(false);
    img.src = base64;
  });
}

/**
 * 各格式的完整可解码 1x1 测试图（Modernizr 风格：必须是完整文件，含像素数据）
 * 之前 avif/heic 只有 ftyp+meta 无 mdat，即便 WebView 支持也会 onerror。
 */
const TEST_IMAGES = {
  // 1x1 lossy webp
  webp: "data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=",

  // 1x1 av1/avif，来自 Modernizr 测试向量
  avif: "data:image/avif;base64,AAAAHGZ0eXBtaWYxAAAAAG1pZjFhdmlmbWlhZgAAAPFtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAAA5waXRtAAAAAAABAAAAImlsb2MAAAAAREAAAQABAAAAAAEVAAEAAAAeAAAAAQAAACNpaW5mAAAAAAABAAAAFWluZmUCAAAAAAEAAGF2MDEAAAAAamlwcnAAAABLaXBjbwAAABNjb2xybmNseAACAAIABoAAAAAMYXYxQ4EADAAAAAAUaXNwZQAAAAAAAAABAAAAAQAAABBwaXhpAAAAAAEIAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAebWRhdAoIGAAMgggyCBMQAAAAKEpwaI5MDiqI",

  // 1x1 heic（大多数浏览器/WebView 不支持是正常的，Safari 17+ 才行）
  heic: "data:image/heic;base64,AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljAAACAG1ldGEAAAAgaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAA=",

  svg: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiPjwvc3ZnPg==",
} as const;

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
    };
  }

  const [webp, avif, heic] = await Promise.all([
    testImage(TEST_IMAGES.webp),
    testImage(TEST_IMAGES.avif),
    testImage(TEST_IMAGES.heic),
  ]);

  return { webp, avif, heic };
}
