/**
 * 插件资源路径归一化。
 *
 * 这是 `kbAssets` 项、文档 md 里的引用串、后端 `Plugin.assets[].key`
 * 三者的**唯一裁决者**：三者都使用归一化后的插件根相对路径。
 *
 * 同构 Rust 实现：`src-tauri/kabegame-core/src/plugin/assets.rs::normalize_asset_path`
 * —— 改规则必须同时改两处，顺序也要一致。
 *
 * 两边的差异只会影响「这张图找不找得到」，不涉及安全边界：包内路径的合法性由后端的
 * `validate_kb_rel_path` 在打包期与加载期各把一次。
 */

/** 判定为「不是本地资源引用」的前缀（外链 / data URI / 协议相对）。 */
const EXTERNAL_PREFIXES = ["http://", "https://", "data:", "//"];

/**
 * @returns 归一化后的键；`null` 表示「不是本地资源引用」或该引用非法（调用方应原样保留）。
 */
export function normalizeAssetPath(raw: string): string | null {
  // 1) 去首尾空白
  let p = raw.trim();
  if (!p) return null;

  // 2) 剥 markdown 标题后缀：`a.png "标题"` / `a.png '标题'` / `a.png (标题)`
  const titleMatch = /^(.*?)\s+["'(].*["')]$/.exec(p);
  if (titleMatch && titleMatch[1]) {
    p = titleMatch[1];
  }

  // 3) 截断 #fragment 与 ?query
  const cutAt = ((): number => {
    const hash = p.indexOf("#");
    const query = p.indexOf("?");
    if (hash < 0) return query;
    if (query < 0) return hash;
    return Math.min(hash, query);
  })();
  if (cutAt >= 0) p = p.slice(0, cutAt);

  // 4) 反斜杠统一成正斜杠
  p = p.replace(/\\/g, "/");

  // 5) 百分号解码；解码失败（如文件名里含裸 `%`）保留原串，不做逐字符兜底替换
  try {
    p = decodeURIComponent(p);
  } catch {
    // keep as-is
  }

  // 6) 外链一律不当作本地资源
  const lower = p.toLowerCase();
  if (EXTERNAL_PREFIXES.some((prefix) => lower.startsWith(prefix))) return null;

  // 7) 去掉所有前导 `/`（root-relative 视同插件根相对）
  p = p.replace(/^\/+/, "");

  // 8) 段级规整：丢弃空段与 `.`；`..` 弹栈，栈空时判非法
  const segments: string[] = [];
  for (const segment of p.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  // 拼回；为空则视为非法。大小写保持不变，以匹配 ZIP 条目名。
  const key = segments.join("/");
  return key || null;
}

/** 按扩展名猜 MIME；与 Rust `assets.rs::mime_for_asset` 及打包器白名单口径一致。 */
export function guessAssetMime(pathOrKey: string): string {
  const ext = pathOrKey.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "bmp":
      return "image/bmp";
    default:
      return "image/png";
  }
}

/** 后端下发的单个插件资源；所在数组顺序与 `kbAssets` 声明顺序一致。 */
export interface PluginAsset {
  key: string;
  dataBase64: string;
}

/** 判断持久缓存中的资源字段是否已使用当前数组协议。 */
export function isPluginAssetList(value: unknown): value is PluginAsset[] | null | undefined {
  return value == null || (
    Array.isArray(value) &&
    value.every((asset) =>
      typeof asset === "object" &&
      asset !== null &&
      typeof (asset as PluginAsset).key === "string" &&
      typeof (asset as PluginAsset).dataBase64 === "string"
    )
  );
}

/**
 * 是否是「展示位」资源：完整归一化路径以 `banner` 开头，大小写不敏感。
 *
 * `kbAssets` 同时承载文档插图与展示图，只有后者适合放进快捷预览走马灯——文档里的
 * 「点这个按钮」截图当橱窗图看毫无意义。约定由路径前缀承载，插件作者不必新增字段：
 * `banner.png` / `banner-1.jpg` / `banner/home.webp` 都算。
 */
export function isBannerAsset(key: string): boolean {
  return key.toLowerCase().startsWith("banner");
}

/**
 * 从已安装插件的 `Plugin.assets` 挑出展示位图，并按数组原顺序转成走马灯素材。
 */
export function bannerPreviewImages(
  assets?: PluginAsset[] | null,
): { key: string; src: string }[] {
  if (!assets) return [];
  return assets
    .filter((asset) => isBannerAsset(asset.key))
    .map((asset) => ({
      key: asset.key,
      src: `data:${guessAssetMime(asset.key)};base64,${asset.dataBase64}`,
    }));
}
