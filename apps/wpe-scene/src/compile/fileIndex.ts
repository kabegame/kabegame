/**
 * 场景文件表（命令 `wpe_scene_files`，后端 `kabegame_core::wpe::scene_files`）：场景查找范围里每一处有哪些文件。宿主每次加载拉一次，
 * 两处用它：
 * - 编译读资源（`SceneFs`）：表里没有的位置不去探，表里的写法按真实大小写读；哪处都没有时才按原写法逐个探一次（表可能过时）。
 *   表只决定先去哪里找，不决定资源存不存在；
 * - 场景脚本 `createLayer` / `createModelData` 的 `__workshopId` 改写（P6d3b）：路径在表里就不改写（`sceneFileKeys`）。
 */

import { pkgKey } from "./pkg";

/** 一个目录里的全部普通文件：`files` 相对 `dir`、`/` 分隔、原样大小写。 */
export interface SceneDirFiles {
  /** 目录本身，写法同 `wpe_scene_target` 的 `path` / `sceneAssets` */
  dir: string;
  files: string[];
}

/** `wpe_scene_files` 的返回：按来源分开。 */
export interface SceneFileList {
  /** 工程目录里的散文件（含 `scene.pkg` 本身） */
  project: SceneDirFiles;
  /** `scene.pkg` 的条目名；没有包时为空 */
  pkg: string[];
  /** 各个 WPE `assets` 目录 */
  assets: SceneDirFiles[];
}

/**
 * 场景文件表的键：`\` 换成 `/`、去掉开头的 `./` 与 `/`、并掉连续的 `/`，ASCII 字母不分大小写
 * （照 WPE 在 Windows 上的查找，同 {@link pkgKey}）。表里的路径与要查的路径都过它。
 */
export function sceneFileKey(path: string): string {
  return pkgKey(
    path
      .replace(/\\/g, "/")
      .replace(/\/{2,}/g, "/")
      .replace(/^(?:\.\/|\/)+/, ""),
  );
}

/** 三处的全部键（脚本 `createLayer` 的「存在就不改写」用）。 */
export function sceneFileKeys(list: SceneFileList): Set<string> {
  const keys = new Set<string>();
  for (const file of list.project.files) keys.add(sceneFileKey(file));
  for (const file of list.pkg) keys.add(sceneFileKey(file));
  for (const root of list.assets) for (const file of root.files) keys.add(sceneFileKey(file));
  return keys;
}

/** 形状对不上（旧版应用、dev 工具给错）时当没有表。 */
export function isSceneFileList(value: unknown): value is SceneFileList {
  const dirFiles = (item: unknown): boolean => {
    const record = item as SceneDirFiles | null;
    return (
      typeof record === "object" &&
      record !== null &&
      typeof record.dir === "string" &&
      Array.isArray(record.files) &&
      record.files.every((file) => typeof file === "string")
    );
  };
  const list = value as SceneFileList | null;
  return (
    typeof list === "object" &&
    list !== null &&
    dirFiles(list.project) &&
    Array.isArray(list.pkg) &&
    list.pkg.every((name) => typeof name === "string") &&
    Array.isArray(list.assets) &&
    list.assets.every(dirFiles)
  );
}

/** 两个目录写法是不是同一个：`\` 与 `/` 不分、忽略末尾分隔符，其余逐字比（两边都出自后端同一种写法）。 */
export function sameSceneDir(a: string, b: string): boolean {
  const normalize = (dir: string) => dir.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalize(a) === normalize(b);
}

/** 一个根目录的文件表：按原写法或按键（不分 ASCII 大小写）找出磁盘上的真实写法。 */
export class SceneRootIndex {
  private readonly exact: Set<string>;
  /** 键 → 第一个出现的真实写法（区分大小写的文件系统上可能有只差大小写的两份，取表里先出现的） */
  private readonly byKey = new Map<string, string>();

  constructor(files: readonly string[]) {
    this.exact = new Set(files);
    for (const file of files) {
      const key = sceneFileKey(file);
      if (!this.byKey.has(key)) this.byKey.set(key, file);
    }
  }

  /** `rel`（已规范化的相对路径）在这个根下的真实写法；表里没有为 null。原写法在表里时优先用它。 */
  find(rel: string): string | null {
    if (this.exact.has(rel)) return rel;
    return this.byKey.get(sceneFileKey(rel)) ?? null;
  }
}
