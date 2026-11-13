/**
 * 透视场景的相机（P5d 步骤 2，rea-p5-camera.md 第 3 节、p3-script-REPORT L2）：`scene.json` 顶层 `camera` 的基准 `eye` / `center` /
 * `up` 与 `paths` 指向的路径文件。每帧的求值与推进在 `render/camera.ts`。
 *
 * - 基准：字符串按空格 `atof` 三次、缺分量为 0；不是字符串时保留构造值 (2, 2, 2) / (0, 0, 0) / (0, 1, 0)（L2）。WPE 加载时硬读字符串，
 *   `camera` 不是描述符，绑不了属性、脚本也碰不到（`getCameraTransforms` / `setCameraTransforms` 仍在 `MISSING_SCRIPT_API`）。
 * - 路径文件：格式与容错照 rea-p5-camera 3.1（`parseCameraPaths`），按 `camera.paths` 的顺序、文件内的顺序追加；读不到或不是 JSON 报
 *   `camera:paths:unreadable`（没测，语料 0）。
 * - 正交场景不解析（视图恒为单位阵，L2）：带非空 `paths` 由能力表报 `camera:paths:orthographic`（读码说那时不重置相机、视图会平移，
 *   语料 0，没测）。
 * 数值都存 float32（WPE 关键帧是 11 个 float，基准同样是 float）。
 */
import type { SceneFs } from "./fs";
import { parseWpeJson, type SceneJson } from "./model";

export type Vec3 = [number, number, number];

/** 路径的一个关键帧（rea-p5-camera 3.1：t、eye、center、up、zoom，共 11 个 float）。 */
export interface CameraKey {
  t: number;
  eye: Vec3;
  center: Vec3;
  up: Vec3;
  zoom: number;
}
export interface CameraPath {
  duration: number;
  keys: CameraKey[];
}
/** 透视场景的基准相机与路径；正交场景没有（`SceneGeneral.camera` 为 null，视图恒为单位阵，L2）。 */
export interface SceneCameraJson {
  eye: Vec3;
  center: Vec3;
  up: Vec3;
  /** 路径表（已去掉没有关键帧的路径，见 `compileCamera`）；空表时用基准。 */
  paths: CameraPath[];
}

/** 基准相机的构造值（p3-script-REPORT L2）。 */
export const DEFAULT_CAMERA: Readonly<{ eye: Vec3; center: Vec3; up: Vec3 }> = {
  eye: [2, 2, 2],
  center: [0, 0, 0],
  up: [0, 1, 0],
};

/** C 的 `atof`：取开头能解析的部分，解析不出为 0。 */
function atof(token: string | undefined): number {
  const value = token === undefined ? Number.NaN : Number.parseFloat(token);
  return Number.isNaN(value) ? 0 : value;
}

/** `"x y z"` → `atof` 三次（空格分隔），缺分量 0；不是字符串返回 null（调用方保留缺省）。 */
export function cameraVector(value: unknown): Vec3 | null {
  if (typeof value !== "string") return null;
  const tokens = value.trim().split(/\s+/);
  return [Math.fround(atof(tokens[0])), Math.fround(atof(tokens[1])), Math.fround(atof(tokens[2]))];
}

/** jsoncpp 的 `asFloat`：数字原样、布尔 0 / 1、null 0；别的类型 WPE 会抛异常（语料 0），这里当 0。 */
function asFloat(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.fround(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  return 0;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * 解析一个路径文件（`FUN_140198e20`，rea-p5-camera 3.1【确】），追加到 `out`：
 * - 根对象要有 `paths` 数组，否则什么都不加；
 * - 每条路径：不是对象，或 `transforms` 不是非空数组 → `break`（同一文件后面的路径都不读）；`disabled: true` 跳过；`duration` 缺省 0；
 * - 每个关键帧：不是对象、`disabled: true` 跳过；`eye` / `center` / `up` 缺键（或不是字符串）时整个向量是 (0, 0, 0)（`up` 也是）；
 *   `zoom` 有键才读，否则 1；`timestamp` 是数字就用，否则第 i 项（按 `transforms` 里的下标）取 i/(n − 1)·duration，第 0 项是 0。
 */
export function parseCameraPaths(json: unknown, out: CameraPath[]): void {
  if (!isObject(json) || !Array.isArray(json.paths)) return;
  for (const raw of json.paths) {
    if (!isObject(raw) || !Array.isArray(raw.transforms) || raw.transforms.length === 0) break;
    if (raw.disabled === true) continue;
    const duration = asFloat(raw.duration);
    const transforms = raw.transforms as unknown[];
    const n = transforms.length;
    const keys: CameraKey[] = [];
    for (const [i, transform] of transforms.entries()) {
      if (!isObject(transform) || transform.disabled === true) continue;
      const vector = (key: string): Vec3 => cameraVector(transform[key]) ?? [0, 0, 0];
      const timestamp = transform.timestamp;
      keys.push({
        t:
          typeof timestamp === "number" && Number.isFinite(timestamp)
            ? Math.fround(timestamp)
            : i === 0
              ? 0
              : Math.fround((i / (n - 1)) * duration),
        eye: vector("eye"),
        center: vector("center"),
        up: vector("up"),
        zoom: "zoom" in transform ? asFloat(transform.zoom) : 1,
      });
    }
    out.push({ duration, keys });
  }
}

/** 编译期读文件要的那一点 `SceneFs`（项目散文件 → `scene.pkg` → assets，计进请求数）。 */
export type CameraFs = Pick<SceneFs, "text">;

/**
 * 相机对象的 `path`（P5d 步骤 3，rea-p5-camera 4.4）：WPE 读它指向的文件、按 `paths` 数组建条目（关键帧在相邻帧间线性插值，结果写回相机
 * 对象的 origin 与 angles）。条目动画没做：读出非空 `paths`、读不到、不是 JSON 或根不是对象时报 `camera:path`（语料 22 个都是
 * `{"paths": []}`）。缺键（undefined / null）不读；不是字符串（绑属性等，`path` 不是描述符，WPE 怎么处理没读，语料 0）同样报。
 * `paths` 不是数组时按空表（WPE 取不到数组就没有条目）。文件按项目散文件 → `scene.pkg` → assets 的现有查找读，计进请求数。
 */
export async function checkCameraObjectPath(path: unknown, fs: CameraFs, unsupported: Set<string>): Promise<void> {
  if (path === undefined || path === null) return;
  const text = typeof path === "string" && path ? await fs.text(path) : null;
  let json: unknown = null;
  try {
    json = text === null ? null : parseWpeJson(text);
  } catch {
    json = null;
  }
  if (!isObject(json) || (Array.isArray(json.paths) && json.paths.length > 0)) unsupported.add("camera:path");
}

/**
 * 读 `scene.camera`：基准缺省 (2, 2, 2) / (0, 0, 0) / (0, 1, 0)；`paths` 里每个字符串按顺序读一个路径文件（不是字符串的项跳过），
 * 读不到或不是 JSON 报 `camera:paths:unreadable`、这个文件不加路径。只在透视场景调。
 * 第 0 条路径没有关键帧时 WPE 不走路径（rea 3.2 的条件只看第 0 条），整张表清空；别的没有关键帧的路径 WPE 求值时越界读（语料 0），
 * 去掉。
 */
export async function compileCamera(
  scene: Pick<SceneJson, "camera">,
  fs: CameraFs,
  unsupported: Set<string>,
): Promise<SceneCameraJson> {
  const camera = isObject(scene.camera) ? scene.camera : {};
  const paths: CameraPath[] = [];
  for (const file of Array.isArray(camera.paths) ? camera.paths : []) {
    if (typeof file !== "string") continue;
    const text = file ? await fs.text(file) : null;
    if (text === null) {
      unsupported.add("camera:paths:unreadable");
      continue;
    }
    let json: unknown;
    try {
      json = parseWpeJson(text);
    } catch {
      unsupported.add("camera:paths:unreadable");
      continue;
    }
    parseCameraPaths(json, paths);
  }
  return {
    eye: cameraVector(camera.eye) ?? [...DEFAULT_CAMERA.eye],
    center: cameraVector(camera.center) ?? [...DEFAULT_CAMERA.center],
    up: cameraVector(camera.up) ?? [...DEFAULT_CAMERA.up],
    paths: paths[0]?.keys.length ? paths.filter((path) => path.keys.length > 0) : [],
  };
}
