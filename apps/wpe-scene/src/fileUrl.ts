/** 场景宿主只运行于桌面 CEF，本地路径直接转为 file: URL。 */
export function fileToUrl(localPath: string): string {
  const path = (localPath || "")
    .trim()
    .replace(/^\\\\\?\\UNC\\/i, "\\\\")
    .replace(/^\\\\\?\\/, "");
  if (!path) return "";
  if (/^file:/i.test(path)) return path;
  const encode = (segments: string) => segments.split("/").map(encodeURIComponent).join("/");
  const unc = path.match(/^\\\\([^\\]+)\\(.*)$/);
  if (unc) return `file://${unc[1]}/${encode(unc[2].replace(/\\/g, "/"))}`;
  if (/^[A-Za-z]:[\\/]/.test(path)) {
    const slashed = path.replace(/\\/g, "/");
    return `file:///${slashed[0]}:${encode(slashed.slice(2))}`;
  }
  return `file://${path.startsWith("/") ? "" : "/"}${encode(path)}`;
}
