/**
 * `#require LightingV1` 需要的引擎数据（lighting-REPORT）：灯数宏与灯光 uniform。
 *
 * - **灯数不看灯对象**：`LIGHTS_*` 直接取 `general.lightconfig`（`FUN_140186c90`），每种灯 4 位，缺这个键时全 0。灯对象只负责
 *   填数组（`FUN_140190c80`）：多出来的灯丢掉，少了的槽位保持全 0（半径 0，不发光）。所以没有 `lightconfig` 的场景里，
 *   `lpoint` 这类灯对象对画面没有影响，开了 `LIGHTING` 的材质只剩环境光。
 * - **`"light": "point"` 是遗留灯**，不进这里的数组：它写 `g_LightsPosition` 等，由 `legacyLightUniforms` 照 WPE 的槽位规则算。
 * - 这些值是编译期算好的常量：绑了 `{user}` 的字段登记重编译，脚本改灯还不支持（宿主没有灯对象）。
 */
import type { BindingCollector, BindingTarget } from "./bindings";
import type { TranslateResult } from "../wpesl2wgsl";
import { isSceneObject, numbers, type SceneObject, type SceneScalar, type SceneValue } from "./model";
import { layerLocalMatrix } from "../render/layout";

export interface LightCounts {
  /** 各类灯的总数（含带阴影的，`lightconfig` 的 `point` 等是总数，rea-p13-passes 2.8）。 */
  point: number;
  spot: number;
  tube: number;
  directional: number;
  /** 带阴影的点光 / 平行光数（`pointshadow` / `directionalshadow`，P13d）；阴影档位为 0 时解析期就丢掉（rea-p13-passes 2.10）。 */
  pointShadow: number;
  directionalShadow: number;
  /** 聚光的阴影 / cookie 数：不支持（照报 `lightconfig:spot*`），只为照报与宏。档位 0 时 `spotshadowcookie` 并进 `spotcookie`。 */
  spotShadow: number;
  spotCookie: number;
  spotShadowCookie: number;
}

/** 聚光的阴影与 cookie 键：要 `_alias_lightCookie` 与聚光投影（语料 0 张），照报。 */
const SPOT_SHADOW_KEYS = ["spotshadowcookie", "spotshadow", "spotcookie"] as const;

function count(value: unknown): number {
  // WPE 只取低 4 位（FUN_140186c90）
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) & 0xf : 0;
}

/** 阴影类计数各 2 位（`0x140187b52`–`0x140187d00`，最多 3）。 */
function count2(value: unknown): number {
  return count(value) & 3;
}

function lightConfigOf(general: Record<string, unknown>): Record<string, unknown> {
  const config = general.lightconfig;
  return config && typeof config === "object" ? (config as Record<string, unknown>) : {};
}

/**
 * `general.lightconfig` 的灯数；不认识的形状按没写。`quality` 是阴影档位（0 disabled … 4 ultra，`compile/postprocess.ts` 的
 * `resolveShadows`）：为 0 时 WPE 解析期只读 `spotshadowcookie`、按位或进 `spotcookie`，其余阴影计数不读（`0x140187c39`）。
 */
export function lightCounts(general: Record<string, unknown>, quality = 0): LightCounts {
  const source = lightConfigOf(general);
  const shadows = quality !== 0;
  return {
    point: count(source.point),
    spot: count(source.spot),
    tube: count(source.tube),
    directional: count(source.directional),
    pointShadow: shadows ? count2(source.pointshadow) : 0,
    directionalShadow: shadows ? count2(source.directionalshadow) : 0,
    spotShadow: shadows ? count2(source.spotshadow) : 0,
    spotCookie: shadows ? count2(source.spotcookie) : count2(source.spotcookie) | count2(source.spotshadowcookie),
    spotShadowCookie: shadows ? count2(source.spotshadowcookie) : 0,
  };
}

/** `lightconfig` 里聚光的阴影 / cookie（按档位解析之后）：照报，不生成缺阴影的画面。点光、平行光的阴影 P13d 起支持。 */
export function lightConfigIssues(general: Record<string, unknown>, quality = 0): string[] {
  const counts = lightCounts(general, quality);
  const values: Record<(typeof SPOT_SHADOW_KEYS)[number], number> = {
    spotshadowcookie: counts.spotShadowCookie,
    spotshadow: counts.spotShadow,
    spotcookie: counts.spotCookie,
  };
  return SPOT_SHADOW_KEYS.filter((key) => values[key] > 0).map((key) => `lightconfig:${key}`);
}

/**
 * 整场全局的引擎宏（hdr-macro-REPORT）：基础材质、effect、passthrough 都定义，运行中改属性不变。
 * 关闭时不写键：`common_blending.h` 用 `#ifdef HDR`，传 0 会让 LDR 场景也走 HDR 分支。
 * `REVERSEDEPTH` 恒为 1（P13c）：WPE 用反向深度（清 0、GREATER，P5d 实测），引擎恒定义它；WPE 自带着色器里用到它的是 `occlusiontest.vert`
 * （sprite 的遮挡方块把 z 写成 1e−7，p13-REPORT 第 18 行抓帧 z 近 0）、`volumetricsfront`、`common_pbr_2.h` 的级联阴影。
 */
export function engineDefines(hdr: boolean, ortho: boolean): Record<string, string> {
  const defines: Record<string, string> = { REVERSEDEPTH: "1" };
  if (hdr) defines.HDR = "1";
  if (ortho) defines.SCENE_ORTHO = "1";
  return defines;
}

/**
 * 只在最终 `LIGHTING` 非 0 时生效的宏（翻译器的 `litDefines`，`FUN_1401a5c40`，rea-p13-passes 2.8）：四类灯数与五个阴影计数；
 * 阴影计数之和非 0 时另写 `LIGHTS_SHADOW_MAPPING = 1` 与 `LIGHTS_SHADOW_MAPPING_QUALITY = 档位`，`spotcookie + spotshadowcookie`
 * 非 0 时写 `LIGHTS_COOKIE = 1`。
 */
export function litDefines(counts: LightCounts, quality = 0): Record<string, string> {
  const defines: Record<string, string> = {
    LIGHTS_POINT: String(counts.point),
    LIGHTS_SPOT: String(counts.spot),
    LIGHTS_TUBE: String(counts.tube),
    LIGHTS_DIRECTIONAL: String(counts.directional),
    LIGHTS_SPOT_SHADOW: String(counts.spotShadow),
    LIGHTS_SPOT_COOKIE: String(counts.spotCookie),
    LIGHTS_SPOT_SHADOW_COOKIE: String(counts.spotShadowCookie),
    LIGHTS_DIRECTIONAL_SHADOW: String(counts.directionalShadow),
    LIGHTS_POINT_SHADOW: String(counts.pointShadow),
  };
  if (counts.spotShadow + counts.spotShadowCookie + counts.directionalShadow + counts.pointShadow > 0) {
    defines.LIGHTS_SHADOW_MAPPING = "1";
    defines.LIGHTS_SHADOW_MAPPING_QUALITY = String(quality);
  }
  if (counts.spotCookie + counts.spotShadowCookie > 0) defines.LIGHTS_COOKIE = "1";
  return defines;
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

/** 一类灯（`light+0x2c0`：0 点、1 聚、2 管、3 平行）。 */
export type LightKind = "point" | "spot" | "tube" | "directional";

const KIND_ORDER: Record<LightKind, number> = { point: 0, spot: 1, tube: 2, directional: 3 };

/**
 * 一盏灯的编译期字段（P13d：灯光 uniform 改成每帧由 {@link lightFrame} 排序、写整块缓冲；字段仍是编译期常量，P13f 再换成运行时状态）。
 * 绑 `{user}` 的字段登记重编译（同以前），`visible` 为假的灯照样进表（WPE 遍历时跳过，`FUN_140185010`）。
 */
export interface SceneLight {
  /** `objects` 下标 */
  object: number;
  kind: LightKind;
  /** `light+0x2c4 & 3`：bit0 `castshadow`、bit1 `usecookie`（排序键之一，R2.3） */
  flags: number;
  visible: boolean;
  /** 本地 origin（排序键 `dot(origin, g_ViewForward)`，R2.3；挂父对象的灯照报 `object:parent`，所以也是世界位置） */
  origin: [number, number, number];
  /** 本地矩阵 `T·Rz·Ry·Rx·S`（`layerLocalMatrix`，列主序 f32）：平行光的方向与级联（rea-p13-shadows R3）读它的三列 */
  matrix: Float32Array;
  /** `color · intensity` */
  color: [number, number, number];
  radius: number;
  exponent: number;
  /** 聚光内外锥角的余弦 */
  inner: number;
  outer: number;
  /** 管光另一端（`controlpoint` 经本地矩阵） */
  tubeEnd: [number, number, number];
  /** `lightsourcesize`：透视场景点光阴影的近平面（rea-p13-passes 2.3） */
  lightSourceSize: number;
  /** `cascadedistance0..2`（缺省 3、10、100，2.4） */
  cascades: [number, number, number];
}

/** 灯对象 → {@link SceneLight}，`objects` 顺序（只收四类 V1 灯；遗留灯 `point` 走 `legacyLightUniforms`）。 */
export function collectSceneLights(
  objects: readonly SceneObject[],
  read: (value: SceneValue | undefined, path: string) => SceneScalar | undefined,
): SceneLight[] {
  const out: SceneLight[] = [];
  objects.forEach((object, index) => {
    if (!isSceneObject(object)) return;
    const type = object.light;
    const kind: LightKind | null =
      type === "lpoint"
        ? "point"
        : type === "lspot"
          ? "spot"
          : type === "ltube"
            ? "tube"
            : type === "ldirectional"
              ? "directional"
              : null;
    if (!kind) return;
    const at = (field: string) => `objects/${index}/${field}`;
    const field = (key: string, fallback: number) =>
      numbers(read(object[key] as SceneValue | undefined, at(key)), [fallback])[0] ?? fallback;
    const vector = (key: string, fallback: readonly number[]) =>
      numbers(read(object[key] as SceneValue | undefined, at(key)), [...fallback]);
    const flag = (key: string) => read(object[key] as SceneValue | undefined, at(key)) === true;
    const origin = vector("origin", [0, 0, 0]);
    const angles = vector("angles", [0, 0, 0]);
    const scale = vector("scale", [1, 1, 1]);
    const axes = lightAxes(angles, scale);
    const intensity = field("intensity", DEFAULTS.intensity);
    const color = vector("color", DEFAULTS.color);
    const point = vector("controlpoint", DEFAULTS.controlpoint);
    out.push({
      object: index,
      kind,
      flags: (flag("castshadow") ? 1 : 0) | (flag("usecookie") ? 2 : 0),
      visible: read(object.visible, at("visible")) !== false,
      origin: [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0],
      matrix: layerLocalMatrix({ origin, angles, scale }),
      color: [0, 1, 2].map((k) => (color[k] ?? 0) * intensity) as [number, number, number],
      radius: field("radius", DEFAULTS.radius),
      exponent: field("exponent", DEFAULTS.exponent),
      inner: Math.cos(field("innercone", DEFAULTS.innercone) * DEGREES),
      outer: Math.cos(field("outercone", DEFAULTS.outercone) * DEGREES),
      tubeEnd: [0, 1, 2].map(
        (k) =>
          (point[0] ?? 0) * axes[0][k] + (point[1] ?? 0) * axes[1][k] + (point[2] ?? 0) * axes[2][k] + (origin[k] ?? 0),
      ) as [number, number, number],
      lightSourceSize: field("lightsourcesize", 0),
      cascades: [field("cascadedistance0", 3), field("cascadedistance1", 10), field("cascadedistance2", 100)],
    });
  });
  return out;
}

/**
 * 灯光 uniform 缓冲的布局（rea-p13-shadows R2.1，单位 float）：WPE 是一整块，各 uniform 是它的切片，按生成器的声明顺序排。
 * 越界写（配置与灯对象不一致时，R2.4）落进下一段，照抄要按整块写（P13d 待定 4）。
 */
export interface LightBufferLayout {
  size: number;
  /** 名字 → [起点, 长度]（float）；数量为 0 的不列 */
  slices: Record<string, [number, number]>;
  /** 段起点 */
  point: number;
  spot: number;
  tube: number;
  directional: number;
  projection: number;
  projectionTransform: number;
  pointProjection: number;
  pointProjectionTransform: number;
  /** `N = SC + 3·DS + SS + SSC` */
  projections: number;
}

export function lightBufferLayout(counts: LightCounts): LightBufferLayout {
  const { point: P, spot: S, tube: T, directional: D, pointShadow: PS } = counts;
  const N = counts.spotCookie + 3 * counts.directionalShadow + counts.spotShadow + counts.spotShadowCookie;
  const slices: Record<string, [number, number]> = {};
  let at = 0;
  const add = (name: string, count: number, width = 4) => {
    if (count > 0) slices[name] = [at, count * width];
    at += count * width;
  };
  const point = at;
  add("g_LPoint_Color", P);
  add("g_LPoint_Origin", P);
  const spot = at;
  add("g_LSpot_Color", S);
  add("g_LSpot_Origin", S);
  add("g_LSpot_Direction", S);
  add("g_LSpot_Exponent", S);
  const tube = at;
  add("g_LTube_Color", T);
  add("g_LTube_OriginA", T);
  add("g_LTube_OriginB", T);
  const directional = at;
  add("g_LDirectional_Color", D);
  add("g_LDirectional_Direction", D);
  const projection = at;
  add("g_LFeature_ShadowProjection", N, 16);
  const projectionTransform = at;
  add("g_LFeature_ShadowProjectionTransform", N);
  const pointProjection = at;
  add("g_LFeature_ShadowPointProjection", PS);
  const pointProjectionTransform = at;
  add("g_LFeature_ShadowPointProjectionTransform", PS);
  return {
    size: at,
    slices,
    point,
    spot,
    tube,
    directional,
    projection,
    projectionTransform,
    pointProjection,
    pointProjectionTransform,
    projections: N,
  };
}

/** 一条阴影条目（rea-p13-shadows R2.2）：点光一条（6 个面），平行光每级一条。 */
export interface ShadowEntry {
  light: SceneLight;
  /** 平行光的级联号 0–2；点光为 null */
  cascade: number | null;
  /** 写投影与方块变换的槽：点光是 `ShadowPointProjection` 的下标，平行光是 `ShadowProjection` 的下标（可能越过 N，R2.4） */
  slot: number;
}

export interface LightFrame {
  layout: LightBufferLayout;
  /** 整块缓冲：阴影的投影与方块变换由 `render/shadows.ts` 打包之后再写 */
  buffer: Float32Array;
  entries: ShadowEntry[];
}

/** 排序键（R2.3）：类型升序 → `flags` 降序 → `dot(局部 origin, g_ViewForward)` 升序；同键保持原顺序（WPE 是 ≤ 32 个的插入排序）。 */
export function sortLights(lights: readonly SceneLight[], forward: readonly number[]): SceneLight[] {
  const f = Math.fround;
  const key = (light: SceneLight) =>
    f(
      f(f(f(light.origin[0]) * f(forward[0])) + f(f(light.origin[1]) * f(forward[1]))) +
        f(f(light.origin[2]) * f(forward[2])),
    );
  return lights
    .map((light, index) => ({ light, index, key: key(light) }))
    .sort(
      (a, b) =>
        KIND_ORDER[a.light.kind] - KIND_ORDER[b.light.kind] ||
        b.light.flags - a.light.flags ||
        a.key - b.key ||
        a.index - b.index,
    )
    .map((item) => item.light);
}

/**
 * 一帧的灯光缓冲与阴影条目（`FUN_140190c80`，rea-p13-shadows R2.2）。`quality` 是阴影档位，`forward` 是本帧的 `g_ViewForward`。
 * - 灯按 {@link sortLights} 排序后遍历，跳过不可见的；
 * - 点光：`P` 的余量为 0 就整盏跳过；`flag = 档位 ≠ 0 && castshadow` 选指针（阴影段从槽 0、普通段从槽 `PS` 起），写颜色半径与位置指数，
 *   之后另判 `flag && PS 余量 > 0` 才生成一条阴影条目（投影下标是第几条点光阴影）；
 * - 平行光：同样按 `flag` 选指针（阴影从槽 0、普通从 `DS`），之后 `flag && N 余量 > 0`（初值 N，每盏 −1）才生成三级条目，下标从
 *   `SSC + SC + SS`（聚光的那几项恒 0）起每级 +1、跨盏连续（可能越过 N）；
 * - 聚光、管光照旧（聚光阴影 / cookie 照报，不会走到）；
 * - 用完的平行光槽把方向补成 (0, 1, 0, 0)、颜色保持 0（`0x1401931bb`：方向是 0 向量时着色器归一化出 NaN，颜色 0 也挡不住）。
 * 越界写落进整块缓冲的下一段，越过整块末尾的丢掉（WPE 会写坏别的内存，语料不会走到）。
 */
export function lightFrame(
  lights: readonly SceneLight[],
  counts: LightCounts,
  quality: number,
  forward: readonly number[],
): LightFrame {
  const layout = lightBufferLayout(counts);
  const buffer = new Float32Array(layout.size);
  const write = (at: number, values: readonly number[]) => {
    for (let k = 0; k < values.length; k++) if (at + k < buffer.length) buffer[at + k] = values[k] ?? 0;
  };
  const shadows = quality !== 0;
  const entries: ShadowEntry[] = [];
  const remaining = { point: counts.point, spot: counts.spot, tube: counts.tube, directional: counts.directional };
  let pointShadowSlot = 0;
  let pointPlainSlot = counts.pointShadow;
  let pointShadowsLeft = counts.pointShadow;
  let dirShadowSlot = 0;
  let dirPlainSlot = counts.directionalShadow;
  let projectionsLeft = layout.projections;
  let projectionSlot = counts.spotShadowCookie + counts.spotCookie + counts.spotShadow;
  let spotSlot = 0;
  let tubeSlot = 0;
  const { point: P, spot: S, tube: T, directional: D } = counts;
  for (const light of sortLights(lights, forward)) {
    if (!light.visible || remaining[light.kind] <= 0) continue;
    remaining[light.kind]--;
    const flag = shadows && (light.flags & 1) !== 0;
    const { color, origin } = light;
    if (light.kind === "point") {
      const slot = flag ? pointShadowSlot++ : pointPlainSlot++;
      write(layout.point + slot * 4, [...color, light.radius]);
      write(layout.point + 4 * P + slot * 4, [...origin, light.exponent]);
      if (flag && pointShadowsLeft > 0) {
        pointShadowsLeft--;
        entries.push({ light, cascade: null, slot: counts.pointShadow - pointShadowsLeft - 1 });
      }
    } else if (light.kind === "directional") {
      const slot = flag ? dirShadowSlot++ : dirPlainSlot++;
      const m = light.matrix;
      write(layout.directional + slot * 4, [...color, 1]);
      // 方向是本地 +X 取反（「着色点指向灯」）
      write(layout.directional + 4 * D + slot * 4, [-m[0], -m[1], -m[2], 0]);
      if (flag && projectionsLeft > 0) {
        projectionsLeft--;
        for (let cascade = 0; cascade < 3; cascade++) entries.push({ light, cascade, slot: projectionSlot++ });
      }
    } else if (light.kind === "spot") {
      const slot = spotSlot++;
      const m = light.matrix;
      write(layout.spot + slot * 4, [...color, light.radius]);
      write(layout.spot + 4 * S + slot * 4, [...origin, light.inner]);
      // 局部 +X 是照射方向
      write(layout.spot + 8 * S + slot * 4, [m[0], m[1], m[2], light.outer]);
      write(layout.spot + 12 * S + slot * 4, [light.exponent]);
    } else {
      const slot = tubeSlot++;
      write(layout.tube + slot * 4, [...color, light.radius]);
      write(layout.tube + 4 * T + slot * 4, [...origin, light.exponent]);
      write(layout.tube + 8 * T + slot * 4, [...light.tubeEnd, 0]);
    }
  }
  // 用完的平行光槽：阴影段与普通段各自剩下的
  for (let slot = dirShadowSlot; slot < counts.directionalShadow; slot++)
    write(layout.directional + 4 * D + slot * 4, [0, 1, 0, 0]);
  for (let slot = Math.max(dirPlainSlot, counts.directionalShadow); slot < D; slot++)
    write(layout.directional + 4 * D + slot * 4, [0, 1, 0, 0]);
  return { layout, buffer, entries };
}

/** 整块缓冲 → 各 uniform 的值（`lightFrame` 与阴影写完之后）。 */
export function lightFrameUniforms(frame: Pick<LightFrame, "layout" | "buffer">): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [name, [start, length]] of Object.entries(frame.layout.slices))
    out[name] = Array.from(frame.buffer.subarray(start, start + length));
  return out;
}

/** 灯光 uniform 的全部名字（`lightBufferLayout` 可能切出的）。 */
export const LIGHT_FRAME_UNIFORMS: ReadonlySet<string> = new Set([
  "g_LPoint_Color",
  "g_LPoint_Origin",
  "g_LSpot_Color",
  "g_LSpot_Origin",
  "g_LSpot_Direction",
  "g_LSpot_Exponent",
  "g_LTube_Color",
  "g_LTube_OriginA",
  "g_LTube_OriginB",
  "g_LDirectional_Color",
  "g_LDirectional_Direction",
  "g_LFeature_ShadowProjection",
  "g_LFeature_ShadowProjectionTransform",
  "g_LFeature_ShadowPointProjection",
  "g_LFeature_ShadowPointProjectionTransform",
]);

/**
 * 灯对象 → 灯光 uniform（不带阴影的投影）：`lightFrame` 在相机看 −z（`g_ViewForward = (0, 0, −1)`）、阴影档位 0 时的切片。
 * 编译期测试与只看灯光数组的地方用；渲染器每帧按当时的 `g_ViewForward` 调 `lightFrame`。
 */
export function lightUniforms(
  objects: readonly SceneObject[],
  counts: LightCounts,
  read: (value: SceneValue | undefined, path: string) => SceneScalar | undefined,
): Record<string, number[]> {
  return lightFrameUniforms(lightFrame(collectSceneLights(objects, read), counts, 0, [0, 0, -1]));
}

/** 遗留灯的三个数组（rea-p13-lights 1.4）：着色器声明了哪个就写哪个，不看 `LIGHTING`。 */
export const LEGACY_LIGHT_UNIFORMS: ReadonlySet<string> = new Set([
  "g_LightsPosition",
  "g_LightsColorRadius",
  "g_LightsColorPremultiplied",
]);

/** 程序读到遗留灯数组之一（没标 `unused`、不是作者自己的材质常量，口径同 `readsAudioUniforms`）。 */
export function readsLegacyLights(result: Pick<TranslateResult, "uniforms">): boolean {
  return (result.uniforms ?? []).some(
    (uniform) =>
      !uniform.unused && typeof uniform.meta?.material !== "string" && LEGACY_LIGHT_UNIFORMS.has(uniform.name),
  );
}

const LEGACY_SLOTS = 4;

/**
 * 遗留灯（`"light": "point"`）→ 三个数组（rea-p13-lights 第 1 节，`FUN_14018ff60` 分槽、`FUN_14025d1f0` 写入）：
 * - 每个灯对象（`light` 是字符串，不分类型，`lpoint` 等也算）按 `objects` 顺序取第一个空槽，4 个都占时取槽 0；
 * - 遗留灯写自己的槽：位置 = 世界平移（挂父对象的灯照报 `object:parent`，这里取本地 `origin`；P13f 改成父链），
 *   颜色半径 = 可见 ? `(color·intensity, radius)` : `(0, 0, 0, 1)`，隐藏时位置照写；同槽后写的覆盖先写的；
 * - 没人写的槽：位置 `(0, 100, 0)`、颜色半径 `(0, 0, 0, 1)`（渲染上下文的初值）；
 * - `g_LightsColorPremultiplied[i].rgb = c_i · r_i²`（i = 0..2），`[i].w = c_3[i] · r_3²`（c、r 取颜色半径）。
 * 颜色乘强度、半径平方、两者相乘都逐步按单精度舍入（`Math.fround`，p13-REPORT「P13a 的实测」A5：WPE 的 `108000.0078`）。
 * 位置是 `vec3[4]`，按声明分量展平（12 个数，`UniformBlock.set` 按 16 字节步长写）。
 */
export function legacyLightUniforms(
  objects: readonly SceneObject[],
  read: (value: SceneValue | undefined, path: string) => SceneScalar | undefined,
): Record<string, number[]> {
  const position: number[][] = Array.from({ length: LEGACY_SLOTS }, () => [0, 100, 0]);
  const colorRadius: number[][] = Array.from({ length: LEGACY_SLOTS }, () => [0, 0, 0, 1]);
  const taken = new Array<boolean>(LEGACY_SLOTS).fill(false);
  const f = Math.fround;
  objects.forEach((object, index) => {
    if (!isSceneObject(object) || typeof object.light !== "string") return;
    const free = taken.indexOf(false);
    const slot = free < 0 ? 0 : free;
    if (free >= 0) taken[free] = true;
    if (object.light !== "point") return;
    const at = (field: string) => `objects/${index}/${field}`;
    const vector = (key: string, fallback: readonly number[]) =>
      numbers(read(object[key] as SceneValue | undefined, at(key)), [...fallback]);
    const origin = vector("origin", [0, 0, 0]);
    position[slot] = [0, 1, 2].map((k) => f(origin[k] ?? 0));
    if (read(object.visible, at("visible")) === false) {
      colorRadius[slot] = [0, 0, 0, 1];
      return;
    }
    const intensity = f(numbers(read(object.intensity as SceneValue | undefined, at("intensity")), [0])[0] ?? 0);
    const color = vector("color", DEFAULTS.color);
    const radius = f(numbers(read(object.radius as SceneValue | undefined, at("radius")), [1])[0] ?? 1);
    colorRadius[slot] = [...[0, 1, 2].map((k) => f(f(color[k] ?? 0) * intensity)), radius];
  });
  const premultiplied: number[] = [];
  for (let i = 0; i < LEGACY_SLOTS - 1; i++) {
    const [r, g, b, radius] = colorRadius[i];
    const square = f(radius * radius);
    premultiplied.push(f(r * square), f(g * square), f(b * square));
    const last = colorRadius[LEGACY_SLOTS - 1];
    premultiplied.push(f(last[i] * f(last[3] * last[3])));
  }
  return {
    g_LightsPosition: position.flat(),
    g_LightsColorRadius: colorRadius.flat(),
    g_LightsColorPremultiplied: premultiplied,
  };
}

/** `lightUniforms` 里 `read` 的标准实现：解析 `{user}` 并登记成 `target`。 */
export function bindingReader(
  bindings: BindingCollector,
  properties: Record<string, SceneScalar>,
  target: (path: string) => BindingTarget,
): (value: SceneValue | undefined, path: string) => SceneScalar | undefined {
  return (value, path) => bindings.bind(value, properties, target(path));
}
