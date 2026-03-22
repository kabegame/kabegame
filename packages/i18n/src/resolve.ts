/**
 * 从后端下发的 name/description 对象解析当前语言文案。
 * 对象结构：{ default: string, zh?: string, ja?: string, ... }，优先 value[locale]，没有则 value["default"]。
 */
export function resolveManifestText(
  value: Record<string, string> | null | undefined,
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
 * 从后端下发的 config 文案对象解析当前语言。
 * value 为 { default: string, zh?: string, en?: string, ... }，优先 value[locale]，否则 value["default"]，再否则 value["en"] 作为 fallback。
 * 兼容 value 为 string（旧数据或单语言）时直接返回。
 */
export function resolveConfigText(
  value: Record<string, string> | string | null | undefined,
  locale: string,
): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  const m = value as Record<string, string>;
  return m[locale] ?? m["default"] ?? m["en"] ?? "";
}
