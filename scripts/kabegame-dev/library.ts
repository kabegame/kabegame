/**
 * 测试工程的导入与移除（只在桌面）。只动路径在仓库 `ignore/` 下的行：移除只调 `batch_remove_images`（不删文件），
 * 绝不调 `batch_delete_images`（会连源文件一起删）；清单里有一行不符就整批拒绝。
 */
import { statSync } from "node:fs";
import path from "node:path";
import { DevError, badRequest } from "./errors.ts";
import { invoke, sleep } from "./app.ts";
import { sceneTarget } from "./scene.ts";
import { comparablePath, isWithin } from "./paths.ts";
import type { DevSession } from "./session.ts";
import type { ProjectManifest, ProjectsRemoveResult } from "./types.ts";

export interface SceneRow {
  id: string;
  local_path?: string;
  localPath?: string;
  [key: string]: unknown;
}

export const rowPath = (row: SceneRow): string => String(row.local_path ?? row.localPath ?? "");

const PAGE = 500;

/** 库里全部场景壁纸行（`pathql_fetch` 翻页）。 */
export async function listSceneRows(s: DevSession): Promise<SceneRow[]> {
  const rows: SceneRow[] = [];
  for (let page = 1; page <= 200; page++) {
    const batch = await invoke<SceneRow[]>(s, "pathql_fetch", {
      path: `images://gallery/media-type/x-wpe/scene/_kb_x${PAGE}x/${page}`,
    });
    if (!Array.isArray(batch) || !batch.length) break;
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

interface TaskRow {
  id: string;
  pluginId?: string;
  status?: string;
  userConfig?: { extraDirs?: unknown } | null;
}

const TERMINAL = new Set(["completed", "failed", "canceled", "cancelled"]);

/** 测试工程只认 `<仓库>/ignore` 之下；`allowPrefix` 也必须在它之内。 */
export function resolveAllowPrefix(s: DevSession, allowPrefix?: string): string {
  const prefix = path.resolve(s.paths.root, allowPrefix ?? s.paths.ignore);
  if (!isWithin(prefix, s.paths.ignore)) {
    throw new DevError(403, "guard", `allowPrefix 必须在 ${s.paths.ignore} 之内，收到 ${prefix}`);
  }
  return prefix;
}

export interface ImportProgress {
  phase: "recognize" | "task" | "rows";
  found: number;
  total: number;
  taskStatus?: string;
}

/**
 * 导入测试工程：逐个 `wpe_recognize_dir`，再一次 `start_task(wpe-import, extraDirs)`，等任务结束、按目录找到库里的行。
 * 返回 `{ <目录>: { image, task, preexisting } }`；`preexisting` 表示导入前库里已有这一行（被去重跳过）。
 */
export async function importProjects(
  s: DevSession,
  dirs: unknown,
  ctx: { signal: AbortSignal; progress: (value: ImportProgress) => void; timeoutMs?: number },
): Promise<ProjectManifest> {
  if (s.android) throw new DevError(400, "platform", "测试工程只在桌面可用");
  if (!Array.isArray(dirs) || !dirs.length || dirs.some((d) => typeof d !== "string" || !d)) {
    throw badRequest("dirs 要是非空的目录数组");
  }
  const absolute = (dirs as string[]).map((dir) => path.resolve(s.paths.root, dir));
  for (const dir of absolute) {
    if (!isWithin(dir, s.paths.ignore) || comparablePath(dir) === comparablePath(s.paths.ignore)) {
      throw new DevError(403, "guard", `测试工程必须在 ${s.paths.ignore} 之下：${dir}`);
    }
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw badRequest(`不是目录：${dir}`);
  }

  const before = new Map((await listSceneRows(s)).map((row) => [comparablePath(rowPath(row)), String(row.id)]));
  ctx.progress({ phase: "recognize", found: 0, total: absolute.length });
  for (const dir of absolute) await invoke(s, "wpe_recognize_dir", { path: dir });

  // 来源至少选一项：默认工程已在库里，按去重跳过；工坊、我的工程关掉
  const task = await invoke<string>(s, "start_task", {
    task: {
      pluginId: "wpe-import",
      userConfig: { sources: { workshop: false, defaultprojects: true, myprojects: false }, extraDirs: absolute },
      triggerSource: "manual",
      isDryRun: false,
    },
  });
  const taskId = typeof task === "string" ? task : String((task as { id?: unknown })?.id ?? "");

  const deadline = Date.now() + (ctx.timeoutMs ?? 180_000);
  let status = "";
  const found = new Map<string, string>();
  while (true) {
    if (ctx.signal.aborted) throw new DevError(499, "rest", "已取消（导入任务仍在应用里跑）");
    await sleep(1000);
    const info = await invoke<TaskRow | null>(s, "get_task", { taskId }).catch(() => null);
    status = String(info?.status ?? "");
    found.clear();
    const now = new Map((await listSceneRows(s)).map((row) => [comparablePath(rowPath(row)), String(row.id)]));
    for (const dir of absolute) {
      const id = now.get(comparablePath(dir));
      if (id) found.set(dir, id);
    }
    ctx.progress({ phase: "rows", found: found.size, total: absolute.length, taskStatus: status });
    if (TERMINAL.has(status) && found.size === absolute.length) break;
    if (TERMINAL.has(status) && status !== "completed") {
      throw new DevError(422, "app", `导入任务 ${taskId} 结束于 ${status}，找到 ${found.size}/${absolute.length} 行`, {
        task: taskId,
      });
    }
    if (Date.now() > deadline) {
      throw new DevError(
        504,
        "app",
        `导入超时：任务 ${taskId} 状态 ${status}，找到 ${found.size}/${absolute.length} 行`,
        {
          task: taskId,
        },
      );
    }
  }

  const manifest: ProjectManifest = {};
  for (const dir of absolute) {
    manifest[dir] = { image: found.get(dir)!, task: taskId || null, preexisting: before.has(comparablePath(dir)) };
  }
  return manifest;
}

/**
 * 移除测试工程：先用 `wpe_scene_target` 核对每行都在 `allowPrefix` 之下（且与清单里的目录一致），任务都是
 * `extraDirs` 在 `allowPrefix` 之下的 `wpe-import`；任一不符整批拒绝。再 `batch_remove_images`、`delete_task`。
 */
export async function removeProjects(
  s: DevSession,
  manifest: unknown,
  allowPrefixInput?: string,
): Promise<ProjectsRemoveResult> {
  if (s.android) throw new DevError(400, "platform", "测试工程只在桌面可用");
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw badRequest("manifest 要是 { <目录>: { image, task } }");
  }
  const allowPrefix = resolveAllowPrefix(s, allowPrefixInput);
  const entries = Object.entries(manifest as ProjectManifest);
  if (!entries.length) throw badRequest("manifest 是空的");

  const problems: string[] = [];
  const images: string[] = [];
  const tasks = new Set<string>();
  for (const [dir, entry] of entries) {
    const image = String(entry?.image ?? "");
    if (!/^\d+$/.test(image)) {
      problems.push(`${dir}：image 不是图片 id（${JSON.stringify(entry?.image)}）`);
      continue;
    }
    let target;
    try {
      target = await sceneTarget(s, image);
    } catch (error) {
      problems.push(`${dir}：${image} 查不到场景目录（${(error as Error).message}）`);
      continue;
    }
    if (!isWithin(target.path, allowPrefix)) {
      problems.push(`${image} 的目录 ${target.path} 不在 ${allowPrefix} 之下`);
      continue;
    }
    if (comparablePath(target.path) !== comparablePath(path.resolve(s.paths.root, dir))) {
      problems.push(`${image} 的目录是 ${target.path}，清单写的是 ${dir}（清单过期？）`);
      continue;
    }
    images.push(image);
    if (entry.task) tasks.add(String(entry.task));
  }
  for (const taskId of tasks) {
    const info = await invoke<TaskRow | null>(s, "get_task", { taskId }).catch(() => null);
    if (!info) continue; // 任务已经没了：不必删
    const extraDirs = info.userConfig?.extraDirs;
    const dirsOk =
      Array.isArray(extraDirs) &&
      extraDirs.length > 0 &&
      extraDirs.every((d) => typeof d === "string" && isWithin(d, allowPrefix));
    if (info.pluginId !== "wpe-import" || !dirsOk) {
      problems.push(
        `任务 ${taskId} 不是只导入 ${allowPrefix} 之下工程的 wpe-import（${info.pluginId}，${JSON.stringify(extraDirs)}）`,
      );
    } else if (!TERMINAL.has(String(info.status))) {
      problems.push(`任务 ${taskId} 还在跑（${info.status}）`);
    }
  }
  if (problems.length) {
    throw new DevError(403, "guard", `整批拒绝，库没有改动：${problems.join("；")}`, { problems, allowPrefix });
  }

  await invoke(s, "batch_remove_images", { imageIds: images });
  const deletedTasks: string[] = [];
  for (const taskId of tasks) {
    const info = await invoke<TaskRow | null>(s, "get_task", { taskId }).catch(() => null);
    if (!info) continue;
    await invoke(s, "delete_task", { taskId });
    deletedTasks.push(taskId);
  }

  let imagesGone = true;
  for (const image of images) {
    const still = await sceneTarget(s, image).then(
      () => true,
      () => false,
    );
    if (still) imagesGone = false;
  }
  let tasksGone = true;
  for (const taskId of tasks) {
    const info = await invoke<TaskRow | null>(s, "get_task", { taskId }).catch(() => null);
    if (info) tasksGone = false;
  }
  return { allowPrefix, removed: images, tasks: deletedTasks, verified: { imagesGone, tasksGone } };
}
