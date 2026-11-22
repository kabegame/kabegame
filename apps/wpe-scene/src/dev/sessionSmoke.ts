import { invoke } from "@tauri-apps/api/core";
import { compileSceneInWorker, openSceneSession, SessionBrokenError } from "../compile/client";
import type { SceneBundle } from "../compile/bundle";
import { fragmentBlocker, fragmentOf, rekeyFragment, type ObjectFragment } from "../compile/fragment";
import { FetchSceneReader, SceneFs } from "../compile/fs";
import { parseProject, parseScene } from "../compile/model";
import type { ScenePostprocessSetting } from "../compile/postprocess";
import type { SessionStats } from "../compile/protocol";

/**
 * 编译会话的真机冒烟（活的场景图 L2，`.claude/plans/wpe-import/3-scene/live/phase-l2-worker.md` 点 5）。
 *
 * 每张场景：用真 Worker 开会话编整场，再对每个可取片段的对象（`fragmentBlocker` 为 null、配置不是数组）在新下标上请求片段，
 * 和主线程 `rekeyFragment(fragmentOf(bundle, i))` 逐字段比（同 L1 的 `ignore/live/l1/fragments.test.ts`：`unsupported`、`sceneFlips` 不比；
 * 配置取会话打开前读的 scene.json 原文加新 id）。另报：增量是否为空、已分离缓冲次数（必须 0）、每个片段的耗时、
 * opened / 最后一次的 stats、整场 bundle 的摘要（sha256）与同一场景 `compileSceneInWorker` 的摘要是否相同。
 */

export interface SessionSmokeOptions {
  /** 每张场景最多比较的对象数（缺省全部） */
  maxObjects?: number;
  postprocess?: ScenePostprocessSetting;
}

interface Target {
  path: string;
  sceneAssets: string[];
}

interface DiffPath {
  path: string;
  a: string;
  b: string;
}

interface SceneRow {
  imageId: string;
  objects: number;
  compared: number;
  skipped: Record<string, number>;
  different: number;
  diffs: { object: number; paths: DiffPath[] }[];
  /** 增量非空的对象（程序 / 纹理 / 用户纹理 / 绑定 / 资源路径任一有新增） */
  deltaNonEmpty: { object: number; programs: number; textures: number; userTextures: number; bindings: number }[];
  /** 已分离缓冲（`fragment-error` 的 `detached`）次数，必须 0 */
  detached: number;
  /** 其它失败（编译抛错、会话坏了）：`object` 是模板对象下标 */
  errors: { object: number; message: string }[];
  flips: { object: number; flips: string[] }[];
  fragmentMs: { count: number; avg: number; max: number };
  openedStats: SessionStats | null;
  lastStats: SessionStats | null;
  digestSession?: string;
  digestWhole?: string;
  digestMatches?: boolean;
  openMs?: number;
  error?: string;
}

/** 同步的 32 位 FNV-1a：类型化数组在摘要与差异比较里按它缩成一个数，不在乎抗碰撞。 */
function fnv(view: ArrayBufferView): number {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** 规范化：键排序、Map / Set / 类型化数组展开（数组按长度 + FNV 缩成摘要），函数与 undefined 丢弃。 */
function normalize(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "function") return undefined;
  if (value instanceof ArrayBuffer) return { $bytes: value.byteLength, $hash: fnv(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) return { $view: value.constructor.name, $bytes: value.byteLength, $hash: fnv(value) };
  if (typeof ImageBitmap !== "undefined" && value instanceof ImageBitmap)
    return { $bitmap: [value.width, value.height] };
  if (value instanceof Map)
    return { $map: [...value.entries()].map(([k, v]) => [normalize(k, seen), normalize(v, seen)]) };
  if (value instanceof Set) return { $set: [...value].map((v) => normalize(v, seen)) };
  if (Array.isArray(value)) return value.map((v) => normalize(v, seen));
  if (value && typeof value === "object") {
    if (seen.has(value)) return { $cycle: true };
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = normalize((value as Record<string, unknown>)[key], seen);
      if (item !== undefined) out[key] = item;
    }
    seen.delete(value);
    return out;
  }
  return value;
}

const brief = (value: unknown): string => {
  const text = JSON.stringify(value) ?? "undefined";
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
};

/** 两个规范化值的差异路径（最多 `limit` 条）。 */
function diffPaths(a: unknown, b: unknown, at: string, out: DiffPath[], limit: number): void {
  if (out.length >= limit) return;
  if (a === b || (a !== a && b !== b)) return;
  const objectA = a && typeof a === "object";
  const objectB = b && typeof b === "object";
  if (!objectA || !objectB || Array.isArray(a) !== Array.isArray(b)) {
    out.push({ path: at, a: brief(a), b: brief(b) });
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.push({ path: `${at}.length`, a: String(a.length), b: String(b.length) });
      return;
    }
    for (let i = 0; i < a.length; i++) diffPaths(a[i], b[i], `${at}[${i}]`, out, limit);
    return;
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const key of new Set([...Object.keys(ra), ...Object.keys(rb)]))
    diffPaths(ra[key], rb[key], `${at}.${key}`, out, limit);
}

/** 片段里参与比较的字段（`unsupported`、`sceneFlips` 不比）。 */
const comparable = (fragment: ObjectFragment) => {
  const { unsupported: _u, sceneFlips: _s, ...rest } = fragment;
  return normalize(rest, new WeakSet());
};

async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const digestOf = (bundle: SceneBundle) => sha256Hex(JSON.stringify(normalize(bundle, new WeakSet())));

async function smokeOne(imageId: string, options: SessionSmokeOptions): Promise<SceneRow> {
  const row: SceneRow = {
    imageId,
    objects: 0,
    compared: 0,
    skipped: {},
    different: 0,
    diffs: [],
    deltaNonEmpty: [],
    detached: 0,
    errors: [],
    flips: [],
    fragmentMs: { count: 0, avg: 0, max: 0 },
    openedStats: null,
    lastStats: null,
  };
  const target = await invoke<Target>("wpe_scene_target", { imageId });
  const reader = new FetchSceneReader();
  // 配置取会话打开前读的 scene.json 原文
  const fs = new SceneFs(target.path, target.sceneAssets, reader);
  const project = parseProject((await fs.text("project.json"))!);
  const rawObjects = parseScene((await fs.text(project.file))!).objects as unknown[];
  const input = {
    projectDir: target.path,
    sceneAssets: target.sceneAssets,
    postprocess: options.postprocess ?? ("ultra" as ScenePostprocessSetting),
    exhaustive: true,
    reader,
  };
  const whole = await compileSceneInWorker(input);
  row.digestWhole = await digestOf(whole);
  const started = performance.now();
  const { bundle, session } = await openSceneSession(input);
  row.openMs = Math.round(performance.now() - started);
  try {
    row.digestSession = await digestOf(bundle);
    row.digestMatches = row.digestSession === row.digestWhole;
    row.openedStats = session.stats;
    const configs = bundle.configs ?? [];
    row.objects = bundle.layers.length;
    let next = configs.length;
    let id = 900000;
    let total = 0;
    for (const layer of [...bundle.layers]) {
      if (options.maxObjects !== undefined && row.compared >= options.maxObjects) break;
      const i = layer.object;
      const configText = configs[i];
      if (typeof configText !== "string" || configText.startsWith("[")) {
        row.skipped["no-config"] = (row.skipped["no-config"] ?? 0) + 1;
        continue;
      }
      const blocker = fragmentBlocker(bundle, i);
      if (blocker !== null) {
        row.skipped[blocker] = (row.skipped[blocker] ?? 0) + 1;
        continue;
      }
      const object = next++;
      const newId = id++;
      const parent = layer.parent;
      const fragmentB = rekeyFragment(fragmentOf(bundle, i)!, { object, id: newId, parent });
      const config = JSON.stringify({ ...(rawObjects[i] as Record<string, unknown>), id: newId });
      const at = performance.now();
      let delta;
      try {
        delta = await session.compileFragment({ object, config, parent, bone: null, properties: {} });
      } catch (error) {
        const message = String(error);
        if (message.includes("detached")) row.detached++;
        else row.errors.push({ object: i, message: message.slice(0, 300) });
        // 会话坏了：后面的请求都会失败，不再继续
        if (error instanceof SessionBrokenError) break;
        continue;
      }
      const ms = performance.now() - at;
      total += ms;
      row.fragmentMs.max = Math.max(row.fragmentMs.max, ms);
      row.compared++;
      row.lastStats = session.stats;
      const paths: DiffPath[] = [];
      diffPaths(comparable(delta.fragment), comparable(fragmentB), "", paths, 8);
      if (paths.length) {
        row.different++;
        row.diffs.push({ object: i, paths });
      }
      if (delta.fragment.sceneFlips.length) row.flips.push({ object: i, flips: delta.fragment.sceneFlips });
      const counts = {
        programs: delta.programs.list.length,
        textures: delta.textures.list.length,
        userTextures: delta.userTextures.list.length,
        bindings: delta.bindings.length,
      };
      if (Object.values(counts).some((count) => count > 0)) row.deltaNonEmpty.push({ object: i, ...counts });
    }
    row.fragmentMs.count = row.compared;
    row.fragmentMs.avg = row.compared ? Math.round((total / row.compared) * 10) / 10 : 0;
    row.fragmentMs.max = Math.round(row.fragmentMs.max * 10) / 10;
  } finally {
    session.close();
  }
  return row;
}

/** 逐张场景跑会话冒烟（用法见文件头注释）；返回逐张结果与汇总。 */
export async function sessionSmoke(imageIds: string[], options: SessionSmokeOptions = {}): Promise<unknown> {
  const rows: SceneRow[] = [];
  for (const imageId of imageIds) {
    try {
      rows.push(await smokeOne(imageId, options));
    } catch (error) {
      rows.push({
        imageId,
        objects: 0,
        compared: 0,
        skipped: {},
        different: 0,
        diffs: [],
        deltaNonEmpty: [],
        detached: 0,
        errors: [],
        flips: [],
        fragmentMs: { count: 0, avg: 0, max: 0 },
        openedStats: null,
        lastStats: null,
        error: String(error).slice(0, 300),
      });
    }
  }
  const sum = (pick: (row: SceneRow) => number) => rows.reduce((total, row) => total + pick(row), 0);
  return {
    summary: {
      scenes: rows.length,
      errors: rows.filter((row) => row.error).length,
      compared: sum((row) => row.compared),
      different: sum((row) => row.different),
      detached: sum((row) => row.detached),
      fragmentErrors: sum((row) => row.errors.length),
      deltaNonEmpty: sum((row) => row.deltaNonEmpty.length),
      digestMismatch: rows.filter((row) => row.digestMatches === false).length,
    },
    rows,
  };
}
