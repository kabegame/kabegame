/**
 * 光标命中与派发（P6c，`.claude/plans/wpe-import/3-scene/phase6/phase-6c-interaction.md` 步骤 1，规则读码见 `rea-p6c-dispatch.md` 与
 * 「REA 重核」，p6-REPORT 0c 用 `input_play` 对 WPE 逐帧实测，`ignore/p6/c0/out/wpe-*.log`）。纯逻辑，不碰 GPU。
 *
 * 一个实时帧一次：渲染器在相机定好之后、脚本（媒体、关键帧动画、计时器、`update`）之前，把本帧的光标世界坐标与射线、左键、按命中顺序
 * 排好的可拾取对象表交给 {@link CursorTracker}，它按 WPE `FUN_140189e10` 的规则维护「悬停集合」「按下集合」，返回本帧要派发的回调序列；
 * 渲染器交给宿主的脚本运行时（`ScriptRuntime.cursorEvent`），每个对象上导出了该回调的全部脚本各调一次。
 *
 * 一致的怪处（照 WPE，全部实测过）：
 * - **不看可见性**：`visible: false` 的图层、父层隐藏的图层、`alpha` 为 0 的图层照样被命中、收事件（语料 75 段脚本靠隐藏图层当按钮）；
 *   可见性只用在「停止传播」上。`solid` 缺省真，`solid: false` 的对象什么事件都没有。
 * - **层叠时全部命中的对象都收事件**（自上而下，同一帧里按对象依次派发）；只有命中一个「自身与父链都可见、`disablepropagation` 为真」的对象
 *   才挡住下面的：下面的对象这一帧完全不处理，不发 `cursorLeave` / `cursorUp`，直到挡住它的对象不再命中。
 * - **命中是射线对平行四边形**（双面，不看纹理 alpha、不看材质），平行四边形不要求 `u + v ≤ 1`；`fullscreen` 图层恒命中，不发 `cursorLeave`。
 * - **`localPosition`** 以四边形左上角为原点、y 向下、单位是图层 `size`（不乘缩放）；没命中时也算，外推到 `[0, size]` 之外；射线平行或交点在射线
 *   后方时保持 0。
 * - **子层的视差命中用自己的本地 `origin` 与自己的 `parallaxDepth`**，和绘制（取根对象的）不一致：命中区和画出来的位置可以错开。
 * - **`cursorMove` 比的是世界坐标**（不是屏幕坐标）：光标不动、相机在动（抖动、视差、缩放）时每帧都发；第一帧上一次的位置是 (0, 0)。
 * - 按下只登记命中的对象；按住期间（按下集合非空且左键仍按着）只给按下集合里的对象发 `cursorMove`，不发进出；`cursorClick` 要求松开那一帧命中、
 *   且按下那一帧在它上面按下；松开处命中的全部对象收 `cursorUp`，加上按下集合里没命中的（拖出去再松开）。按下集合在每个左键松开的帧末清空。
 * - 一帧只采一次左键：两帧之间完整的一次按下抬起整个丢掉。
 * - `cursorHitTest` WPE 自己也不调用（exe 里没有调用点），导出它只打开拾取；模型（类型 5）P6c 不做命中，能力表照报 `cursor:model`。
 *
 * 数值照 WPE 的 float32 运算顺序（每次运算 `Math.fround`），日志里的世界坐标 / 局部坐标才能和 WPE 逐位对上（`799.5001220703125` 这种单精度痕迹）。
 * 世界坐标的反投影与粒子控制点的指针反投影（`pointerScenePoint`）是同一串 float32 运算，P4c 已逐位对上。
 */
import { drawMatrixOf, effectiveVisible } from "./layout";
import { invertF32 } from "./inverseF32";
import { multiply, type Mat4 } from "./math";
import { parallaxOffset, type SceneParallax } from "./parallax";
import { transparentSortKey } from "./sortOrder";
import type { LayerState } from "./state";
import type { SceneLayer } from "../compile/bundle";
import type { TextLayout } from "../text/layout";

const f = Math.fround;

export type Vec3Tuple = [number, number, number];

/** 光标回调（`cursorHitTest` 不在这里：WPE 不调用它）。 */
export type CursorCallback = "cursorEnter" | "cursorLeave" | "cursorMove" | "cursorDown" | "cursorUp" | "cursorClick";

/** 一条射线：起点与（单位）方向，float32。 */
export interface Ray {
  origin: Vec3Tuple;
  direction: Vec3Tuple;
}

/** 一个可拾取对象（类型 1 图像 / 4 文本）：命中测试要的全部输入，由 {@link pickablesOf} 从图层与状态现算。 */
export interface Pickable {
  /** `objects` 下标。 */
  object: number;
  /** 画自己的矩阵（`drawMatrixOf`：世界矩阵右乘对齐 / 文字框偏移）。`fullscreen` 的不用它。 */
  matrix: Mat4;
  /** `+0x2f0`：图像层是对象 `size`（autosize 之后），文本层是排版出的文字框。 */
  size: readonly [number, number];
  /** 对象自己的本地 `origin` 与 `parallaxDepth`（视差命中用：子层也是自己的，不是根的）。 */
  origin: readonly number[];
  parallaxDepth: readonly number[];
  /** `solid`：为假的对象不收任何事件。 */
  solid: boolean;
  /** 图层 `perspective: true`：用透视覆盖相机的射线。 */
  perspective: boolean;
  /** 模型 `fullscreen`：恒命中，`localPosition` 是窗口像素。 */
  fullscreen: boolean;
  /** `disablepropagation` 为真、自身与父链都可见：命中它就不再处理下面的对象。 */
  blocks: boolean;
}

/** 一帧的光标输入（{@link CursorTracker.step}）。 */
export interface CursorFrame {
  /** 光标的世界坐标（反投影到 NDC z = 0；正交场景 z 置 0）。 */
  world: Vec3Tuple;
  /** 普通射线；`perspectiveRay` 是 `perspective` 图层用的（只在正交场景里有，没有时取普通射线）。 */
  ray: Ray;
  perspectiveRay: Ray | null;
  /** 本帧登记的左键。 */
  down: boolean;
  /** 本帧的视差（只在正交场景且开着视差时有）：对象的命中区按 `amount·(自己的 origin − P)·自己的 parallaxDepth` 平移。 */
  parallax: SceneParallax | null;
  /** 窗口客户区像素（`fullscreen` 的 `localPosition`）：`ptr · (Ws, Hs)`。 */
  windowPixel: readonly [number, number];
}

/** 要派发的一条：对象、回调、世界坐标与这个对象的局部坐标（float32 展开）。 */
export interface CursorDispatch {
  object: number;
  callback: CursorCallback;
  world: Vec3Tuple;
  local: Vec3Tuple;
}

// ---------------------------------------------------------------------------------------------------------------------
// 射线对平行四边形

/** `FUN_14019d5a0` 判平行的阈值（`1.1920929e-07`）。 */
const PARALLEL_EPS = 1.1920929e-7;

interface QuadHit {
  /** 是否落在四边形里（`0 ≤ u, v ≤ 1`，没有 `u + v` 条件）。 */
  inside: boolean;
  /** 已除以行列式的参数坐标。 */
  u: number;
  v: number;
  /** 射线参数；平行时 −1。 */
  t: number;
}

/**
 * 射线 `(o, d)` 与以 `p0` 为一角、边 `p1 − p0`、`p2 − p0` 张成的平行四边形求交：`FUN_14019d5a0` 的逐步 float32 搬运（Möller–Trumbore 的变体，
 * **正负行列式都接受**，所以是双面的）。`|det| ≤ 1.1920929e-7` 判平行（`u = v = 0`、`t = −1`、不在里面）；`t` 不论范围内外都算出来。
 */
export function intersectParallelogram(ray: Ray, p0: Vec3Tuple, p1: Vec3Tuple, p2: Vec3Tuple): QuadHit {
  const [ox, oy, oz] = ray.origin;
  const [dx, dy, dz] = ray.direction;
  const e1x = f(p1[0] - p0[0]);
  const e1y = f(p1[1] - p0[1]);
  const e1z = f(p1[2] - p0[2]);
  const e2x = f(p2[0] - p0[0]);
  const e2y = f(p2[1] - p0[1]);
  const e2z = f(p2[2] - p0[2]);
  // pvec = d × e2
  const px = f(f(dy * e2z) - f(dz * e2y));
  const py = f(f(dz * e2x) - f(dx * e2z));
  const pz = f(f(dx * e2y) - f(dy * e2x));
  const det = f(f(f(px * e1x) + f(py * e1y)) + f(pz * e1z));
  // 先判 `det ≤ ε`（NaN 不满足，走正行列式那一支，同 WPE）
  if (det <= PARALLEL_EPS && -PARALLEL_EPS <= det) return { inside: false, u: 0, v: 0, t: -1 };
  const tx = f(ox - p0[0]);
  const ty = f(oy - p0[1]);
  const tz = f(oz - p0[2]);
  const u0 = f(f(f(tx * px) + f(ty * py)) + f(tz * pz));
  // qvec = tvec × e1
  const qx = f(f(ty * e1z) - f(tz * e1y));
  const qy = f(f(tz * e1x) - f(tx * e1z));
  const qz = f(f(tx * e1y) - f(ty * e1x));
  const v0 = f(f(f(qy * dy) + f(qx * dx)) + f(qz * dz));
  let inside = true;
  if (det <= PARALLEL_EPS) {
    // 行列式为负：要 det ≤ u ≤ 0、det ≤ v ≤ 0
    if (u0 > 0 || u0 < det) inside = false;
    if (!(v0 <= 0 && (det < v0 || v0 === det))) inside = false;
  } else {
    if (u0 < 0 || det < u0) inside = false;
    if (!(0 <= v0 && (v0 < det || v0 === det))) inside = false;
  }
  const inverse = f(1 / det);
  const t = f(f(f(f(e2y * qy) + f(qx * e2x)) + f(e2z * qz)) * inverse);
  return { inside, u: f(u0 * inverse), v: f(v0 * inverse), t };
}

/**
 * 图像 / 文本的命中（`FUN_14019dbb0`）：`fullscreen` 恒命中，`local` 是窗口像素；否则取画自己的矩阵，四个角是
 * `T ± A/2 ± B/2`（`A = 第 0 列 × size.x`、`B = 第 1 列 × size.y`，`T = 平移 + 视差偏移`），射线对它求交。`t < 0`（射线后方，或平行）时不命中、
 * **不写 `local`**（保持 0）；其余情形不论落在里面外面都写 `local = (u·size.x, (1 − v)·size.y, 0)`，命中只看 `inside`。
 * 矩阵的文本 `anchor` 乘子（`vt[0xa8]`）能力表只放行 `none`，不乘。
 */
export function hitQuad(
  ray: Ray,
  pickable: Pickable,
  offset: readonly [number, number, number],
  windowPixel: readonly [number, number],
): { hit: boolean; local: Vec3Tuple } {
  const local: Vec3Tuple = [0, 0, 0];
  if (pickable.fullscreen) return { hit: true, local: [f(windowPixel[0]), f(windowPixel[1]), 0] };
  const m = pickable.matrix;
  const sx = f(pickable.size[0]);
  const sy = f(pickable.size[1]);
  const tx = f(m[12] + offset[0]);
  const ty = f(m[13] + offset[1]);
  const tz = f(m[14] + offset[2]);
  // 半边（取负）：A/2、B/2 的每个分量，`(列 × size) × −0.5`
  const anx = f(f(m[0] * sx) * -0.5);
  const any = f(f(m[1] * sx) * -0.5);
  const anz = f(f(m[2] * sx) * -0.5);
  const bnx = f(f(m[4] * sy) * -0.5);
  const bny = f(f(m[5] * sy) * -0.5);
  const bnz = f(f(m[6] * sy) * -0.5);
  const c0: Vec3Tuple = [f(f(bnx + anx) + tx), f(f(bny + any) + ty), f(f(bnz + anz) + tz)];
  const c1: Vec3Tuple = [
    f(f(f(f(m[0] * sx) * 0.5) + bnx) + tx),
    f(f(f(f(m[1] * sx) * 0.5) + bny) + ty),
    f(f(f(f(m[2] * sx) * 0.5) + bnz) + tz),
  ];
  const c2: Vec3Tuple = [
    f(f(f(f(m[4] * sy) * 0.5) + anx) + tx),
    f(f(f(f(m[5] * sy) * 0.5) + any) + ty),
    f(f(f(f(m[6] * sy) * 0.5) + anz) + tz),
  ];
  const quad = intersectParallelogram(ray, c0, c1, c2);
  if (quad.t < 0) return { hit: false, local };
  local[0] = f(quad.u * sx);
  local[1] = f(f(1 - quad.v) * sy);
  return { hit: quad.inside, local };
}

// ---------------------------------------------------------------------------------------------------------------------
// 反投影与射线

/**
 * 窗口归一化坐标下的光标 → 世界坐标（`FUN_14018e070` / `FUN_14019df90` 的 glm::unProject）：`(px, 1 − py, 0.5)` 经 `inverse(P·V)`，即 NDC
 * `(2px − 1, 1 − 2py, 0)`；透视场景里 NDC z = 0 是远平面。逐步 float32 同 `particles/controlpoints.ts` 的 `pointerScenePoint`（P4c 已和 WPE
 * 逐位对上，那里只取 x、y），这里多取 z。`viewProjection` 是列向量约定的 `P·V`；`cursor` 是光标下的场景纹理坐标（渲染器按壁纸样式换好，
 * `render/layout.ts` 的 `sceneCursor`，`fill` 就是窗口归一化坐标）。求逆用 WPE 的 float32 版本（`inverseF32.ts`，正交矩阵的逆和 double 余子式差 1 ulp，
 * 世界坐标才能和 WPE 日志逐位相同）；奇异时同 WPE 得到 inf / NaN。
 */
export function unprojectCursor(viewProjection: Mat4, cursor: readonly [number, number]): Vec3Tuple {
  const a = invertF32(viewProjection);
  const px = f(cursor[0]);
  const py = f(cursor[1]);
  const sx = f(px - 0);
  const x = f(f(sx + sx) - 1);
  const sy = f(f(1 - py) - 0);
  const y = f(f(sy + sy) - 1);
  const w = f(f(f(a[3] * x) + f(a[7] * y)) + f(f(a[11] * 0) + a[15]));
  const X = f(f(f(f(a[0] * x) + f(a[4] * y)) + f(f(a[8] * 0) + a[12])) / w);
  const Y = f(f(f(f(a[1] * x) + f(a[5] * y)) + f(f(a[9] * 0) + a[13])) / w);
  const Z = f(f(f(f(a[2] * x) + f(a[6] * y)) + f(f(a[10] * 0) + a[14])) / w);
  return [X, Y, Z];
}

/** 单位化（float32）：`x · (1 / sqrt(x² + y² + z²))`，同 `FUN_14018e1a0` 的写法。 */
function normalized(x: number, y: number, z: number): Vec3Tuple {
  const length = f(Math.sqrt(f(f(f(x * x) + f(y * y)) + f(z * z))));
  const inverse = f(1 / length);
  return [f(inverse * x), f(inverse * y), f(inverse * z)];
}

/**
 * 普通射线（`FUN_14018e1a0`）：正交场景起点 `(p.x, p.y, eye.z)`、方向 `(0, 0, −1)`；透视场景起点 eye、方向 `normalize(p − eye)`。`p` 是
 * 未置 0 的世界坐标。
 */
export function sceneRay(world: Vec3Tuple, eye: readonly number[], perspective: boolean): Ray {
  const ez = f(eye[2] ?? 0);
  if (!perspective) return { origin: [world[0], world[1], ez], direction: [0, 0, -1] };
  const ex = f(eye[0] ?? 0);
  const ey = f(eye[1] ?? 0);
  return {
    origin: [ex, ey, ez],
    direction: normalized(f(world[0] - ex), f(world[1] - ey), f(world[2] - ez)),
  };
}

/** 正交场景里 `perspective: true` 的图层的透视覆盖相机的输入（`FUN_14018fc40`，rea-p5-camera 第 7 节）。 */
export interface PerspectiveOverride {
  /** 场景的视图 V（带抖动的平移）与正交投影 P（带缩放），即 `GpuScene` 的 `sceneCamera`。 */
  view: Mat4;
  projection: Mat4;
  /** `general.perspectiveoverridefov`（弧度）。 */
  fov: number;
  /** 场景的正交尺寸 `Wi`、`Hi`（透视覆盖相机放在可见区中心）。 */
  width: number;
  height: number;
  /** 窗口客户区像素（投影宽高比取它，`ctx+0x74 / +0x78`）。 */
  window: readonly [number, number];
}

/** 透视覆盖的近、远裁剪面：近 5，远 `max(15000, d + 1000)`（`FUN_14018fc40`）。 */
const OVERRIDE_NEAR = 5;
const OVERRIDE_FAR_MIN = 15000;

/**
 * `perspective: true` 图层的射线（`FUN_14018fc40`）：把场景 V 拷一份，平移换成 `(t.x − Wi·0.5, t.y − Hi·0.5, −d)`，`d = 1 / (tan(fov/2) / (1 / P11))`；
 * 投影是反向 Z 的透视（fov、窗口宽高比、near 5、far `max(15000, d + 1000)`，同 `render/layout.ts` 的 `particleViewProjection`）。光标按它反投影得 `p`，
 * 射线起点是 `inverse(V′)` 的平移（相机位置），方向 `normalize(p − 起点)`。
 */
export function perspectiveLayerRay(input: PerspectiveOverride, cursor: readonly [number, number]): Ray | null {
  const P11 = input.projection[5];
  const d = f(1 / f(f(Math.tan(f(input.fov * 0.5))) / f(1 / P11)));
  const far = Math.max(OVERRIDE_FAR_MIN, f(d + 1000));
  const view = new Float32Array(input.view);
  view[12] = f(input.view[12] - f(f(input.width) * 0.5));
  view[13] = f(input.view[13] - f(f(input.height) * 0.5));
  view[14] = -d;
  const focal = f(1 / Math.tan(f(input.fov * 0.5)));
  const aspect = f(input.window[0] / input.window[1]);
  const projection = new Float32Array(16);
  projection[0] = f(focal / aspect);
  projection[5] = focal;
  projection[10] = f(OVERRIDE_NEAR / f(far - OVERRIDE_NEAR));
  projection[11] = -1;
  projection[14] = f(f(far * OVERRIDE_NEAR) / f(far - OVERRIDE_NEAR));
  const p = unprojectCursor(multiply(projection, view), cursor);
  const inverse = invertF32(view);
  const origin: Vec3Tuple = [inverse[12], inverse[13], inverse[14]];
  return {
    origin,
    direction: normalized(f(p[0] - origin[0]), f(p[1] - origin[1]), f(p[2] - origin[2])),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// 追踪器

/**
 * 悬停集合与按下集合的状态机（`FUN_140189e10` 的主体）。`step` 每个实时帧一次，`pickables` 已是命中顺序（最上面的在前，见 {@link pickablesOf}）。
 * 不看 `visible`、不看 `alpha`；只认 `solid` 的对象。返回按派发顺序排好的回调：同一帧里按对象依次，同一对象 `Enter → Move → Down` /
 * `Enter → Move → Up → Click` / 没命中 `Up → Leave`。
 */
export class CursorTracker {
  /** 在悬停集合里的对象（已发过 Enter、还没 Leave）。 */
  private readonly hover = new Set<number>();
  /** 按下集合：左键按下那一帧命中的对象，到左键松开那一帧末清空。 */
  private readonly pressed = new Set<number>();
  /** 上一帧的光标世界坐标 xy（初值 (0, 0)：第一帧世界坐标不恰好是 (0, 0) 就算移动过）与上一帧的左键。 */
  private lastX = 0;
  private lastY = 0;
  private lastDown = false;

  step(frame: CursorFrame, pickables: readonly Pickable[]): CursorDispatch[] {
    const out: CursorDispatch[] = [];
    const [wx, wy] = frame.world;
    // 比的是世界坐标：NaN 总是不等
    const moved = wx !== this.lastX || wy !== this.lastY;
    this.lastX = wx;
    this.lastY = wy;
    const down = frame.down;
    const previous = this.lastDown;
    // 帧初按下集合是不是空：决定走「悬停」还是「按住拖动」（循环里往里加不改这个判断）
    const holding = this.pressed.size > 0 && down;
    for (const pickable of pickables) {
      if (!pickable.solid) continue;
      const offset: Vec3Tuple = [0, 0, 0];
      if (frame.parallax) {
        const [x, y] = parallaxOffset(
          frame.parallax.amount,
          pickable.parallaxDepth,
          pickable.origin,
          frame.parallax.point,
        );
        offset[0] = x;
        offset[1] = y;
      }
      const wasPressed = this.pressed.has(pickable.object);
      const ray = pickable.perspective ? (frame.perspectiveRay ?? frame.ray) : frame.ray;
      const { hit, local } = hitQuad(ray, pickable, offset, frame.windowPixel);
      const emit = (callback: CursorCallback) =>
        out.push({ object: pickable.object, callback, world: [...frame.world], local: [...local] });
      if (holding) {
        // 按住拖动：只给按下集合里的对象发 Move（不管命中不命中，localPosition 是外推值），不进出、不挡
        if (wasPressed && moved) emit("cursorMove");
        continue;
      }
      if (hit) {
        if (!this.hover.has(pickable.object)) {
          this.hover.add(pickable.object);
          emit("cursorEnter");
        }
        if (moved) emit("cursorMove");
        if (down !== previous) {
          emit(down ? "cursorDown" : "cursorUp");
          if (down) this.pressed.add(pickable.object);
          else if (wasPressed) emit("cursorClick");
        }
        // 停止传播：下面的对象这一帧都不处理（也不发 Leave / Up）
        if (pickable.blocks) break;
      } else {
        // 拖出图层后在外面松开：按下集合里的对象只收 Up（不发 Click）
        if (!down && previous && wasPressed) emit("cursorUp");
        if (this.hover.delete(pickable.object)) emit("cursorLeave");
      }
    }
    this.lastDown = down;
    if (!down) this.pressed.clear();
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 可拾取对象表

/** {@link pickablesOf} 读的图层字段（`SceneLayer` 的子集）。 */
export type PickLayer = Pick<
  SceneLayer,
  "object" | "pick" | "perspective" | "fullscreen" | "size" | "disablePropagation" | "sortClass"
>;

/** {@link pickablesOf} 读的状态（`SceneState` 的子集）。 */
export interface PickState {
  readonly layers: ReadonlyMap<number, LayerState>;
  readonly texts: ReadonlyMap<number, Pick<TextLayout, "size">>;
}

/**
 * 本帧的可拾取对象表，已是命中顺序（最上面的在前）。从图层与状态现算，不从 GPU 的 draw 取：隐藏图层、写死不可见的祖先下面的图层也要参与。
 * 遍历顺序：正交场景是 `objects` 顺序的倒序；透视场景把全部可拾取对象按 `transparentSortKey(本地 origin, 视线方向)` 从大到小稳定排序
 * （`FUN_1401865c0` 的插入排序，`fullscreen` / `projectlayer` 的半透明层键是 −∞），再倒序：离相机近的先。`forward` 是当帧相机的视线方向（单位向量）。
 * 图层不在 `state.layers` 里（还没建）的跳过。
 *
 * TODO:[WPE_SCENE] 透视场景里 WPE 排的是全部对象，bit9（`fullscreen` / `projectlayer`）对不透明图层是不是也给 −∞ 没查；这里只看 `sortClass: "last"`
 * （半透明的那类）。语料里没有透视场景挂光标回调，`p6c-persp` 的三个层也不碰这一点。
 */
export function pickablesOf(
  layers: readonly PickLayer[],
  state: PickState,
  perspective: boolean,
  forward: readonly number[] = [0, 0, -1],
  cache = new Map<number, Mat4>(),
): Pickable[] {
  const picked = layers.filter((layer) => layer.pick && state.layers.has(layer.object));
  let order = picked;
  if (perspective) {
    const keyed = picked.map((layer) => ({
      layer,
      key:
        layer.sortClass === "last"
          ? -Infinity
          : transparentSortKey(state.layers.get(layer.object)?.origin ?? [0, 0, 0], forward),
    }));
    // 降序的稳定插入排序（同 `transparentDrawOrder`）
    for (let i = 1; i < keyed.length; i++) {
      const entry = keyed[i];
      let j = i;
      for (; j > 0 && entry.key > keyed[j - 1].key; j--) keyed[j] = keyed[j - 1];
      keyed[j] = entry;
    }
    order = keyed.map((entry) => entry.layer);
  }
  const out: Pickable[] = [];
  for (let i = order.length - 1; i >= 0; i--) {
    const layer = order[i];
    const own = state.layers.get(layer.object)!;
    const text = layer.pick === "text" ? state.texts.get(layer.object)?.size : undefined;
    const size = text ?? layer.size;
    out.push({
      object: layer.object,
      matrix: drawMatrixOf(layer.object, state.layers, cache),
      size: [size[0] ?? 0, size[1] ?? 0],
      origin: own.origin,
      parallaxDepth: own.parallaxDepth,
      solid: own.solid !== false,
      perspective: layer.perspective,
      fullscreen: layer.fullscreen,
      blocks: !!layer.disablePropagation && effectiveVisible(layer.object, state.layers),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// 一帧的驱动

/** 本帧的相机（渲染器与探针从 `GpuScene.cursorCamera` 取）。 */
export interface CursorCamera {
  /** 场景级的 `P·V`：正交场景带缩放、抖动与相机对象，透视场景是透视相机的。 */
  viewProjection: Mat4;
  /** `g_EyePosition`（正交时 z = 2000）。 */
  eye: readonly number[];
  /** 透视场景（命中顺序按视线排、射线从 eye 出发）。 */
  perspective: boolean;
  /** 视线方向（透视场景排序用）。 */
  forward: readonly number[];
  /** 正交场景里 `perspective: true` 图层的覆盖相机；透视场景没有。 */
  override: PerspectiveOverride | null;
}

/** 脚本 `input.*` 看到的本帧快照（每次读现问宿主，这里是宿主的「现」）。 */
export interface CursorInputSnapshot {
  /** `input.cursorWorldPosition`：同回调的 `worldPosition`（正交 z = 0）。 */
  world: Vec3Tuple;
  /** `input.cursorScreenPosition`：`ptr · (Ws, Hs)`，窗口客户区像素、左上原点、y 向下、不钳制（`z = 0`）。 */
  screen: [number, number];
  /** `input.cursorLeftDown`：登记过的左键状态。 */
  leftDown: boolean;
}

export interface CursorStepInput {
  camera: CursorCamera;
  /** 光标下的场景纹理坐标（`sceneCursor`）：反投影的输入，`fill` 与窗口归一化指针相同。 */
  cursor: readonly [number, number];
  /** 窗口归一化指针（`ptr`，原点左上、y 向下、不钳制）与窗口客户区像素：`screen` 与 `fullscreen` 的 `localPosition` 用。 */
  pointer: readonly [number, number];
  window: readonly [number, number];
  /** 本帧登记的左键。 */
  down: boolean;
  /** 本帧的视差（`drawParallax`，正交 + 开着视差时有）。 */
  parallax: SceneParallax | null;
}

/** 初始快照（还没有帧时脚本读到的）：全 0、左键松开。 */
export function emptyCursorInput(): CursorInputSnapshot {
  return { world: [0, 0, 0], screen: [0, 0], leftDown: false };
}

/**
 * 一个场景的光标会话：追踪器加每帧的输入换算。渲染器每个实时帧调 {@link CursorSession.frame}：总是算 `input.*` 快照（脚本可能只读 `input`，
 * 不导出任何光标回调），`dispatch` 为真（有脚本导出了光标回调）时才建拾取表、跑追踪器。换场景时丢掉整个会话（WPE 的悬停与按下集合在场景上）。
 */
export class CursorSession {
  private readonly tracker = new CursorTracker();

  frame(
    input: CursorStepInput,
    scene: { layers: readonly PickLayer[]; state: PickState },
    dispatch: boolean,
  ): { snapshot: CursorInputSnapshot; dispatches: CursorDispatch[] } {
    const { camera } = input;
    const unprojected = unprojectCursor(camera.viewProjection, input.cursor);
    // 正交场景把 z 置 0（透视场景落在远平面上）
    const world: Vec3Tuple = camera.perspective ? unprojected : [unprojected[0], unprojected[1], 0];
    const screen: [number, number] = [
      f(f(input.pointer[0]) * f(input.window[0])),
      f(f(input.pointer[1]) * f(input.window[1])),
    ];
    const snapshot: CursorInputSnapshot = { world, screen, leftDown: input.down };
    if (!dispatch) return { snapshot, dispatches: [] };
    const frame: CursorFrame = {
      world,
      // 射线用没置 0 的世界点（`FUN_14018e1a0` 的 `p`）
      ray: sceneRay(unprojected, camera.eye, camera.perspective),
      perspectiveRay: camera.override ? perspectiveLayerRay(camera.override, input.cursor) : null,
      down: input.down,
      parallax: camera.perspective ? null : input.parallax,
      windowPixel: [screen[0], screen[1]],
    };
    const pickables = pickablesOf(scene.layers, scene.state, camera.perspective, camera.forward);
    return { snapshot, dispatches: this.tracker.step(frame, pickables) };
  }
}
