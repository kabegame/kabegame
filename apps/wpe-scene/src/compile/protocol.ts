import type { SceneBundle, SessionCacheStats } from "./bundle";
import type { FragmentDelta, FragmentRequest } from "./fragment";
import type {
  SceneReflectionSetting,
  ScenePostprocessSetting,
  SceneShadowSetting,
  SceneVolumetricsSetting,
} from "./postprocess";

/** 主线程读文件失败时回传给 Worker 的错误。保留类型名：SceneFs 靠 `TypeError("Failed to fetch")` 判断文件不存在。 */
export interface FileError {
  name: string;
  message: string;
}

/**
 * 运行中改过的场景结构（P6d3）：每次编译都带全量，重编译后结构不丢。
 * - `destroyed`：删掉的对象（`objects` 下标）。编译时这一项当作不存在（置 null），不进 `bundle.layers`，也不参与父链、依赖、灯等整场并集。
 * - `parents`：运行中的换父，按发生的先后：`[对象, 新父的 objects 下标（null 是根）, 挂点（骨骼名，没有是 null）]`。在 `resolveParents` 之后
 *   依次套用；子表 = 加载时按 `objects` 顺序、之后按这里的先后追加（组内绘制顺序跟子表走）。同一个对象多次换父只留最后一次。
 */
export interface SceneStructure {
  destroyed: number[];
  parents: [number, number | null, string | null][];
  /**
   * 运行中 `createLayer` 建出的对象（P6d3b）：`object` 是宿主分配的 `objects` 下标（接在加载时的对象之后、只增不复用），`config` 是
   * `createLayerConfig` 整理后的配置 JSON 文本（对象，或数组 = 空名分组节点）。编译时先把它放到 `scene.objects[object]`（中间空位补 null），
   * 之后和 `scene.json` 里的对象走同一条路径；`destroyed` 在其后套用，所以建了又删的不编。
   */
  created: { object: number; config: string }[];
}

/** `open` 请求的载荷（L2：原 `start`，字段不变） */
export interface OpenRequest {
  projectDir: string;
  sceneAssets: string[];
  userProperties: Record<string, unknown>;
  scriptOverrides: Record<string, number[] | boolean | string>;
  structure: SceneStructure;
  postprocess: ScenePostprocessSetting;
  reflection: SceneReflectionSetting;
  shadows: SceneShadowSetting;
  volumetrics: SceneVolumetricsSetting;
  force: boolean;
  exhaustive: boolean;
  module: WebAssembly.Module | null;
}

/** 会话统计（L2）：缓存规模加翻译器 wasm 的线性内存字节数 */
export interface SessionStats extends SessionCacheStats {
  wasmBytes: number;
}

/**
 * 主线程 → Worker。一个 Worker 一个会话：`open` 只收一次；`fragment` 按请求 id 配对、Worker 里串行处理；`close` 之后一律回错误。
 */
export type WorkerRequest =
  | ({ type: "open" } & OpenRequest)
  | { type: "fragment"; id: number; request: FragmentRequest }
  | { type: "close" }
  | { type: "file-result"; id: number; bytes?: Uint8Array; error?: FileError };
export type WorkerResponse =
  | { type: "file"; id: number; operation: "range" | "whole"; path: string; start?: number; end?: number }
  /** 编译进度（`progress.ts` 的 `compile` 阶段）：已处理对象的权重 / 总权重 */
  | { type: "progress"; done: number; total: number }
  /**
   * 整场编完（原 `done`），会话在 Worker 里保留。`exactConfigs`（L5）：能拿整场 bundle 的片段预置缓存的对象下标
   * （`SceneCompileSession.exactConfigs`），不进 bundle
   */
  | { type: "opened"; bundle: SceneBundle; stats: SessionStats; exactConfigs: number[] }
  /** 只用于 `open` 失败（含重复 `open`） */
  | { type: "error"; message: string }
  | { type: "fragment-done"; id: number; delta: FragmentDelta; stats: SessionStats }
  /** `broken` 为真：会话已不可用，宿主要整场重载、换新会话 */
  | { type: "fragment-error"; id: number; message: string; broken: boolean };

export function encodeFileError(error: unknown): FileError {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}

/** 按类型名还原；只还原 TypeError / RangeError，其余一律是 Error。 */
export function decodeFileError(error: FileError): Error {
  if (error.name === "TypeError") return new TypeError(error.message);
  if (error.name === "RangeError") return new RangeError(error.message);
  return new Error(error.message);
}
