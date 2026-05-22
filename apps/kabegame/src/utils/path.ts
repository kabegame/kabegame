export function normalizeProviderPath(path = ""): string {
  const trimmed = path.trim();
  if (trimmed.endsWith("/*")) return trimmed.slice(0, -2).replace(/\/+$/, "");
  if (trimmed.endsWith("://")) return trimmed;
  return trimmed.replace(/^\/+|\/+$/g, "");
}

export function joinPathSegments(...parts: Array<string | undefined | null>): string {
  return parts
    .map((part) => normalizeProviderPath(part ?? ""))
    .filter(Boolean)
    .join("/");
}

export function withGalleryPrefix(path: string): string {
  const normalized = normalizeProviderPath(path);
  if (!normalized) return "gallery";
  if (normalized.includes("://")) return normalized;
  return normalized === "gallery" || normalized.startsWith("gallery/")
    ? normalized
    : `gallery/${normalized}`;
}
