export function buildGallerySurfPath(host: string, hide: boolean): string {
  const prefix = hide ? "hide/" : "";
  return `${prefix}surf/${encodeURIComponent(host)}`;
}
