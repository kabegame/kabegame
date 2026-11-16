/**
 * P5e：相机基准进运行时状态，`thisScene.getCameraTransforms` / `setCameraTransforms`
 * （`.claude/plans/wpe-import/3-scene/phase5/phase-5e-camera-transforms.md`）。
 * - `SceneState.cameraBase`：加载完成值、`init` 之前的构造缺省值、`init` 之后按加载规则收尾（正交重置、透视按 `given`、zoom 留下）；
 * - `sceneCameraFrame`：正交没有相机对象时基准是重置值走原快路径（结果不变），改过走 `orthographicCameraObjectFrame`；有相机对象时基准不参与；
 *   透视无路径时取状态、有路径时基准不参与；
 * - 脚本 API：get 的形状、set 的返回值与各种非法项、顶层调用抛 SyntaxError、同帧读回；
 * - 重编译：update 阶段的写入随 `replayWrites` 恢复，`init` 里被覆盖的 eye 不复活、`init` 里的 zoom 复活。
 */
import { describe, expect, it } from "vitest";
import { generalDefaults } from "../compile/bindings";
import type { SceneBundle, SceneLayer } from "../compile/bundle";
import type { CameraPath, SceneCameraJson } from "../compile/camera";
import { ScriptApi, type ScriptApiState } from "../script/api";
import { ScriptRuntime, targetKey, type ScriptRealm, type ScriptTarget } from "../script/runtime";
import { fakeModule } from "../script/testing/fakeModule";
import type { ScriptModule } from "../script/moduleFactory";
import {
  cameraObjectLayers,
  initialCameraPathState,
  orthographicCameraObjectFrame,
  orthographicCameraZoom,
  perspectiveCamera,
  sceneCameraFrame,
  type CameraPose,
} from "./camera";
import { eyePosition } from "./layout";
import { SceneState, scriptWriteValue } from "./state";
import { frameCamera, probeCameraObjects } from "../dev/particleCorners";

const f = Math.fround;

// ———— 手写 bundle ————

function cameraLayer(object: number): SceneLayer {
  return {
    id: object + 10,
    object,
    parent: null,
    name: `C${object}`,
    origin: [0, 0, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [100, 100],
    alpha: 1,
    color: [1, 1, 1],
    brightness: 1,
    visible: true,
    parallaxDepth: [1, 1],
    passthroughModel: false,
    effects: [],
    passes: [],
    camera: { fov: 50, zoom: 2 },
    puppet: null,
  } as unknown as SceneLayer;
}

function bundleOf(options: { camera?: SceneCameraJson | null; perspective?: boolean; cameraObject?: boolean } = {}) {
  return {
    general: {
      width: 1920,
      height: 1080,
      fields: generalDefaults(),
      clearVariable: false,
      perspectiveOverrideFov: (95 * Math.PI) / 180,
      ...(options.perspective ? { perspective: true } : {}),
      ...(options.camera !== undefined ? { camera: options.camera } : {}),
      postprocess: { level: "enabled", bloomFlag: true, hdrFlag: false, bloom: true, hdr: false },
      bloom: {
        strength: 1,
        threshold: 0.5,
        tint: [1, 1, 1],
        hdrStrength: 1,
        hdrThreshold: 0.5,
        hdrFeather: 1,
        hdrScatter: 1,
        hdrIterations: 4,
      },
    },
    layers: options.cameraObject ? [cameraLayer(0)] : [],
    programs: [],
    textures: [],
    bindings: [],
    scripts: { list: [] },
  } as unknown as SceneBundle;
}

const PERSPECTIVE_JSON: SceneCameraJson = {
  eye: [6, 4, 10],
  center: [1, 2, 3],
  up: [0, 0, 1],
  given: { eye: true, center: true, up: true },
  paths: [],
};

const GENERAL = { width: 1920, height: 1080, perspectiveOverrideFov: 1.6 };

/** 直接把基准写进状态（经脚本写回同一条路径）。 */
function writeBase(state: SceneState, field: "eye" | "center" | "up" | "zoom", values: number[]): void {
  state.write({ property: "", target: { kind: "camera-base", field } }, scriptWriteValue(values));
}

// ———— SceneState ————

describe("SceneState.cameraBase：加载完成值、init 前后", () => {
  it("正交：加载完成值是重置值 (0,0,0) / (0,0,−1) / (0,1,0)、zoom 1", () => {
    const state = SceneState.fromBundle(bundleOf());
    expect(state.cameraBase).toEqual({ eye: [0, 0, 0], center: [0, 0, -1], up: [0, 1, 0], zoom: 1 });
  });

  it("beginScriptInit 换成构造缺省值；init 写、收尾：正交 eye / center / up 全部重置、zoom 留下、返回被覆盖的字段", () => {
    const state = SceneState.fromBundle(bundleOf());
    state.beginScriptInit();
    expect(state.cameraBase).toEqual({ eye: [2, 2, 2], center: [0, 0, 0], up: [0, 1, 0], zoom: 1 });
    writeBase(state, "eye", [7, 8, 9]);
    writeBase(state, "center", [1, 1, 1]);
    writeBase(state, "up", [0, 0, 1]);
    writeBase(state, "zoom", [1.5]);
    expect(state.finishScriptInit()).toEqual(["eye", "center", "up"]);
    expect(state.cameraBase).toEqual({ eye: [0, 0, 0], center: [0, 0, -1], up: [0, 1, 0], zoom: 1.5 });
  });

  it("透视：加载完成值取 JSON；收尾只有 given 为真的项覆盖 init 写的值，别的保留 init 写的", () => {
    const camera: SceneCameraJson = { ...PERSPECTIVE_JSON, given: { eye: true, center: false, up: false } };
    const state = SceneState.fromBundle(bundleOf({ perspective: true, camera }));
    expect(state.cameraBase).toEqual({ eye: [6, 4, 10], center: [1, 2, 3], up: [0, 0, 1], zoom: 1 });
    state.beginScriptInit();
    expect(state.cameraBase.eye).toEqual([2, 2, 2]);
    writeBase(state, "eye", [100, 0, 0]);
    writeBase(state, "center", [5, 5, 5]);
    writeBase(state, "up", [0, 1, 0]);
    writeBase(state, "zoom", [3]);
    expect(state.finishScriptInit()).toEqual(["eye"]);
    expect(state.cameraBase).toEqual({ eye: [6, 4, 10], center: [5, 5, 5], up: [0, 1, 0], zoom: 3 });
  });

  it("透视：手写的 bundle 没有 given 时当全部给了", () => {
    const { given: _given, ...camera } = PERSPECTIVE_JSON;
    const state = SceneState.fromBundle(bundleOf({ perspective: true, camera }));
    state.beginScriptInit();
    writeBase(state, "up", [9, 9, 9]);
    expect(state.finishScriptInit()).toEqual(["eye", "center", "up"]);
    expect(state.cameraBase.up).toEqual([0, 0, 1]);
  });

  it("write 只改给出的字段，值按 float32 存、不触发重编译", () => {
    const state = SceneState.fromBundle(bundleOf());
    const result = state.write(
      { property: "", target: { kind: "camera-base", field: "eye" } },
      scriptWriteValue([0.1, 2, 3]),
    );
    expect(result).toBe("applied");
    expect(state.cameraBase.eye).toEqual([f(0.1), 2, 3]);
    expect(state.cameraBase.center).toEqual([0, 0, -1]);
    writeBase(state, "zoom", [0.1]);
    expect(state.cameraBase.zoom).toBe(f(0.1));
  });
});

// ———— sceneCameraFrame ————

describe("sceneCameraFrame：正交", () => {
  const input = (state: SceneState, cameraLayers: SceneCameraLayers = []) => ({
    cameraLayers,
    state,
    general: GENERAL,
    time: 1.5,
    perspective: null,
  });
  type SceneCameraLayers = ReturnType<typeof cameraObjectLayers>;

  it("基准是重置值、zoom 1：快路径原样返回，同没有 cameraBase 的旧输入逐项相同", () => {
    const state = SceneState.fromBundle(bundleOf());
    const now = sceneCameraFrame(input(state));
    const legacy = { layers: state.layers, cameras: state.cameras, general: state.general };
    const old = sceneCameraFrame(input(legacy as unknown as SceneState));
    expect(now).toEqual(old);
    expect(now.camera).toEqual({ shake: [0, 0], zoom: state.general.zoom });
    expect(now.camera).not.toHaveProperty("cameraObject");
    expect(now.eye).toEqual([0, 0]);
    expect(now.path).toBeNull();
  });

  it("改了 eye 之后走 orthographicCameraObjectFrame：g_EyePosition = eye.xy + (W/2, H/2)、视差中心 = eye.xy、视图平移 −eye", () => {
    const state = SceneState.fromBundle(bundleOf());
    writeBase(state, "eye", [100, 50, 0]);
    writeBase(state, "center", [100, 50, -1]);
    const result = sceneCameraFrame(input(state));
    const frame = (result.camera as { cameraObject: ReturnType<typeof orthographicCameraObjectFrame> }).cameraObject;
    expect(frame.eye).toEqual(eyePosition(GENERAL, [100, 50]));
    expect(frame.eye).toEqual([1060, 590, 2000]);
    expect(frame.parallaxEye).toEqual([100, 50]);
    expect(result.eye).toEqual([100, 50]);
    expect(frame.view[12]).toBe(-100);
    expect(frame.view[13]).toBe(-50);
    expect(result.camera).toMatchObject({ zoom: orthographicCameraZoom(state.general.zoom, 1) });
    expect(frame).toEqual(
      orthographicCameraObjectFrame({
        pose: state.cameraBase,
        shake: [0, 0],
        zoom: orthographicCameraZoom(state.general.zoom, 1),
        general: GENERAL,
      }),
    );
    expect(result.path).toBeNull();
  });

  it("基准 zoom 2：总缩放 = general.zoom × 2；只改 zoom（eye 仍是重置值）也不走快路径", () => {
    const state = SceneState.fromBundle(bundleOf());
    state.general = { ...state.general, zoom: 1.25 };
    writeBase(state, "zoom", [2]);
    const result = sceneCameraFrame(input(state));
    expect(result.camera).toMatchObject({ zoom: f(2.5) });
    expect(result.camera).toHaveProperty("cameraObject");
    expect(result.eye).toEqual([0, 0]);
  });

  it("有可见相机对象时基准不参与（含 zoom）", () => {
    const bundle = bundleOf({ cameraObject: true });
    const state = SceneState.fromBundle(bundle);
    state.general = { ...state.general, zoom: 1.25 };
    writeBase(state, "eye", [500, 0, 0]);
    writeBase(state, "zoom", [3]);
    const result = sceneCameraFrame(input(state, cameraObjectLayers(bundle)));
    const frame = (result.camera as { cameraObject: ReturnType<typeof orthographicCameraObjectFrame> }).cameraObject;
    // 相机对象在原点、zoom 2：eye (0,0)、总缩放 1.25 × 2
    expect(frame.eye).toEqual([960, 540, 2000]);
    expect(result.camera).toMatchObject({ zoom: f(2.5) });
    expect(result.eye).toEqual([0, 0]);
  });
});

describe("sceneCameraFrame：透视", () => {
  const paths: CameraPath[] = [
    {
      duration: 4,
      keys: [
        { t: 0, eye: [1, 1, 1], center: [0, 0, 0], up: [0, 1, 0], zoom: 1 },
        { t: 2, eye: [3, 3, 3], center: [0, 0, 0], up: [0, 1, 0], zoom: 1 },
      ],
    },
  ];
  const run = (camera: SceneCameraJson, base: CameraPose | undefined) => {
    const state = SceneState.fromBundle(bundleOf({ perspective: true, camera }));
    if (base) state.cameraBase = base;
    return sceneCameraFrame({
      cameraLayers: [],
      state,
      general: GENERAL,
      time: 0.5,
      perspective: { camera, path: initialCameraPathState(), dt: 0.1, width: 1920, height: 1080 },
    });
  };

  it("无路径：基准取状态（脚本写过的）", () => {
    const base: CameraPose = { eye: [10, 20, 30], center: [1, 2, 3], up: [0, 1, 0], zoom: 1 };
    const result = run(PERSPECTIVE_JSON, base);
    const state = SceneState.fromBundle(bundleOf({ perspective: true, camera: PERSPECTIVE_JSON }));
    const expected = perspectiveCamera({ pose: base, fields: state.general, time: 0.5, width: 1920, height: 1080 });
    expect(result.camera).toEqual({ kind: "perspective", frame: expected });
    // 和编译期的基准不同
    expect(result.camera).not.toEqual(run(PERSPECTIVE_JSON, undefined).camera);
  });

  it("有路径：基准不参与", () => {
    const camera = { ...PERSPECTIVE_JSON, paths };
    const a = run(camera, { eye: [10, 20, 30], center: [1, 2, 3], up: [0, 1, 0], zoom: 1 });
    const b = run(camera, { eye: [-5, 0, 7], center: [9, 9, 9], up: [1, 0, 0], zoom: 4 });
    expect(a).toEqual(b);
    expect(a.path).not.toEqual(initialCameraPathState());
  });
});

// ———— 脚本 API ————

class Vec {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
    public w = 0,
  ) {}
}
class FakeRealm implements ScriptRealm {
  global: Record<string, unknown> = { Object, Array, JSON, Float32Array };
  prototypes = { Vec2: Vec.prototype, Vec3: Vec.prototype, Vec4: Vec.prototype, Mat3: {}, Mat4: {} };
  internal = { updateScriptProperties() {}, convertUserProperties: () => ({}) };
  async prepareModule(): Promise<ScriptModule> {
    return fakeModule({});
  }
  dispose() {}
}

function apiOf(bundle: SceneBundle = bundleOf()) {
  const state = SceneState.fromBundle(bundle);
  const writes: { target: ScriptTarget; value: unknown }[] = [];
  const access: ScriptApiState = {
    bundle: () => bundle,
    state: () => state,
    screenResolution: () => [800, 600],
    frametime: () => 0.016,
    runtime: () => 0,
    timeOfDay: () => 0,
    write(target, value) {
      writes.push({ target, value });
      if (target.kind === "unsupported" || target.kind === "script-property" || target.kind === "recompile")
        return false;
      state.write({ property: "", target }, scriptWriteValue(value as number[]));
      return true;
    },
    warn: () => {},
  };
  const api = new ScriptApi(new FakeRealm(), access);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scene = api.thisScene as Record<string, any>;
  return { api, scene, state, writes };
}

describe("thisScene.getCameraTransforms", () => {
  it("每次返回新的普通对象，键序 eye、center、up、zoom；前三个是新的 Vec3、zoom 是 number", () => {
    const h = apiOf();
    const a = h.scene.getCameraTransforms();
    expect(Object.getPrototypeOf(a)).toBe(Object.prototype);
    expect(Object.keys(a)).toEqual(["eye", "center", "up", "zoom"]);
    for (const key of ["eye", "center", "up"]) expect(a[key]).toBeInstanceOf(Vec);
    expect(typeof a.zoom).toBe("number");
    expect([a.eye.x, a.eye.y, a.eye.z]).toEqual([0, 0, 0]);
    expect([a.center.x, a.center.y, a.center.z]).toEqual([0, 0, -1]);
    expect([a.up.x, a.up.y, a.up.z]).toEqual([0, 1, 0]);
    expect(a.zoom).toBe(1);
    const b = h.scene.getCameraTransforms();
    expect(b).not.toBe(a);
    expect(b.eye).not.toBe(a.eye);
  });

  it("改返回的对象不影响基准", () => {
    const h = apiOf();
    const a = h.scene.getCameraTransforms();
    a.eye.x = 99;
    a.zoom = 7;
    a.center = null;
    const b = h.scene.getCameraTransforms();
    expect(b.eye.x).toBe(0);
    expect(b.zoom).toBe(1);
    expect(b.center.z).toBe(-1);
    expect(h.state.cameraBase.eye).toEqual([0, 0, 0]);
  });

  it("模块顶层调用抛 SyntaxError，消息是方法自己的名字", () => {
    const h = apiOf();
    h.api.setModuleEvaluating(true);
    for (const name of ["getCameraTransforms", "setCameraTransforms"]) {
      expect(() => h.scene[name]({}), name).toThrow(new SyntaxError(`${name} cannot be called from global scope.`));
      expect(() => h.scene[name]({}), name).toThrow(SyntaxError);
    }
    h.api.setModuleEvaluating(false);
    expect(() => h.scene.getCameraTransforms()).not.toThrow();
  });
});

describe("thisScene.setCameraTransforms", () => {
  it("没有参数、参数不是对象（null、数字、字符串、布尔）返回 false，什么都不改", () => {
    const h = apiOf();
    expect(h.scene.setCameraTransforms()).toBe(false);
    for (const bad of [null, undefined, 5, "x", true])
      expect(h.scene.setCameraTransforms(bad), String(bad)).toBe(false);
    expect(h.writes).toEqual([]);
    expect(h.state.cameraBase).toEqual({ eye: [0, 0, 0], center: [0, 0, -1], up: [0, 1, 0], zoom: 1 });
  });

  it("set({}) 返回 true、什么都不改；非法项各自跳过", () => {
    const h = apiOf();
    expect(h.scene.setCameraTransforms({})).toBe(true);
    expect(h.writes).toEqual([]);
    expect(h.scene.setCameraTransforms({ zoom: "3", eye: 5, center: "a", up: null })).toBe(true);
    expect(h.writes).toEqual([]);
    expect(h.state.cameraBase).toEqual({ eye: [0, 0, 0], center: [0, 0, -1], up: [0, 1, 0], zoom: 1 });
  });

  it("向量项：是 number 的取 float32、不是 number 的记 0；缺分量记 0", () => {
    const h = apiOf();
    expect(h.scene.setCameraTransforms({ eye: { x: 7 } })).toBe(true);
    expect(h.state.cameraBase.eye).toEqual([7, 0, 0]);
    h.scene.setCameraTransforms({ center: { x: "1", y: true, z: -1 } });
    expect(h.state.cameraBase.center).toEqual([0, 0, -1]);
    h.scene.setCameraTransforms({ up: { x: 0.1, y: 0.2, z: 0.3 } });
    expect(h.state.cameraBase.up).toEqual([f(0.1), f(0.2), f(0.3)]);
    // 数组、函数也算对象
    h.scene.setCameraTransforms({ eye: [1, 2, 3] });
    expect(h.state.cameraBase.eye).toEqual([0, 0, 0]);
    h.scene.setCameraTransforms({ eye: Object.assign(() => 0, { x: 3 }) });
    expect(h.state.cameraBase.eye).toEqual([3, 0, 0]);
  });

  it("zoom 是 number 才取（float32）；NaN / Infinity 照写；只给一项时别的项不变", () => {
    const h = apiOf();
    h.scene.setCameraTransforms({ zoom: 0.1 });
    expect(h.state.cameraBase.zoom).toBe(f(0.1));
    expect(h.state.cameraBase.eye).toEqual([0, 0, 0]);
    h.scene.setCameraTransforms({ zoom: Number.POSITIVE_INFINITY, eye: { x: Number.NaN, y: 1e40, z: -Infinity } });
    expect(h.state.cameraBase.zoom).toBe(Number.POSITIVE_INFINITY);
    expect(h.state.cameraBase.eye).toEqual([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
  });

  it("set 之后同帧 get 当场读回新值；get → 改 → set 往返", () => {
    const h = apiOf();
    const t = h.scene.getCameraTransforms();
    t.eye.x = 483;
    t.eye.y = 322;
    t.zoom = 1.11;
    expect(h.scene.setCameraTransforms(t)).toBe(true);
    const back = h.scene.getCameraTransforms();
    expect([back.eye.x, back.eye.y, back.eye.z]).toEqual([483, 322, 0]);
    expect(back.zoom).toBe(f(1.11));
    // 写进的是基准的值，不是总缩放
    expect(h.state.cameraBase.zoom).toBe(f(1.11));
  });

  it("写回目标按字段各一个键", () => {
    const h = apiOf();
    h.scene.setCameraTransforms({ eye: { x: 1, y: 2, z: 3 }, zoom: 2 });
    expect(h.writes.map((w) => targetKey(w.target))).toEqual(["general/camera/eye", "general/camera/zoom"]);
  });
});

// ———— 重编译：重放 ————

describe("重编译重放：update 阶段的写入恢复，init 里被覆盖的 eye 不复活、init 里的 zoom 复活", () => {
  const report = { ready() {}, fallback() {}, debug() {}, info() {}, warn() {}, error() {} };

  /** 同宿主：脚本写回进状态并记进重放表；新状态建好后重放。 */
  function setup(bundle: SceneBundle) {
    const init = SceneState.fromBundle(bundle);
    init.beginScriptInit();
    let fresh = SceneState.fromBundle(bundle);
    const runtime = new ScriptRuntime(new FakeRealm(), {
      report,
      write: (target, value) => {
        fresh.write({ property: "", target: target as never }, scriptWriteValue(value as number[]));
        return true;
      },
      read: () => null,
    });
    const remember = (state: SceneState, field: "eye" | "center" | "up" | "zoom", values: number[]) => {
      const target: ScriptTarget = { kind: "camera-base", field };
      writeBase(state, field, values);
      runtime.rememberWrite(target, values);
    };
    const recompile = (): SceneState => {
      fresh = SceneState.fromBundle(bundle);
      runtime.replayWrites();
      return fresh;
    };
    return { init, runtime, remember, recompile };
  }

  it("正交：init 写 eye 与 zoom → 收尾去掉 eye 的写入 → 重放只剩 zoom", () => {
    const h = setup(bundleOf());
    h.remember(h.init, "eye", [50, 60, 0]);
    h.remember(h.init, "zoom", [2]);
    for (const field of h.init.finishScriptInit()) h.runtime.forgetWrite(targetKey({ kind: "camera-base", field }));
    const state = h.recompile();
    expect(state.cameraBase).toEqual({ eye: [0, 0, 0], center: [0, 0, -1], up: [0, 1, 0], zoom: 2 });
  });

  it("update 阶段（收尾之后）的写入随重放恢复", () => {
    const h = setup(bundleOf());
    h.remember(h.init, "eye", [50, 60, 0]);
    for (const field of h.init.finishScriptInit()) h.runtime.forgetWrite(targetKey({ kind: "camera-base", field }));
    h.remember(h.init, "eye", [300, 200, 0]);
    h.remember(h.init, "center", [300, 200, -1]);
    const state = h.recompile();
    expect(state.cameraBase.eye).toEqual([300, 200, 0]);
    expect(state.cameraBase.center).toEqual([300, 200, -1]);
  });

  it("透视：scene.json 没给的项保留 init 写的值（重放恢复），给了的被覆盖且不复活", () => {
    const camera: SceneCameraJson = { ...PERSPECTIVE_JSON, given: { eye: true, center: false, up: false } };
    const h = setup(bundleOf({ perspective: true, camera }));
    h.remember(h.init, "eye", [100, 0, 0]);
    h.remember(h.init, "center", [5, 5, 5]);
    for (const field of h.init.finishScriptInit()) h.runtime.forgetWrite(targetKey({ kind: "camera-base", field }));
    const state = h.recompile();
    expect(state.cameraBase.eye).toEqual([6, 4, 10]);
    expect(state.cameraBase.center).toEqual([5, 5, 5]);
  });
});

// ———— dev 探针的相机（`frameCamera`） ————

describe("dev 探针：没有相机对象时也按状态里的基准求相机", () => {
  const record = () => {
    const cameras: unknown[] = [];
    return { scene: { setCamera: (camera: unknown) => cameras.push(camera) } as never, cameras };
  };

  it("probeCameraObjects 没有相机对象时也给（图层表为空）", () => {
    const objects = probeCameraObjects(bundleOf());
    expect(objects.layers).toEqual([]);
    expect(objects.general.width).toBe(1920);
  });

  it("基准没改过：图层表为空与不给相机对象的结果逐项相同（正交、透视）", () => {
    for (const perspective of [false, true]) {
      const bundle = bundleOf(perspective ? { perspective: true, camera: PERSPECTIVE_JSON } : {});
      const state = SceneState.fromBundle(bundle);
      const probePerspective = perspective
        ? { camera: PERSPECTIVE_JSON, path: initialCameraPathState(), size: [1920, 1080] as [number, number] }
        : undefined;
      const a = record();
      const b = record();
      frameCamera(a.scene, state, 1080, probePerspective, [0.05], probeCameraObjects(bundle)).apply(1.5);
      frameCamera(b.scene, state, 1080, probePerspective, [0.05]).apply(1.5);
      expect(a.cameras).toEqual(b.cameras);
    }
  });

  it("正交：脚本改过基准后，图层表为空时走基准（视图平移、总缩放）", () => {
    const bundle = bundleOf();
    const state = SceneState.fromBundle(bundle);
    writeBase(state, "eye", [100, 50, 0]);
    writeBase(state, "center", [100, 50, -1]);
    writeBase(state, "zoom", [2]);
    const { scene, cameras } = record();
    const eye = frameCamera(scene, state, 1080, undefined, [0.05], probeCameraObjects(bundle)).apply(1.5);
    expect(eye).toEqual([100, 50]);
    const camera = cameras[0] as { zoom: number; cameraObject?: { eyePosition: number[] } };
    expect(camera.zoom).toBe(orthographicCameraZoom(state.general.zoom, 2));
    expect(camera.cameraObject).toBeDefined();
  });
});
