/**
 * P5d 步骤 3（相机对象）的状态、相机求值、场景与渲染器侧（`.claude/plans/wpe-import/3-scene/phase5/phase-5d-camera-depth.md`「步骤 3」
 * 点 2–5）：
 * - `SceneState.cameras`：起始值取 `SceneLayer.camera`，`{ kind: "camera" }` 就地写、取值同编译期、不标脏；
 * - `render/camera.ts`：选相机（倒序、父链不可见、都不可见回退）；正交帧对上步骤 0 `p5d-camo-c` / `-o` / `-r`，透视覆盖对上补测
 *   `-pp` / `-ppr`，视差点对上 `-par`，抖动对上 `-shake`；透视场景对上 `p5d-camp-1` / `-2`（eye、fov）；
 * - `GpuScene`（假设备）：没有可见相机对象时 uniform 字节与没有相机对象的场景相同；可见时 VP、透视覆盖、眼位与视图向量进全部 draw；
 *   绑属性切换可见性，下一帧换相机；
 * - 渲染器：正交交相机对象的帧、视差点用相机的 eye.xy；透视用相机的姿态与 fov、路径不推进；
 * - dev 探针：`frameCamera` 同渲染器，回放时按状态里的可见性选。
 * 假设备与渲染器的搭法照 `p5d-camera.test.ts`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generalDefaults, type GeneralValues, type SceneBinding } from "../compile/bindings";
import type { SceneBundle, SceneGeneral, SceneLayer, ScenePass, SceneTexture } from "../compile/bundle";
import type { CameraPath, SceneCameraJson } from "../compile/camera";
import { particleFov } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import { frameCamera, probeCameraObjects, probePerspective } from "../dev/particleCorners";
import type { TranslateResult } from "../wpesl2wgsl";
import {
  activeCameraObject,
  cameraObjectLayers,
  initialCameraPathState,
  lookAtRH,
  orthographicCameraObjectFrame,
  orthographicCameraZoom,
  perspectiveCamera,
  replayCameraPath,
  sceneCameraFrame,
  type CameraPathState,
  type CameraPose,
} from "./camera";
import { acquireGpu } from "./device";
import { eyePosition, particleViewProjection, sceneViewProjection, worldMatrixOf } from "./layout";
import { multiply, translation, type Mat4 } from "./math";
import { advanceParallax, initialParallaxState, parallaxInput, type ParallaxState } from "./parallax";
import { SceneRenderer } from "./renderer";
import { GpuScene, type OrthographicSceneCamera, type SceneCamera } from "./scene";
import { shakeOffset } from "./shake";
import { SceneState } from "./state";
import type { FrameInput } from "./uniforms";

vi.mock("./device", () => ({ acquireGpu: vi.fn() }));
vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

// ———— 手写 bundle ————

const mat4 = (name: string, offset: number) => ({ name, type: "mat4x4<f32>", declared: "mat4", offset, size: 64 });
const vec3 = (name: string, offset: number) => ({ name, type: "vec3<f32>", declared: "vec3", offset, size: 12 });

/** 图像程序：MVP、VP、眼位与三个视图向量。 */
const IMAGE_PROGRAM = {
  ok: true,
  vertex: { wgsl: "// image v", entryPoint: "main" },
  fragment: { wgsl: "// image f", entryPoint: "main" },
  attributes: [
    { name: "a_Position", type: "vec3", location: 0 },
    { name: "a_TexCoord", type: "vec2", location: 1 },
  ],
  uniforms: [
    mat4("g_ModelViewProjectionMatrix", 0),
    mat4("g_ViewProjectionMatrix", 64),
    vec3("g_EyePosition", 128),
    vec3("g_ViewForward", 144),
    vec3("g_ViewRight", 160),
    vec3("g_ViewUp", 176),
  ],
  uniformBlockSize: 192,
  textures: [{ slot: 0, binding: 1, samplerBinding: 2, kind: "2d" }],
} as unknown as TranslateResult;

function pass(key: string, program: number, extra: Partial<ScenePass> = {}): ScenePass {
  return {
    key,
    program,
    blending: "translucent",
    cullmode: "nocull",
    depthtest: "disabled",
    depthwrite: "disabled",
    textures: {},
    runtime: {},
    uniforms: {},
    framebuffer: false,
    ...extra,
  };
}

const texture = (width: number, height: number): SceneTexture => ({
  path: `t${width}x${height}`,
  source: "",
  format: 0,
  width,
  height,
  textureWidth: width,
  textureHeight: height,
  flags: 0,
  clampUVs: true,
  noInterpolation: false,
  mips: [{ width, height, bytes: new Uint8Array(width * height * 4) }],
});

function layer(object: number, extra: Partial<SceneLayer> = {}): SceneLayer {
  return {
    id: object + 1,
    object,
    parent: null,
    name: `layer ${object}`,
    origin: [960, 540, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [256, 256],
    alpha: 1,
    color: [1, 1, 1],
    brightness: 1,
    visible: true,
    visibleBound: false,
    parallaxDepth: [1, 1],
    solidLayer: false,
    instanced: false,
    noPadding: false,
    perspective: false,
    passthroughModel: false,
    group: null,
    subtree: [],
    groupUpload: null,
    copyBackground: true,
    clampUVs: true,
    noInterpolation: false,
    fullscreen: false,
    fullscreenSize: null,
    passes: [pass(`objects/${object}/passes/0`, 0, { textures: { 0: 0 } })],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
    ...extra,
  };
}

/** 相机对象的图层（`compileScene` 编出来的样子：没有 pass、`camera` 非空）。 */
function cameraLayer(object: number, origin: number[], extra: Partial<SceneLayer> = {}): SceneLayer {
  return layer(object, {
    name: `camera ${object}`,
    origin,
    size: [],
    passes: [],
    camera: { fov: 50, zoom: 1 },
    ...extra,
  });
}

function fields(extra: Partial<GeneralValues> = {}): GeneralValues {
  return { ...generalDefaults(), ...extra };
}

const BASE_CAMERA: SceneCameraJson = { eye: [0, 0, 10], center: [0, 0, 0], up: [0, 1, 0], paths: [] };

function general(perspective: boolean, extra: Partial<GeneralValues> = {}, camera = BASE_CAMERA): SceneGeneral {
  return {
    width: perspective ? 0 : 1920,
    height: perspective ? 0 : 1080,
    perspective,
    camera: perspective ? camera : null,
    fields: fields(extra),
    clearVariable: false,
    perspectiveOverrideFov: particleFov(95),
    postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
    bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
  };
}

function bundleOf(
  layers: SceneLayer[],
  perspective = false,
  extra: Partial<GeneralValues> = {},
  camera = BASE_CAMERA,
): SceneBundle {
  return {
    general: general(perspective, extra, camera),
    layers,
    programs: [IMAGE_PROGRAM],
    textures: [texture(64, 64)],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
  };
}

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8, INDEX: 16 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SceneState.cameras（P5d 步骤 3 点 2）", () => {
  const binding = (object: number, field: "fov" | "zoom", condition?: string): SceneBinding => ({
    property: "p",
    ...(condition === undefined ? {} : { condition }),
    target: { kind: "camera", object, field },
  });

  it("起始值取 SceneLayer.camera（拷贝）；只含相机图层", () => {
    const bundle = bundleOf([layer(0), cameraLayer(1, [0, 0, 0], { camera: { fov: 40, zoom: 2 } })]);
    const state = SceneState.fromBundle(bundle);
    expect([...state.cameras]).toEqual([[1, { fov: 40, zoom: 2 }]]);
    state.cameras.get(1)!.fov = 10;
    expect(bundle.layers[1].camera).toEqual({ fov: 40, zoom: 2 });
  });

  it("就地写：取值同编译期（float，不合法不改字段），条件换成布尔（float 不收）；不标脏、不重编译", () => {
    const state = SceneState.fromBundle(bundleOf([cameraLayer(0, [0, 0, 0])]));
    state.takeDirty();
    expect(state.needsRecompile(binding(0, "fov"), 30)).toBe(false);
    expect(state.write(binding(0, "fov"), 30)).toBe("applied");
    expect(state.write(binding(0, "zoom"), "2.5")).toBe("applied");
    expect(state.cameras.get(0)).toEqual({ fov: 30, zoom: 2.5 });
    for (const raw of [true, "1 2", "x", null]) expect(state.write(binding(0, "fov"), raw)).toBe("applied");
    expect(state.write(binding(0, "zoom", "big"), "big")).toBe("applied");
    expect(state.cameras.get(0)).toEqual({ fov: 30, zoom: 2.5 });
    const dirty = state.takeDirty();
    expect([...dirty.layers, ...dirty.passes, ...dirty.structures, ...dirty.particles]).toEqual([]);
    expect(dirty.bloom).toBe(false);
    // 不在 bundle 里的相机：不做事
    expect(state.write(binding(7, "fov"), 30)).toBe("applied");
    expect(state.cameras.has(7)).toBe(false);
  });

  it("相机的可见性与变换就是图层字段：写 visible 标整棵子树", () => {
    const state = SceneState.fromBundle(
      bundleOf([cameraLayer(0, [0, 0, 0]), cameraLayer(1, [1, 0, 0], { parent: 0 })]),
    );
    state.takeDirty();
    state.write({ property: "v", target: { kind: "layer", object: 0, field: "visible" } }, false);
    expect(state.layers.get(0)!.visible).toBe(false);
    expect([...state.takeDirty().layers].sort()).toEqual([0, 1]);
  });
});

// ———— render/camera.ts ————

/** 列主序矩阵乘点 (x, y, z, 1)，返回裁剪坐标。 */
function clip(m: Mat4, [x, y, z]: readonly number[]): number[] {
  return [0, 1, 2, 3].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);
}
const ndc = (m: Mat4, point: readonly number[]) => {
  const c = clip(m, point);
  return { x: c[0] / c[3], y: c[1] / c[3], w: c[3] };
};
const expectClose = (actual: ArrayLike<number>, expected: readonly number[], digits = 5) =>
  expected.forEach((value, i) => expect(actual[i], `[${i}]`).toBeCloseTo(value, digits));

/** 场景状态里选相机：bundle 的图层按给定顺序（不一定是 objects 顺序）。 */
function pick(layers: SceneLayer[], edit?: (state: SceneState) => void) {
  const state = SceneState.fromBundle(bundleOf(layers));
  edit?.(state);
  return activeCameraObject(bundleOf(layers), state);
}

const ORTHO_GENERAL = general(false);
/** 相机对象 (x, y, z)，可带 angles、zoom（`gen_d.py` 的 `camera_obj`）。 */
function cameraPose(origin: number[], angles: number[] = [0, 0, 0], zoom = 1): CameraPose {
  const result = pick([cameraLayer(0, origin, { angles, camera: { fov: 50, zoom } })]);
  return result!.pose;
}
function orthoFrame(origin: number[], options: { angles?: number[]; zoom?: number; shake?: [number, number] } = {}) {
  const zoom = orthographicCameraZoom(1, options.zoom ?? 1);
  return orthographicCameraObjectFrame({
    pose: cameraPose(origin, options.angles, options.zoom),
    shake: options.shake ?? [0, 0],
    zoom,
    general: ORTHO_GENERAL,
  });
}

describe("activeCameraObject：按 objects 倒序找第一个自身与父链都可见的（rea-p5-camera 4.2）", () => {
  it("两个都可见取下标大的（与 bundle 里的顺序无关）；没有相机对象为 null", () => {
    const a = cameraLayer(3, [0, 0, 8], { camera: { fov: 40, zoom: 1 } });
    const b = cameraLayer(5, [2, 0, 8], { camera: { fov: 60, zoom: 1 } });
    expect(pick([layer(0), a, b])?.object).toBe(5);
    expect(pick([b, a, layer(0)])?.object).toBe(5);
    expect(pick([layer(0)])).toBeNull();
  });

  it("自身不可见、父链不可见的跳过；都不可见为 null", () => {
    const a = cameraLayer(1, [0, 0, 8]);
    const b = cameraLayer(2, [2, 0, 8], { visible: false });
    expect(pick([a, b])?.object).toBe(1);
    const group = layer(0, { passes: [], size: [], visible: false });
    const child = cameraLayer(3, [0, 0, 0], { parent: 0 });
    expect(pick([a, group, child])?.object).toBe(1);
    expect(pick([cameraLayer(1, [0, 0, 0], { visible: false })])).toBeNull();
    // 运行中改可见性（属性 / 脚本写图层的 visible）：下一次选就换
    expect(
      pick([a, cameraLayer(2, [2, 0, 8])], (state) =>
        state.write({ property: "v", target: { kind: "layer", object: 2, field: "visible" } }, false),
      )?.object,
    ).toBe(1);
  });

  it("姿态取世界矩阵（含父链）：eye = 平移、center = eye − 第 2 列（看本地 −Z）、up = 第 1 列（带缩放）", () => {
    const parent = layer(0, { passes: [], size: [], origin: [100, 0, 0], scale: [2, 2, 2] });
    const child = cameraLayer(1, [10, 0, 0], { parent: 0 });
    const active = pick([parent, child])!;
    expect(active.pose.eye).toEqual([120, 0, 0]);
    expect(active.pose.center).toEqual([120, 0, -2]);
    expect(active.pose.up).toEqual([0, 2, 0]);
    // angles z 0.3：up 是本地 +Y 转过去的 (−sin, cos, 0)
    const tilted = pick([cameraLayer(0, [0, 0, 0], { angles: [0, 0, 0.3] })])!;
    expectClose(tilted.pose.up, [-Math.sin(0.3), Math.cos(0.3), 0], 6);
    expectClose(tilted.pose.center, [0, 0, -1], 6);
  });

  it("fov / zoom 读 SceneState.cameras（就地写之后的值）", () => {
    const active = pick([cameraLayer(0, [0, 0, 0], { camera: { fov: 40, zoom: 2 } })], (state) =>
      state.write({ property: "f", target: { kind: "camera", object: 0, field: "fov" } }, 70),
    )!;
    expect([active.fov, active.zoom, active.pose.zoom]).toEqual([70, 2, 2]);
  });
});

describe("正交场景的相机对象（步骤 0 `p5d-camo-*`、步骤 3 补测）", () => {
  it("p5d-camo-c（(960, 540, 500)）：VP 平移 (−2, −2)、深度 0.375，g_EyePosition (1920, 1080, 2000)", () => {
    const frame = orthoFrame([960, 540, 500]);
    expectClose([frame.viewProjection[12], frame.viewProjection[13], frame.viewProjection[14]], [-2, -2, 0.375], 6);
    expect(frame.eye).toEqual([1920, 1080, 2000]);
    expect(frame.vectors).toEqual({ forward: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0] });
    // 线性项与没有相机时相同（正交投影仍是 0..W）
    expectClose(frame.viewProjection.slice(0, 12), [...sceneViewProjection(ORTHO_GENERAL).slice(0, 12)], 9);
  });

  it("p5d-camo-o（(200, 100, 0)）：VP 平移 (−1.208, −1.185)", () => {
    const frame = orthoFrame([200, 100, 0]);
    expectClose([frame.viewProjection[12], frame.viewProjection[13]], [-1.208, -1.185], 3);
    expectClose([frame.viewProjection[12], frame.viewProjection[13]], [-400 / 1920 - 1, -200 / 1080 - 1], 6);
    expect(frame.eye).toEqual([1160, 640, 2000]);
  });

  it("p5d-camo-r（angles 0 0 0.3、zoom 2）：g_ViewRight = (cos 0.3, sin 0.3, 0)、线性项 ×2", () => {
    const frame = orthoFrame([0, 0, 0], { angles: [0, 0, 0.3], zoom: 2 });
    const [c, s] = [Math.cos(0.3), Math.sin(0.3)];
    expectClose(frame.vectors.right, [c, s, 0], 6);
    expectClose(frame.vectors.up, [-s, c, 0], 6);
    expect(frame.vectors.forward).toEqual([0, 0, -1]);
    const [x, y] = [2 / 1920, 2 / 1080];
    expectClose(
      [frame.viewProjection[0], frame.viewProjection[1], frame.viewProjection[4], frame.viewProjection[5]],
      [2 * x * c, -2 * y * s, 2 * x * s, 2 * y * c],
      8,
    );
    // 缩放绕场景中心（同 general.zoom，`S(zoom) · P`）：相机在原点时平移项也 ×2
    expectClose([frame.viewProjection[12], frame.viewProjection[13]], [-2, -2], 6);
  });

  it("总缩放 = general.zoom × camera.zoom（float32）", () => {
    expect(orthographicCameraZoom(1.5, 2)).toBe(3);
    expect(orthographicCameraZoom(1, 0.75)).toBe(0.75);
    expect(orthographicCameraZoom(0.1, 3)).toBe(Math.fround(Math.fround(0.1) * 3));
  });

  it("补测 -pp（(960, 540, 500)）：透视覆盖在相机 V 上做，PP 原点 (1440, 810) 投到 NDC (−0.5, −0.5)、w = d = 494.82", () => {
    const frame = orthoFrame([960, 540, 500]);
    const point = ndc(frame.perspectiveViewProjection, [1440, 810, 0]);
    expect(point.x).toBeCloseTo(-0.5, 4);
    expect(point.y).toBeCloseTo(-0.5, 4);
    expect(point.w).toBeCloseTo(494.82, 2);
    // 按「覆盖不看相机」会落在 (+0.5, +0.5)
    const plain = ndc(particleViewProjection(ORTHO_GENERAL), [1440, 810, 0]);
    expect([plain.x, plain.y].map((v) => +v.toFixed(4))).toEqual([0.5, 0.5]);
  });

  it("补测 -ppr（(200, 100, 0)、angles 0 0 0.3、zoom 2）：(650, 380) 投到 (−0.932, −1.502)、w = 247.41，保留旋转", () => {
    const frame = orthoFrame([200, 100, 0], { angles: [0, 0, 0.3], zoom: 2 });
    const point = ndc(frame.perspectiveViewProjection, [650, 380, 0]);
    expect(point.x).toBeCloseTo(-0.932, 3);
    expect(point.y).toBeCloseTo(-1.502, 3);
    expect(point.w).toBeCloseTo(247.41, 2);
    const m = frame.perspectiveViewProjection;
    expect(m[0]).toBeCloseTo(0.5154 * Math.cos(0.3), 4);
    expect(m[1]).toBeCloseTo(-0.9163 * Math.sin(0.3), 4);
  });

  it("补测 -par（(200, 100, 0)，amount 0.5、mouseinfluence 0、delay 0）：P = (1160, 640)，g_ParallaxPosition (0.60417, 0.59259)", () => {
    const frame = orthoFrame([200, 100, 0]);
    expect(frame.parallaxEye).toEqual([200, 100]);
    const fieldsOn = fields({
      cameraparallax: true,
      cameraparallaxamount: 0.5,
      cameraparallaxdelay: 0,
      cameraparallaxmouseinfluence: 0,
    });
    const next = advanceParallax(
      initialParallaxState(1920, 1080),
      parallaxInput(fieldsOn, {
        pointer: [0.1, 0.9],
        frametime: 1 / 60,
        width: 1920,
        height: 1080,
        eye: frame.parallaxEye,
      }),
    );
    expect(next.point).toEqual([1160, 640]);
    expect(next.position[0]).toBeCloseTo(0.60417, 5);
    expect(next.position[1]).toBeCloseTo(0.59259, 5);
  });

  it("补测 -shake（(200, 100, 0)，speed 1、amplitude 1、roughness 1）：g_EyePosition = eye + s + (W/2, H/2)，VP 平移 −(eye + s)", () => {
    const shakeFields = fields({
      camerashake: true,
      camerashakespeed: 1,
      camerashakeamplitude: 1,
      camerashakeroughness: 1,
    });
    const s = shakeOffset(shakeFields, 3.7, 1080);
    expect(s[0] !== 0 || s[1] !== 0).toBe(true);
    const frame = orthoFrame([200, 100, 0], { shake: s });
    const e: [number, number] = [Math.fround(200 + s[0]), Math.fround(100 + s[1])];
    expect(frame.eye).toEqual(eyePosition(ORTHO_GENERAL, e));
    expect(frame.parallaxEye).toEqual(e);
    expectClose(
      frame.viewProjection,
      [...multiply(sceneViewProjection(ORTHO_GENERAL), translation(-e[0], -e[1], 0))],
      6,
    );
  });

  it("p5d-camo-0（相机在原点、不转）：和没有相机时同一个 VP、眼位与透视覆盖", () => {
    const frame = orthoFrame([0, 0, 0]);
    expectClose(frame.viewProjection, [...sceneViewProjection(ORTHO_GENERAL)], 9);
    expectClose(frame.perspectiveViewProjection, [...particleViewProjection(ORTHO_GENERAL)], 5);
    expect(frame.eye).toEqual(eyePosition(ORTHO_GENERAL));
    expectClose(frame.view, [...lookAtRH([0, 0, 0], [0, 0, -1], [0, 1, 0])], 9);
  });
});

describe("透视场景的相机对象（步骤 0 `p5d-camp-1` / `-2`）：姿态与 fov 取相机的", () => {
  const CA = cameraLayer(5, [0, 0, 8], { camera: { fov: 40, zoom: 1 } });
  const CB = (visible: boolean) => cameraLayer(6, [2, 0, 8], { camera: { fov: 60, zoom: 1 }, visible });
  const frameOf = (layers: SceneLayer[]) => {
    const bundle = bundleOf(layers, true);
    const state = SceneState.fromBundle(bundle);
    const active = activeCameraObject(bundle, state)!;
    return perspectiveCamera({
      pose: active.pose,
      fov: active.fov,
      fields: state.general,
      time: 0,
      width: 1920,
      height: 1080,
    });
  };

  it("p5d-camp-2：JSON 里靠后的 CB 生效，eye (2, 0, 8)、m11 = cot 30°", () => {
    const frame = frameOf([CA, CB(true)]);
    expect(frame.eye).toEqual([2, 0, 8]);
    expect(frame.projection[5]).toBeCloseTo(1 / Math.tan(Math.PI / 6), 5);
    expect(frame.vectors.forward).toEqual([0, 0, -1]);
  });

  it("p5d-camp-1（CB visible: false）：CA 生效，eye (0, 0, 8)、fov 40；general.fov 不起作用", () => {
    const frame = frameOf([CA, CB(false)]);
    expect(frame.eye).toEqual([0, 0, 8]);
    expect(frame.projection[5]).toBeCloseTo(1 / Math.tan((20 * Math.PI) / 180), 5);
    // fov 照 general 的钳制规则
    const wide = perspectiveCamera({
      pose: { eye: [0, 0, 8], center: [0, 0, 7], up: [0, 1, 0], zoom: 1 },
      fov: 500,
      fields: fields({ fov: 30 }),
      time: 0,
      width: 1920,
      height: 1080,
    });
    expect(wide.projection[5]).toBeCloseTo(1 / Math.tan(((179.9 / 2) * Math.PI) / 180), 3);
  });
});

// ———— 假设备（同 p5d-camera.test.ts） ————

interface FakeBuffer {
  label: string;
  bytes: Uint8Array;
  writes: number;
  destroy(): void;
}

class FakeGpu {
  readonly buffers: FakeBuffer[] = [];
  readonly device: GPUDevice;

  constructor() {
    const pass = () => ({
      setViewport() {},
      setPipeline() {},
      setBindGroup() {},
      setVertexBuffer() {},
      setIndexBuffer() {},
      draw() {},
      drawIndexed() {},
      end() {},
    });
    this.device = {
      limits: { maxTextureDimension2D: 8192 },
      lost: new Promise(() => {}),
      destroy() {},
      createTexture: (descriptor: GPUTextureDescriptor) => ({
        label: descriptor.label ?? "",
        format: descriptor.format,
        createView: () => ({ label: descriptor.label ?? "" }),
        destroy() {},
      }),
      createSampler: () => ({}),
      createBuffer: (descriptor: GPUBufferDescriptor) => {
        const buffer: FakeBuffer = {
          label: descriptor.label ?? "",
          bytes: new Uint8Array(descriptor.size),
          writes: 0,
          destroy() {},
        };
        this.buffers.push(buffer);
        return buffer;
      },
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createRenderPipelineAsync: async (descriptor: GPURenderPipelineDescriptor) => ({ label: descriptor.label }),
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginRenderPass: () => pass(),
        copyTextureToTexture() {},
        copyTextureToBuffer() {},
        finish: () => ({}),
      }),
      queue: {
        writeBuffer: (buffer: FakeBuffer, offset: number, data: ArrayBuffer, dataOffset = 0, size?: number) => {
          buffer.bytes.set(new Uint8Array(data, dataOffset, size ?? data.byteLength - dataOffset), offset);
          buffer.writes++;
        },
        writeTexture() {},
        submit() {},
        onSubmittedWorkDone: async () => {},
      },
      pushErrorScope() {},
      popErrorScope: async () => null,
    } as unknown as GPUDevice;
  }
}

interface DrawView {
  object: number;
  step: { kind: string; role?: string };
  uniformBuffer: FakeBuffer | null;
}
const drawsOf = (scene: GpuScene): DrawView[] => [...(scene as unknown as { draws: Set<DrawView> }).draws];
const drawOf = (scene: GpuScene, object: number) => drawsOf(scene).find((item) => item.object === object)!;
const floats = (draw: DrawView, offset: number, count: number) =>
  Array.from(new Float32Array(draw.uniformBuffer!.bytes.buffer.slice(offset, offset + count * 4)));
const f32s = (values: readonly number[]) => values.map((value) => Math.fround(value));
/** 三个 vec3（std140 每个占 16 字节）。 */
const vec3s = (draw: DrawView, offset: number, count: number) =>
  Array.from({ length: count }, (_, i) => floats(draw, offset + 16 * i, 3)).flat();

async function open(bundle: SceneBundle, size?: [number, number]) {
  const gpu = new FakeGpu();
  const state = SceneState.fromBundle(bundle);
  const scene = await GpuScene.build(gpu.device, bundle, state, new Set(), [], {
    ignoreUnsupported: true,
    particles: { seed: 1 },
    size,
  });
  return { gpu, state, scene };
}

const FRAME: FrameInput = {
  time: 1,
  frametime: 0.05,
  daytime: 0.5,
  pointer: [0.5, 0.5],
  pointerLast: [0.5, 0.5],
  cursor: [0.5, 0.5],
};

/** 渲染器的一帧相机（`sceneCameraFrame`，正交）。 */
const orthoCamera = (bundle: SceneBundle, state: SceneState, time: number) =>
  sceneCameraFrame({
    cameraLayers: cameraObjectLayers(bundle),
    state,
    general: bundle.general,
    time,
    perspective: null,
  });

/** 交相机、视差关、刷 uniform（同渲染器一帧的后半段）。 */
function drawWith(scene: GpuScene, state: SceneState, camera: SceneCamera) {
  scene.setCamera(camera);
  scene.setParallax(null, state);
  scene.sync(state);
  scene.update(FRAME, state);
}

const SHAKE = { camerashake: true, camerashakespeed: 1, camerashakeamplitude: 1, camerashakeroughness: 1 };
const bytesOf = (scene: GpuScene, object: number) => Array.from(drawOf(scene, object).uniformBuffer!.bytes);

describe("GpuScene：正交场景的相机对象（P5d 步骤 3 点 4）", () => {
  const plain = () => [layer(0), layer(1, { origin: [1440, 810, 0], perspective: true, angles: [-1, 0, 0] })];

  it("没有可见的相机对象：uniform 字节与没有相机对象的场景相同，交给场景的就是 P5a 那一份 { shake, zoom }", async () => {
    const without = bundleOf(plain(), false, SHAKE);
    const hidden = bundleOf([...plain(), cameraLayer(2, [960, 540, 500], { visible: false })], false, SHAKE);
    const a = await open(without);
    const b = await open(hidden);
    for (const time of [0, 1.3, 3.7]) {
      const camera = orthoCamera(hidden, b.state, time);
      const s = shakeOffset(b.state.general, time, 1080);
      expect(camera.camera).toEqual({ shake: s, zoom: 1 });
      expect(camera.eye).toEqual(s);
      drawWith(a.scene, a.state, orthoCamera(without, a.state, time).camera);
      drawWith(b.scene, b.state, camera.camera);
      for (const object of [0, 1])
        expect(bytesOf(b.scene, object), `${time} ${object}`).toEqual(bytesOf(a.scene, object));
    }
  });

  it("可见的相机对象：VP = 正交 · V、透视覆盖在相机 V 上、g_EyePosition 加相机 eye、视图向量取 V，进全部 draw", async () => {
    const bundle = bundleOf([
      ...plain(),
      cameraLayer(2, [200, 100, 0], { angles: [0, 0, 0.3], camera: { fov: 50, zoom: 2 } }),
    ]);
    const { scene, state } = await open(bundle);
    const camera = orthoCamera(bundle, state, 0).camera as OrthographicSceneCamera;
    const frame = camera.cameraObject!;
    expect(frame).toBeDefined();
    expect(camera.zoom).toBe(2);
    drawWith(scene, state, camera);
    const image = drawOf(scene, 0);
    expect(floats(image, 64, 16)).toEqual(Array.from(frame.viewProjection));
    expect(floats(image, 128, 3)).toEqual(f32s(frame.eye));
    expect(vec3s(image, 144, 3)).toEqual([...frame.vectors.forward, ...frame.vectors.right, ...frame.vectors.up]);
    // 普通图像层 MVP = VP · W
    expectClose(floats(image, 0, 16), [...multiply(frame.viewProjection, translation(960, 540, 0))], 6);
    // perspective: true 的图像层用透视覆盖（补测 -pp / -ppr：相机 V 的旋转保留、平移换成 (t − 中心, −d)）
    const persp = drawOf(scene, 1);
    const world = worldMatrixOf(1, state.layers, new Map());
    expectClose(floats(persp, 0, 16), [...multiply(frame.perspectiveViewProjection, world)], 5);
    // 同一帧再交一次：不重写
    const writes = drawsOf(scene).map((item) => item.uniformBuffer?.writes ?? 0);
    drawWith(scene, state, orthoCamera(bundle, state, 0).camera);
    expect(drawsOf(scene).map((item) => item.uniformBuffer?.writes ?? 0)).toEqual(writes);
  });

  it("绑属性切换可见性：下一帧换相机；都隐藏后回到没有相机对象的字节（视图向量回到常量），再显示又换回来", async () => {
    const cameras = [cameraLayer(1, [200, 100, 0], { angles: [0, 0, 0.3] }), cameraLayer(2, [960, 540, 500])];
    const bundle = bundleOf([layer(0), ...cameras], false, SHAKE);
    const { scene, state } = await open(bundle);
    const show = (object: number, visible: boolean) =>
      state.write({ property: `show${object}`, target: { kind: "layer", object, field: "visible" } }, visible);
    const vp = () => floats(drawOf(scene, 0), 64, 16);
    const s = shakeOffset(state.general, 1, 1080);
    expect(s[0] !== 0 || s[1] !== 0).toBe(true);

    // 两个都可见：下标大的 B（960, 540, 500）生效，VP 平移 −(eye + s)
    drawWith(scene, state, orthoCamera(bundle, state, 1).camera);
    expectClose(vp().slice(12, 14), [(2 * (-960 - s[0])) / 1920 - 1, (2 * (-540 - s[1])) / 1080 - 1], 5);
    // 隐藏 B：下一帧换 A（带旋转）
    show(2, false);
    expect(activeCameraObject(bundle, state)!.object).toBe(1);
    const next = orthoCamera(bundle, state, 1).camera as OrthographicSceneCamera;
    drawWith(scene, state, next);
    expect(vp()).toEqual(Array.from(next.cameraObject!.viewProjection));
    expect(floats(drawOf(scene, 0), 160, 3)).toEqual(next.cameraObject!.vectors.right);
    expect(next.cameraObject!.vectors.right[1]).toBeCloseTo(Math.sin(0.3), 6);
    // 都隐藏：回到没有相机对象的字节，视图向量回到常量
    show(1, false);
    expect(activeCameraObject(bundle, state)).toBeNull();
    drawWith(scene, state, orthoCamera(bundle, state, 1).camera);
    const referenceBundle = bundleOf([layer(0)], false, SHAKE);
    const reference = await open(referenceBundle);
    drawWith(reference.scene, reference.state, orthoCamera(referenceBundle, reference.state, 1).camera);
    expect(bytesOf(scene, 0)).toEqual(bytesOf(reference.scene, 0));
    expect(vec3s(drawOf(scene, 0), 144, 3)).toEqual([0, 0, -1, 1, 0, 0, 0, 1, 0]);
    // 再显示 B：换回来，g_EyePosition 加相机的 eye.xy + s
    show(2, true);
    drawWith(scene, state, orthoCamera(bundle, state, 1).camera);
    expect(activeCameraObject(bundle, state)!.object).toBe(2);
    expectClose(floats(drawOf(scene, 0), 128, 3), [1920 + s[0], 1080 + s[1], 2000], 3);
  });

  it("没有抖动、缩放不变时离开相机对象：s 与 zoom 和上一次没有相机时相同，也要整套重算（不能提前返回）", async () => {
    const bundle = bundleOf([layer(0), cameraLayer(1, [200, 100, 0])]);
    const { scene, state } = await open(bundle);
    const reference = await open(bundleOf([layer(0)]));
    const hide = (visible: boolean) =>
      state.write({ property: "show", target: { kind: "layer", object: 1, field: "visible" } }, visible);
    // 先没有相机（交的和建场景时相同），再显示、再隐藏
    hide(false);
    drawWith(scene, state, orthoCamera(bundle, state, 0).camera);
    hide(true);
    drawWith(scene, state, orthoCamera(bundle, state, 0).camera);
    expectClose(floats(drawOf(scene, 0), 64, 16).slice(12, 14), [-400 / 1920 - 1, -200 / 1080 - 1], 6);
    hide(false);
    drawWith(scene, state, orthoCamera(bundle, state, 0).camera);
    drawWith(reference.scene, reference.state, { shake: [0, 0], zoom: 1 });
    expect(bytesOf(scene, 0)).toEqual(bytesOf(reference.scene, 0));
  });
});

// ———— 渲染器 ————

const PATH: CameraPath[] = [
  {
    duration: 4,
    keys: [
      { t: 0, eye: [0, 0, 10], center: [0, 0, 0], up: [0, 1, 0], zoom: 1 },
      { t: 2, eye: [4, 0, 10], center: [4, 0, 0], up: [0, 1, 0], zoom: 1 },
    ],
  },
];
const PATH_CAMERA: SceneCameraJson = { eye: [0, 0, 10], center: [0, 0, 0], up: [0, 1, 0], paths: PATH };

describe("渲染器：每帧选相机对象（P5d 步骤 3 点 4）", () => {
  async function start() {
    const frames: FrameRequestCallback[] = [];
    const gpu = new FakeGpu();
    vi.mocked(acquireGpu).mockResolvedValue({
      device: gpu.device,
      features: new Set(),
      info: { vendor: "", architecture: "", description: "", features: [] },
    } as unknown as Awaited<ReturnType<typeof acquireGpu>>);
    vi.stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    vi.stubGlobal("navigator", { gpu: { getPreferredCanvasFormat: () => "bgra8unorm" } });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const context = {
      configure() {},
      unconfigure() {},
      getCurrentTexture: () => ({ createView: () => ({ label: "canvas" }) }),
    };
    const canvas = {
      width: 160,
      height: 90,
      getContext: () => context,
      getBoundingClientRect: () => ({ width: 160, height: 90 }),
    } as unknown as HTMLCanvasElement;
    const renderer: SceneRenderer = await SceneRenderer.create(canvas, { maxFps: 0 });
    return { renderer, frames };
  }
  const internals = (renderer: SceneRenderer) =>
    renderer as unknown as { cameraPath: CameraPathState; parallax: ParallaxState };

  it("正交：交给场景的是相机对象的帧（总缩放 general.zoom × camera.zoom）；视差点的 eye.xy 是相机的（补测 -par）", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { renderer, frames } = await start();
    const bundle = bundleOf([layer(0), cameraLayer(1, [200, 100, 0], { camera: { fov: 50, zoom: 2 } })], false, {
      zoom: 1.5,
      cameraparallax: true,
      cameraparallaxamount: 0.5,
      cameraparallaxdelay: 0,
      cameraparallaxmouseinfluence: 0,
    });
    await renderer.load(bundle);
    const setCamera = vi.spyOn(renderer.currentScene!, "setCamera");
    now += 16;
    frames.at(-1)!(now);
    const last = setCamera.mock.lastCall![0] as OrthographicSceneCamera;
    expect(last.kind).toBeUndefined();
    const frame = last.cameraObject!;
    expect(last.zoom).toBe(3);
    const pose = activeCameraObject(bundle, renderer.sceneState!)!.pose;
    expect(frame).toEqual(orthographicCameraObjectFrame({ pose, shake: [0, 0], zoom: 3, general: bundle.general }));
    expect(internals(renderer).parallax.point).toEqual([1160, 640]);
    // 相机对象被隐藏：下一帧回到 P5a 那一份
    renderer.sceneState!.write({ property: "v", target: { kind: "layer", object: 1, field: "visible" } }, false);
    now += 16;
    frames.at(-1)!(now);
    expect(setCamera.mock.lastCall![0]).toEqual({ shake: [0, 0], zoom: 1.5 });
    expect(internals(renderer).parallax.point).toEqual([960, 540]);
    renderer.destroy();
  });

  it("透视：有可见的相机对象时姿态与 fov 取它的、路径不推进；隐藏后路径从停住的地方接着推", async () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const { renderer, frames } = await start();
    const bundle = bundleOf(
      [layer(0), cameraLayer(1, [2, 0, 8], { camera: { fov: 60, zoom: 1 } })],
      true,
      {},
      PATH_CAMERA,
    );
    await renderer.load(bundle);
    const setCamera = vi.spyOn(renderer.currentScene!, "setCamera");
    for (let i = 0; i < 4; i++) {
      now += 250;
      frames.at(-1)!(now);
    }
    expect(internals(renderer).cameraPath).toEqual(initialCameraPathState());
    const last = setCamera.mock.lastCall![0];
    expect(last.kind).toBe("perspective");
    if (last.kind === "perspective") {
      expect(last.frame.eye).toEqual([2, 0, 8]);
      expect(last.frame.projection[5]).toBeCloseTo(1 / Math.tan(Math.PI / 6), 5);
    }
    renderer.sceneState!.write({ property: "v", target: { kind: "layer", object: 1, field: "visible" } }, false);
    now += 250;
    frames.at(-1)!(now);
    const after = setCamera.mock.lastCall![0];
    if (after.kind === "perspective") expect(after.frame.eye).toEqual([0, 0, 10]);
    expect(internals(renderer).cameraPath).toEqual(replayCameraPath(PATH, [0.25]));
    renderer.destroy();
  });
});

// ———— dev 探针 ————

describe("dev 探针的相机对象（P5d 步骤 3 点 4）", () => {
  it("probeCameraObjects：没有相机对象为 undefined；frameCamera 正交交相机对象的帧、eyes 记相机的 eye.xy + s", () => {
    expect(probeCameraObjects(bundleOf([layer(0)]))).toBeUndefined();
    const bundle = bundleOf([layer(0), cameraLayer(1, [200, 100, 0])], false, SHAKE);
    const objects = probeCameraObjects(bundle)!;
    expect(objects.layers.map((item) => item.object)).toEqual([1]);
    const calls: SceneCamera[] = [];
    const scene = { setCamera: (camera: SceneCamera) => void calls.push(camera) };
    const state = SceneState.fromBundle(bundle);
    const cameras = frameCamera(scene, state, 1080, undefined, undefined, objects);
    const eye = cameras.apply(2.5);
    const s = shakeOffset(state.general, 2.5, 1080);
    expect(eye).toEqual([Math.fround(200 + s[0]), Math.fround(100 + s[1])]);
    expect(calls[0]).toEqual(orthoCamera(bundle, state, 2.5).camera);
    // 回放时按状态里的可见性选：隐藏后同 P5a
    state.write({ property: "v", target: { kind: "layer", object: 1, field: "visible" } }, false);
    expect(cameras.apply(2.5)).toEqual(s);
    expect(calls[1]).toEqual({ shake: s, zoom: 1 });
  });

  it("frameCamera 透视：有相机对象时路径不推进、姿态取相机的", () => {
    const bundle = bundleOf([layer(0), cameraLayer(1, [2, 0, 8])], true, {}, PATH_CAMERA);
    const state = SceneState.fromBundle(bundle);
    const calls: SceneCamera[] = [];
    const scene = { setCamera: (camera: SceneCamera) => void calls.push(camera) };
    const cameras = frameCamera(
      scene,
      state,
      0,
      probePerspective(bundle, [1920, 1080]),
      [0.5, 0.5],
      probeCameraObjects(bundle),
    );
    cameras.apply(0);
    cameras.apply(0.5);
    expect(cameras.path).toEqual(initialCameraPathState());
    const camera = calls[1];
    if (camera.kind === "perspective") expect(camera.frame.eye).toEqual([2, 0, 8]);
    expect(cameras.eyes[1]).toEqual([2, 0]);
  });
});
