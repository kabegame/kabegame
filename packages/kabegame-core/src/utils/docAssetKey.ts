/**
 * 插件文档资源键归一化。
 *
 * 这是 `kbDocAssets` 注册键、文档 md 里的引用串、后端 `Plugin.docResources` 的键
 * 三者的**唯一裁决者**：键就是「md 里字面写的那串」经本函数归一化后的结果。
 *
 * 同构 Rust 实现：`src-tauri/kabegame-core/src/plugin/doc_assets.rs::normalize_doc_asset_key`
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
export function normalizeDocAssetKey(raw: string): string | null {
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

  // 8) 段级规整：丢弃空段与 `.`；`..` 弹栈，栈空时保留字面 `..`
  const segments: string[] = [];
  for (const segment of p.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
      } else {
        segments.push("..");
      }
      continue;
    }
    segments.push(segment);
  }

  // 9) 拼回；为空则视为非法
  //
  // 注意：这里刻意**不** strip `doc_root/` 前缀，也**不**做大小写归一 ——
  // 前者曾经是文档图片全部渲染成「加载失败」的根因，后者会与 ZIP 条目名的大小写敏感冲突。
  const key = segments.join("/");
  return key || null;
}

/** 按扩展名猜 MIME；与 Rust `doc_assets.rs::mime_for_doc_asset` 及打包器白名单口径一致。 */
export function guessDocAssetMime(pathOrKey: string): string {
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

/**
 * 从文档资源键推导一个可读标签（去目录前缀与扩展名，`-`/`_` 转空格，首字母大写）。
 * 插件作者没有提供图注元数据，这是唯一能从真实数据推导出的说明文字，不编造内容。
 */
export function humanizeDocAssetLabel(key: string): string {
  const base = key.split("/").pop() || key;
  const withoutExt = base.replace(/\.[^./]+$/, "");
  const spaced = withoutExt.replace(/[-_]+/g, " ").trim();
  if (!spaced) return base;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
