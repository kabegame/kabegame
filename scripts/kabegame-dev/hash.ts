/**
 * 画面哈希基线：每张场景按档位、固定时刻各渲染两次，两次不同就停。移植自 `ignore/p3c/step3/baseline.mjs`，
 * 结果格式和旧 `hash-*.json` 相同。只读：不改属性、不改设置。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DevError, badRequest } from "./errors.ts";
import { sleep } from "./app.ts";
import { listSceneRows, rowPath } from "./library.ts";
import { closeHost, currentUserProperties, hostTask, openHost, sceneTarget } from "./scene.ts";
import { comparablePath } from "./paths.ts";
import type { DevSession } from "./session.ts";
import type {
  HashBaseline,
  HashBaselineParams,
  HashBaselineResult,
  HashLevelRecord,
  HostCloseResult,
  RenderMeta,
  ScenePostprocess,
} from "./types.ts";

export const DEFAULT_LEVELS: ScenePostprocess[] = ["disabled", "enabled", "ultra"];
export const DEFAULT_TIME = 1.5;

/** 工程文件摘要：工程在 ignore/ 下可改，改了要和渲染差异分得开。 */
export function projectFiles(dir: string): Record<string, string> {
  return Object.fromEntries(
    ["project.json", "scene.json"]
      .filter((name) => existsSync(path.join(dir, name)))
      .map((name) => [
        name,
        createHash("sha256")
          .update(readFileSync(path.join(dir, name)))
          .digest("hex"),
      ]),
  );
}

export interface HashProgress {
  done: number;
  total: number;
  current: string | null;
}

/** 旧基线按 `input.path` 对应到库里现在的图片 id（测试工程重新导入后 id 会变）。 */
export async function idsFromBaseline(s: DevSession, file: string): Promise<string[]> {
  let old: { scenes?: Record<string, { input?: { path?: string } }> };
  try {
    old = JSON.parse(readFileSync(path.resolve(s.paths.root, file), "utf8"));
  } catch (error) {
    throw badRequest(`读不了旧基线 ${file}：${String(error)}`);
  }
  const wanted = Object.entries(old.scenes ?? {}).map(([id, scene]) => ({ id, path: scene.input?.path }));
  if (!wanted.length) throw badRequest(`旧基线 ${file} 里没有 scenes`);
  const byPath = new Map<string, string>();
  for (const row of await listSceneRows(s)) {
    const p = rowPath(row);
    if (p) byPath.set(comparablePath(p), String(row.id));
  }
  const missing: string[] = [];
  const ids = wanted.map(({ id, path: p }) => {
    const current = p ? byPath.get(comparablePath(p)) : undefined;
    if (!current) missing.push(`${id}（${p ?? "无路径"}）`);
    return current ?? "";
  });
  if (missing.length) throw new DevError(422, "host", `库里找不到旧基线的这些场景：${missing.join("，")}`, { missing });
  return ids;
}

export async function hashBaseline(
  s: DevSession,
  params: HashBaselineParams,
  ctx: { signal: AbortSignal; progress: (value: HashProgress) => void },
): Promise<HashBaselineResult> {
  const levels = params.levels ?? DEFAULT_LEVELS;
  const time = params.time ?? DEFAULT_TIME;
  if (params.ids !== undefined && params.from !== undefined) throw badRequest("ids 和 from 只能给一个");
  if (params.ids !== undefined && (!Array.isArray(params.ids) || params.ids.some((id) => !/^\d+$/.test(String(id))))) {
    throw badRequest("ids 要是图片 id 数组");
  }
  if (!params.ids && !params.from) throw badRequest("要给 ids（图片 id）或 from（旧基线文件）");
  const ids = params.ids ? params.ids.map(String) : await idsFromBaseline(s, params.from!);

  const own = !params.host;
  const opened = own ? await openHost(s, { hidden: true }) : null;
  const handle = params.host ?? opened!.handle;
  const host = s.host(handle);
  const out: HashBaseline = {
    recordedAt: new Date().toISOString(),
    time,
    levels,
    hostBuild: host.build,
    scenes: {},
    closed: null,
  };
  const total = ids.length * levels.length;
  let done = 0;
  let unstable: HashBaselineResult["unstable"] = null;
  let closed: HostCloseResult | null = null;
  ctx.progress({ done, total, current: null });
  try {
    outer: for (const id of ids) {
      const target = await sceneTarget(s, id);
      const { metadataId, userProperties } = await currentUserProperties(s, id);
      const scene = (out.scenes[id] = {
        input: {
          path: target.path,
          sceneAssets: target.sceneAssets,
          metadataId,
          userProperties,
          projectFiles: projectFiles(target.path),
        },
        levels: {} as Record<string, HashLevelRecord>,
      });
      for (const postprocess of levels) {
        if (ctx.signal.aborted) throw new DevError(499, "rest", "已取消");
        ctx.progress({ done, total, current: `${id} ${postprocess}` });
        const args = JSON.stringify({
          projectDir: target.path,
          sceneAssets: target.sceneAssets,
          postprocess,
          userProperties,
          time,
          key: "kbdev-hash-baseline",
        });
        const render = async (): Promise<RenderMeta> => {
          const result = await hostTask(s, handle, `__kabegameSceneProbe.renderFrame(${args})`, { signal: ctx.signal });
          if (result.status !== "done") throw new DevError(422, "host", `${id} ${postprocess}: ${result.error}`);
          return result.result as RenderMeta;
        };
        const a = await render();
        await sleep(500);
        const b = await render();
        const stable = a.sha256 === b.sha256;
        scene.levels[postprocess] = {
          stable,
          sha256: a.sha256,
          ...(stable ? {} : { sha256b: b.sha256 }),
          postprocess: a.postprocess,
          bloomLevels: a.bloomLevels,
          targetBytes: a.targetBytes,
          unsupported: a.unsupported,
          width: a.width,
          height: a.height,
          format: a.format,
          mean: a.mean,
        };
        done++;
        ctx.progress({ done, total, current: `${id} ${postprocess}` });
        if (!stable) {
          unstable = { id, postprocess };
          break outer;
        }
      }
    }
  } finally {
    if (own && s.hosts.has(handle)) closed = await closeHost(s, handle).catch(() => null);
  }
  // 不带句柄：格式同旧 hash-*.json 的 closed
  out.closed = closed
    ? { before: closed.before, after: closed.after, previewHostsLeft: closed.previewHostsLeft }
    : null;
  return { ok: unstable === null, unstable, baseline: out };
}
