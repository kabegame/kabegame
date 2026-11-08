/**
 * kabegame-dev 用到的仓库路径。只依赖 Node 内建模块，vite 插件与 `deno test` 都能直接加载。
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** 仓库根（本文件在 `scripts/kabegame-dev/` 下）。 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface DevPaths {
  /** 仓库根。 */
  root: string;
  /** cargo 产物目录：`CARGO_TARGET_DIR`，没设时为 `<root>/target`。 */
  target: string;
  /** 场景宿主 dev 产物目录 `<target>/debug/resources/wpe-scene`。 */
  sceneDist: string;
  /** 场景宿主入口 `<sceneDist>/index.html`。 */
  sceneIndex: string;
  /** dev 数据目录 `<root>/.kabegame/debug/data`。 */
  devData: string;
  /** vite debug server 的落盘目录 `<root>/.kabegame/debug`（`cdp-port.json` 在这里）。 */
  debugDir: string;
  /** 测试工程允许的根 `<root>/ignore`。 */
  ignore: string;
}

export function devPaths(root: string = ROOT, env: NodeJS.ProcessEnv = process.env): DevPaths {
  const resolvedRoot = path.resolve(root);
  const targetEnv = env.CARGO_TARGET_DIR?.trim();
  const target = targetEnv ? path.resolve(resolvedRoot, targetEnv) : path.join(resolvedRoot, "target");
  const sceneDist = path.join(target, "debug", "resources", "wpe-scene");
  return {
    root: resolvedRoot,
    target,
    sceneDist,
    sceneIndex: path.join(sceneDist, "index.html"),
    devData: path.join(resolvedRoot, ".kabegame", "debug", "data"),
    debugDir: path.join(resolvedRoot, ".kabegame", "debug"),
    ignore: path.join(resolvedRoot, "ignore"),
  };
}

const DEFAULT = devPaths();
export const TARGET = DEFAULT.target;
export const SCENE_DIST = DEFAULT.sceneDist;
export const DEV_DATA = DEFAULT.devData;

/** 比较用的规范形式：绝对路径、统一分隔符，Windows 下不分大小写。 */
export function comparablePath(p: string, platform: NodeJS.Platform = process.platform): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const resolved = pathApi.resolve(p);
  const trimmed = resolved.length > 1 ? resolved.replace(/[\\/]+$/, "") : resolved;
  return platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/** `child` 是否等于 `parent` 或在它之下（按路径段判断，`ignore2` 不算 `ignore` 之下）。 */
export function isWithin(child: string, parent: string, platform: NodeJS.Platform = process.platform): boolean {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const c = comparablePath(child, platform);
  const p = comparablePath(parent, platform);
  if (c === p) return true;
  return c.startsWith(p.endsWith(pathApi.sep) ? p : p + pathApi.sep);
}
