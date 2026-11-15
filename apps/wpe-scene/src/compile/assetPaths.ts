/**
 * 脚本里的资源路径字面量（P6d3b）：`createLayer` 的 `__workshopId` 改写要知道一条路径「是不是 WPE 自带资源」（`rea-p6d-script.md` 2.2），
 * WPE 在运行时问资源文件系统；我们的脚本在 realm 里同步跑、拿不到异步文件系统，所以编译期（Worker 里）扫描全部脚本源码里形如资源路径的
 * 字符串字面量，逐个只查 `assets` 根目录，存在的随 bundle 带回（`SceneBundle.assetPaths`）。拼出来的路径查不到，按「不在」处理。
 */

/** 资源目录前缀（WPE `assets` 的顶层目录里脚本会引用的那几个）。 */
const ASSET_ROOTS = /^(?:models|particles|materials|sounds|fonts|effects|shaders|textures)\//;

/** 单引号、双引号、不含 `${` 的模板字符串。 */
const LITERAL = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\$]|\\.|\$(?!\{))*)`/g;

/** 全部脚本源码里的资源路径候选：去掉前导斜杠与反斜杠，反斜杠换成斜杠，去重、排序。 */
export function scriptAssetCandidates(sources: Iterable<string>): string[] {
  const found = new Set<string>();
  for (const source of new Set(sources))
    for (const match of source.matchAll(LITERAL)) {
      // 字面量里的转义按单字符还原（`\\` → `\`）：路径里只有反斜杠分隔符会用到
      const text = (match[1] ?? match[2] ?? match[3] ?? "").replace(/\\(.)/g, "$1");
      const path = text.replace(/^[/\\]+/, "").replace(/\\/g, "/");
      if (ASSET_ROOTS.test(path)) found.add(path);
    }
  return [...found].sort();
}
