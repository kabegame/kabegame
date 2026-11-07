/**
 * `#require LightingV1` 需要的引擎数据（lighting-REPORT）：灯数宏与灯光 uniform。
 *
 * - **灯数不看灯对象**：`LIGHTS_*` 直接取 `general.lightconfig`（`FUN_140186c90`），每种灯 4 位，缺这个键时全 0。灯对象只负责
 *   填数组（`FUN_140190c80`）：多出来的灯丢掉，少了的槽位保持全 0（半径 0，不发光）。所以没有 `lightconfig` 的场景里，
 *   `lpoint` 这类灯对象对画面没有影响，开了 `LIGHTING` 的材质只剩环境光。
 * - **`"light": "point"` 是遗留灯**，不进这里的数组：它写 `g_LightsPosition` 等，只有 `generic` / `generic2` 读。
 * - 这些值是编译期算好的常量：绑了 `{user}` 的字段登记重编译，脚本改灯还不支持（宿主没有灯对象）。
 */
import type { BindingCollector, BindingTarget } from "./bindings";
import { numbers, type SceneObject, type SceneScalar, type SceneValue } from "./model";

export interface LightCounts {
  point: number;
  spot: number;
  tube: number;
  directional: number;
}

/** 阴影与 cookie 的灯数键：要 `_rt_shadowAtlas` / `_alias_lightCookie`，渲染器没有。 */
const SHADOW_KEYS = ["spotshadowcookie", "spotshadow", "spotcookie", "directionalshadow", "pointshadow"];

function count(value: unknown): number {
  // WPE 只取低 4 位（FUN_140186c90）
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) & 0xf : 0;
}

/** `general.lightconfig` 的灯数；不认识的形状按没写。 */
export function lightCounts(general: Record<string, unknown>): LightCounts {
  const config = general.lightconfig;
  const source = config && typeof config === "object" ? (config as Record<string, unknown>) : {};
  return {
    point: count(source.point),
    spot: count(source.spot),
    tube: count(source.tube),
    directional: count(source.directional),
  };
}

/** `lightconfig` 里要阴影或 cookie 的项：照报，不生成缺阴影的画面。 */
export function lightConfigIssues(general: Record<string, unknown>): string[] {
  const config = general.lightconfig;
  if (!config || typeof config !== "object") return [];
  const source = config as Record<string, unknown>;
  return SHADOW_KEYS.filter((key) => count(source[key]) > 0).map((key) => `lightconfig:${key}`);
}

/**
 * 整场全局的引擎宏（hdr-macro-REPORT）：基础材质、effect、passthrough 都定义，运行中改属性不变。
 * 关闭时不写键：`common_blending.h` 用 `#ifdef HDR`，传 0 会让 LDR 场景也走 HDR 分支。
 */
export function engineDefines(hdr: boolean, ortho: boolean): Record<string, string> {
  const defines: Record<string, string> = {};
  if (hdr) defines.HDR = "1";
  if (ortho) defines.SCENE_ORTHO = "1";
  return defines;
}

/** 只在最终 `LIGHTING` 非 0 时生效的宏（翻译器的 `litDefines`）。 */
export function litDefines(counts: LightCounts): Record<string, string> {
  return {
    LIGHTS_POINT: String(counts.point),
    LIGHTS_SPOT: String(counts.spot),
    LIGHTS_TUBE: String(counts.tube),
    LIGHTS_DIRECTIONAL: String(counts.directional),
  };
}

/** 灯对象缺键时的值（`FUN_14018ff60` 的构造函数）。 */
const DEFAULTS = {
  color: [0, 0, 0],
  intensity: 0,
  radius: 1,
  exponent: 2,
  innercone: 20,
  outercone: 30,
  controlpoint: [2, 0, 0],
};

/** 对象世界矩阵的旋转缩放部分（三列）：`Rz · Ry · Rx · S`，角度是弧度（`FUN_1401dd630`、`FUN_1401850a0`）。 */
export function lightAxes(angles: readonly number[], scale: readonly number[]): number[][] {
  const [x = 0, y = 0, z = 0] = angles;
  const [sx = 1, sy = 1, sz = 1] = scale;
  const cx = Math.cos(x),
    nx = Math.sin(x),
    cy = Math.cos(y),
    ny = Math.sin(y),
    cz = Math.cos(z),
    nz = Math.sin(z);
  return [
    [cy * cz * sx, cy * nz * sx, -ny * sx],
    [(ny * cz * nx - cx * nz) * sy, (ny * nz * nx + cx * cz) * sy, nx * cy * sy],
    [(cx * cz * ny + nx * nz) * sz, (cx * nz * ny - nx * cz) * sz, cx * cy * sz],
  ];
}

const DEGREES = Math.PI / 180;

/** 每种灯的各个 uniform，按槽位追加的一维数组。 */
function emptyUniforms(counts: LightCounts): Record<string, number[]> {
  const size: [string, number][] = [
    ["g_LPoint_Color", counts.point],
    ["g_LPoint_Origin", counts.point],
    ["g_LSpot_Color", counts.spot],
    ["g_LSpot_Origin", counts.spot],
    ["g_LSpot_Direction", counts.spot],
    ["g_LSpot_Exponent", counts.spot],
    ["g_LTube_Color", counts.tube],
    ["g_LTube_OriginA", counts.tube],
    ["g_LTube_OriginB", counts.tube],
    ["g_LDirectional_Color", counts.directional],
    ["g_LDirectional_Direction", counts.directional],
  ];
  return Object.fromEntries(size.filter(([, n]) => n > 0).map(([name, n]) => [name, new Array<number>(n * 4).fill(0)]));
}

/**
 * 灯对象 → 灯光 uniform（`FUN_140190c80`）。`read` 解析 JSON 字段并登记绑定（`path` 是 scene.json 坐标）。
 *
 * 灯数超过 `lightconfig` 时 WPE 先按类型与到某点的投影排序再截断（`FUN_140186990`），排序键没有逆向完，这里按文件顺序截断。
 */
export function lightUniforms(
  objects: readonly SceneObject[],
  counts: LightCounts,
  read: (value: SceneValue | undefined, path: string) => SceneScalar | undefined,
): Record<string, number[]> {
  const values = emptyUniforms(counts);
  const used = { point: 0, spot: 0, tube: 0, directional: 0 };
  const write = (name: string, slot: number, value: readonly number[]) => {
    values[name].splice(slot * 4, 4, ...[0, 1, 2, 3].map((k) => value[k] ?? 0));
  };
  objects.forEach((object, index) => {
    const type = object.light;
    const kind =
      type === "lpoint"
        ? "point"
        : type === "lspot"
          ? "spot"
          : type === "ltube"
            ? "tube"
            : type === "ldirectional"
              ? "directional"
              : null;
    if (!kind || used[kind] >= counts[kind]) return;
    const at = (field: string) => `objects/${index}/${field}`;
    if (read(object.visible, at("visible")) === false) return;
    const field = (key: string, fallback: number) =>
      numbers(read(object[key] as SceneValue | undefined, at(key)), [fallback])[0] ?? fallback;
    const vector = (key: string, fallback: readonly number[]) =>
      numbers(read(object[key] as SceneValue | undefined, at(key)), [...fallback]);
    const slot = used[kind]++;
    const origin = vector("origin", [0, 0, 0]);
    const axes = lightAxes(vector("angles", [0, 0, 0]), vector("scale", [1, 1, 1]));
    const intensity = field("intensity", DEFAULTS.intensity);
    const color = vector("color", DEFAULTS.color).slice(0, 3);
    const lit = [0, 1, 2].map((k) => (color[k] ?? 0) * intensity);
    const radius = field("radius", DEFAULTS.radius);
    const exponent = field("exponent", DEFAULTS.exponent);
    if (kind === "point") {
      write("g_LPoint_Color", slot, [...lit, radius]);
      write("g_LPoint_Origin", slot, [...origin.slice(0, 3), exponent]);
    } else if (kind === "spot") {
      const inner = Math.cos(field("innercone", DEFAULTS.innercone) * DEGREES);
      const outer = Math.cos(field("outercone", DEFAULTS.outercone) * DEGREES);
      write("g_LSpot_Color", slot, [...lit, radius]);
      write("g_LSpot_Origin", slot, [...origin.slice(0, 3), inner]);
      // 局部 +X 是照射方向
      write("g_LSpot_Direction", slot, [...axes[0], outer]);
      write("g_LSpot_Exponent", slot, [exponent]);
    } else if (kind === "tube") {
      const point = vector("controlpoint", DEFAULTS.controlpoint);
      const end = [0, 1, 2].map(
        (k) =>
          (point[0] ?? 0) * axes[0][k] + (point[1] ?? 0) * axes[1][k] + (point[2] ?? 0) * axes[2][k] + (origin[k] ?? 0),
      );
      write("g_LTube_Color", slot, [...lit, radius]);
      write("g_LTube_OriginA", slot, [...origin.slice(0, 3), exponent]);
      write("g_LTube_OriginB", slot, end);
    } else {
      // 平行光的 w 恒为 1；方向取反后是「着色点指向灯」
      write("g_LDirectional_Color", slot, [...lit, 1]);
      write("g_LDirectional_Direction", slot, [-axes[0][0], -axes[0][1], -axes[0][2], 0]);
    }
  });
  return values;
}

/** `lightUniforms` 里 `read` 的标准实现：解析 `{user}` 并登记成 `target`。 */
export function bindingReader(
  bindings: BindingCollector,
  properties: Record<string, SceneScalar>,
  target: (path: string) => BindingTarget,
): (value: SceneValue | undefined, path: string) => SceneScalar | undefined {
  return (value, path) => bindings.bind(value, properties, target(path));
}
