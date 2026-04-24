/**
 * Provider path 语法变体工具。
 *
 * 对应后端 [`parse_provider_path`](../../../../src-tauri/core/src/providers/query.rs) 的三种模式：
 * - Entry        ：`<path>`     —— 无尾缀，返回该节点 meta + note + total（COUNT）
 * - List         ：`<path>/`    —— 尾缀 `/`，返回 entries + total
 * - ListWithMeta ：`<path>/*`   —— 尾缀 `/*`，entries 带批量 meta
 *
 * 使用场景：从同一个逻辑 path（例如 `galleryRouteStore.currentPath`）
 * 按查询目的派生出具体的语法变体，避免散落手写 `${p}/` / `${p.replace(/\/$/,'')}`。
 */

function stripSuffix(path: string): string {
  const t = (path || "").trim();
  if (t.endsWith("/*")) return t.slice(0, -2).replace(/\/+$/, "");
  return t.replace(/\/+$/, "");
}

/** Entry 查询：`<path>`。去掉尾部 `/` 或 `/*`。 */
export function asEntryPath(path: string): string {
  return stripSuffix(path);
}

/** List 查询：`<path>/`。确保单个尾部 `/`。 */
export function asListPath(path: string): string {
  const p = stripSuffix(path);
  return p ? `${p}/` : "";
}

/** ListWithMeta 查询：`<path>/*`。确保尾部 `/*`。 */
export function asListWithMetaPath(path: string): string {
  const p = stripSuffix(path);
  return p ? `${p}/*` : "";
}
