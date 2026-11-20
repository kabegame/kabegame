/**
 * P13k（聚光 cookie 与体积光的聚光阴影，`.claude/plans/wpe-import/3-scene/phase13/phase-13k-spot-cookie.md`）的单测。
 * P13k-1（体积光）：
 * - `lightCookieName`：rea R1（`FUN_14025d080`）：只认非空字符串，否则缺省 `cookie/flashlight1`；
 * - `spotLightCube`：NDC 立方体 8 点 36 索引（`p13k-vol` 抓帧背面 / 正面各 36 个索引）；
 * - `insideLightVolume` 的 cookie 分支：`eye + 0.1·F` 对灯视锥六面（`p13k-vol-inside` 抓帧换成全屏三角形）；
 * - `compileVolumetrics`：聚光 cookie 加 `COOKIE = 1` 与槽 2，聚光阴影不再报，点光 cookie 报 `volumetrics:cookie:point`；
 * - `uploadableTextures` 把灯的 cookie 算进去；
 * - 真翻译器编 `p13k-vol` / `p13k-vol-both`（`ignore/p13/k/gen_k.py`）：体积光的键清零、cookie 进纹理表。
 * P13k-2（表面着色）：
 * - `lightFrame`：别名取排序后最后一盏可见、分到聚光槽的 cookie 聚光（R2）；只开 cookie 的聚光占投影槽、不生成条目（R7），档位 0 时阴影 + cookie
 *   并进 cookie 段；`writeCookieProjections` 写不偏的视图投影、不写方块变换；
 * - 真翻译器编 `p13k-surf` / `-surf-shadow` / `-surf-two`：不报键、`LIGHTS_COOKIE` 定义、cookie 槽（`g_Texture7`）绑别名、渲染图输入是
 *   `light-cookie`。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compileScene, openCompileSession } from "./bundle";
import type { SceneReader } from "./fs";
import {
  collectSceneLights,
  compileLightObjects,
  DEFAULT_LIGHT_COOKIE,
  lightCookieName,
  lightFrame,
  type LightCounts,
} from "./lights";
import type { SceneObject, SceneScalar, SceneValue } from "./model";
import { compileVolumetrics, spotLightCube, spotViewProjection, type VolumetricsCompileContext } from "./volumetrics";
import { planModelLayer } from "../render/graph";
import { layerLocalMatrix } from "../render/layout";
import { uploadableTextures } from "../render/scene";
import { writeCookieProjections } from "../render/shadowMath";
import { insideLightVolume } from "../render/volumetrics";
import { Wpesl2wgsl, type TranslateRequest, type TranslateResult } from "../wpesl2wgsl";

vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

describe("lightCookieName（rea R1）", () => {
  it("usecookie 为假没有；非空字符串原样；键缺、空串、不是字符串（含 {user}）用缺省", () => {
    expect(lightCookieName({ cookie: "cookie/flashlight3" }, 1)).toBeNull();
    expect(lightCookieName({ cookie: "cookie/flashlight3" }, 2)).toBe("cookie/flashlight3");
    expect(lightCookieName({ cookie: "cookie/flashlight3" }, 3)).toBe("cookie/flashlight3");
    expect(lightCookieName({}, 2)).toBe(DEFAULT_LIGHT_COOKIE);
    expect(lightCookieName({ cookie: "" }, 2)).toBe("cookie/flashlight1");
    expect(lightCookieName({ cookie: { user: "c", value: "cookie/flashlight2" } }, 2)).toBe("cookie/flashlight1");
    expect(lightCookieName({ cookie: 3 }, 2)).toBe("cookie/flashlight1");
  });
});

describe("cookie 灯体（rea-p13-volumetrics V1.2）", () => {
  it("NDC 立方体：z10 = 0 的四角在前、z11 = 1 在后，12 个三角形照 WPE 的索引", () => {
    const { positions, indices } = spotLightCube();
    expect(Array.from(positions)).toEqual([
      -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
    ]);
    expect(Array.from(indices)).toEqual([
      1, 0, 2, 2, 0, 3, 4, 5, 6, 4, 6, 7, 3, 0, 4, 3, 4, 7, 1, 2, 5, 5, 2, 6, 2, 3, 6, 6, 3, 7, 0, 1, 5, 0, 5, 4,
    ]);
  });
});

describe("insideLightVolume 的 cookie 分支（`0x1401979c3`）", () => {
  // 正交 1920×1080：g_EyePosition = (960, 540, 2000)、F = (0, 0, −1)
  const eye = [960, 540, 2000];
  const forward = [0, 0, -1];
  const vpOf = (origin: number[], angles: number[], outer: number, radius: number) =>
    spotViewProjection(layerLocalMatrix({ origin, angles, scale: [1, 1, 1] }), outer, radius, true);
  const light = { kind: "spot" as const, radius: 3000, position: [960, 540, 2100] as [number, number, number] };

  it("p13k-vol-inside：灯 (960, 540, 2100) 朝 −Z、外锥 40，eye + 0.1·F 在视锥里", () => {
    expect(insideLightVolume(light, eye, forward, vpOf([960, 540, 2100], [0, 1.5708, 0], 40, 3000))).toBe(true);
  });

  it("p13k-vol：灯 (200, 1000, 250) 朝右下，eye 不在里面；灯在 eye 后面也不在", () => {
    expect(insideLightVolume(light, eye, forward, vpOf([200, 1000, 250], [0, 0, -0.8], 30, 2048))).toBe(false);
    expect(insideLightVolume(light, eye, forward, vpOf([960, 540, 1900], [0, 1.5708, 0], 40, 3000))).toBe(false);
  });

  it("前移 0.1 不是 0.2：近平面边上（正交场景近平面 1）两者分得开", () => {
    // 灯朝 −Z，p = eye + 0.1·F 的 z 是 1999.9，在灯前方 z_灯 − 1999.9；要 ≥ 近平面 1 才在内
    const at = (z: number) => insideLightVolume(light, eye, forward, vpOf([960, 540, z], [0, 1.5708, 0], 40, 3000));
    expect(at(2000.91)).toBe(true); // 距灯 1.01
    expect(at(2000.85)).toBe(false); // 距灯 0.95；若前移 0.2，p.z = 1999.8、距灯 1.05，会算在内
  });
});

// ———— compileVolumetrics 的组合键与槽 ————

const COUNTS: LightCounts = {
  point: 1,
  spot: 1,
  tube: 0,
  directional: 0,
  pointShadow: 1,
  spotShadow: 1,
  spotCookie: 1,
  spotShadowCookie: 1,
  directionalShadow: 0,
};
const read = (value: SceneValue | undefined): SceneScalar | undefined =>
  value && typeof value === "object" && "value" in value ? (value.value as SceneScalar) : (value as SceneScalar);

async function compileRules(objects: SceneObject[], cookies: Record<number, number> = {}) {
  const unsupported = new Set<string>();
  const requests: { combos: Record<string, number>; slots: number[] }[] = [];
  let programs = 0;
  const context: VolumetricsCompileContext = {
    fs: {
      text: async () => JSON.stringify({ passes: [{ shader: "s" }] }),
    } as unknown as VolumetricsCompileContext["fs"],
    shader: {
      compile: async (_shader: string, combos: Record<string, number>, slots: { slot: number }[]) => {
        requests.push({ combos, slots: slots.map((item) => item.slot) });
        return { ok: true, uniforms: [], textures: [], combos: [] } as unknown as TranslateResult;
      },
    } as unknown as VolumetricsCompileContext["shader"],
    unsupported,
    addProgram: () => programs++,
  };
  const lights = compileLightObjects(objects, (value) => read(value));
  for (const light of lights) if (cookies[light.object] !== undefined) light.cookie = cookies[light.object];
  const result = await compileVolumetrics(context, {
    lights,
    layerOf: () => ({ origin: [0, 0, 0], angles: [0, 0, 0], scale: [1, 1, 1], color: [1, 1, 1] }),
    quality: 1,
    shadowQuality: 1,
    counts: COUNTS,
    orthographic: true,
    inGroup: () => false,
  });
  return { result, requests, unsupported: [...unsupported].sort() };
}

describe("compileVolumetrics：cookie 与聚光阴影（P13k-1）", () => {
  const spot = { light: "lspot", castvolumetrics: true };

  it("聚光开 cookie：正面与全屏加 COOKIE = 1、槽 2，灯记下 cookie 下标；不开 cookie 没有 COOKIE 键、没有槽 2", async () => {
    const withCookie = await compileRules([{ ...spot, usecookie: true }], { 0: 7 });
    expect(withCookie.unsupported).toEqual([]);
    expect(withCookie.result!.lights[0].cookie).toBe(7);
    const [, front, fullscreen] = withCookie.requests;
    for (const request of [front, fullscreen]) {
      expect(request.combos.COOKIE).toBe(1);
      expect(request.slots).toEqual([1, 3, 2]);
    }
    const plain = await compileRules([spot]);
    expect(plain.result!.lights[0].cookie).toBeNull();
    expect(plain.requests[1].combos).not.toHaveProperty("COOKIE");
    expect(plain.requests[1].slots).toEqual([1, 3]);
  });

  it("聚光阴影：SHADOW = 1、不报；同时开 cookie 两个都有", async () => {
    const both = await compileRules([{ ...spot, usecookie: true, castshadow: true }], { 0: 2 });
    expect(both.unsupported).toEqual([]);
    expect(both.result!.lights[0].shadow).toBe(true);
    expect(both.requests[1].combos).toMatchObject({ SHADOW: 1, COOKIE: 1, POINTLIGHT: 0 });
    expect(both.requests[1].combos).not.toHaveProperty("LIGHTS_SHADOW_MAPPING_QUALITY");
  });

  it("点光开 cookie 照报 volumetrics:cookie:point，不加 COOKIE", async () => {
    const point = await compileRules([{ light: "lpoint", castvolumetrics: true, usecookie: true }]);
    expect(point.unsupported).toEqual(["volumetrics:cookie:point"]);
    expect(point.requests[1].combos).not.toHaveProperty("COOKIE");
  });
});

describe("uploadableTextures：灯的 cookie", () => {
  it("灯上的 cookie 下标也上传（不经图层的 pass）", () => {
    const used = uploadableTextures({
      layers: [],
      lightObjects: [{ object: 0, cookie: 4 }, { object: 1 }] as never,
    });
    expect([...used]).toEqual([4]);
  });
});

// ———— P13k-2：灯光数组里的 cookie（R2、R7） ————

describe("lightFrame 的 cookie（P13k-2，R2、R7）", () => {
  const NONE: LightCounts = {
    point: 0,
    spot: 0,
    tube: 0,
    directional: 0,
    pointShadow: 0,
    spotShadow: 0,
    spotCookie: 0,
    spotShadowCookie: 0,
    directionalShadow: 0,
  };
  const lamp = (origin: string, extra: Record<string, unknown> = {}): SceneObject => ({
    light: "lspot",
    origin,
    angles: "0 1.5708 0",
    intensity: 1,
    color: "1 1 1",
    radius: 2048,
    outercone: 30,
    innercone: 20,
    ...extra,
  });
  const lightsOf = (objects: SceneObject[]) => collectSceneLights(objects, (value) => read(value));
  const FORWARD = [0, 0, -1];

  it("p13k-surf-two：两盏 cookie 灯按 dot(局部 origin, F) 升序，别名取排在后面的 B；各占 cookie 段的投影槽 0、1，没有条目", () => {
    const objects = [
      lamp("600 540 700", { usecookie: true }),
      lamp("1300 540 600", { usecookie: true }),
      lamp("960 250 500"),
    ];
    const counts = { ...NONE, spot: 3, spotCookie: 2 };
    const frame = lightFrame(lightsOf(objects), counts, 0, FORWARD);
    expect(frame.cookie?.object).toBe(1);
    expect(frame.cookieProjections.map(({ light, slot }) => [light.object, slot])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(frame.entries).toEqual([]);
    // B 隐藏：只剩 A，别名取 A
    const hidden = lightsOf(objects).map((light) => (light.object === 1 ? { ...light, visible: false } : light));
    expect(lightFrame(hidden, counts, 0, FORWARD).cookie?.object).toBe(0);
    // 没有 cookie 灯可见：null（别名保持上一次的，渲染器处理）
    const none = hidden.map((light) => (light.object === 0 ? { ...light, visible: false } : light));
    expect(lightFrame(none, counts, 0, FORWARD).cookie).toBeNull();
  });

  it("别名不看投影余量：N 用完的 cookie 灯照样成为别名（R2 在写槽之后、投影判定之外）", () => {
    const objects = [lamp("600 540 700", { usecookie: true }), lamp("1300 540 600", { usecookie: true })];
    // lightconfig 只给 1 个 cookie：第二盏没有投影槽，仍是别名
    const frame = lightFrame(lightsOf(objects), { ...NONE, spot: 2, spotCookie: 1 }, 0, FORWARD);
    expect(frame.cookieProjections.map(({ light }) => light.object)).toEqual([0]);
    expect(frame.cookie?.object).toBe(1);
  });

  it("阴影 + cookie：档位 ≠ 0 生成阴影条目（投影由 planShadows 写）；档位 0 时并进 cookie 段、记成只开 cookie 的投影", () => {
    const objects = [lamp("960 540 700", { usecookie: true, castshadow: true })];
    const shadowed = lightFrame(lightsOf(objects), { ...NONE, spot: 1, spotShadowCookie: 1 }, 2, FORWARD);
    expect(shadowed.entries.map((entry) => [entry.kind, entry.slot])).toEqual([["spot", 0]]);
    expect(shadowed.cookieProjections).toEqual([]);
    expect(shadowed.cookie?.object).toBe(0);
    const off = lightFrame(lightsOf(objects), { ...NONE, spot: 1, spotCookie: 1 }, 0, FORWARD);
    expect(off.entries).toEqual([]);
    expect(off.cookieProjections.map(({ slot }) => slot)).toEqual([0]);
  });

  it("cookie 段的投影指针从 SSC 起；writeCookieProjections 写不偏的 VP、不碰方块变换", () => {
    const objects = [
      lamp("960 540 700", { usecookie: true, castshadow: true }),
      lamp("400 540 600", { usecookie: true }),
    ];
    const counts = { ...NONE, spot: 2, spotShadowCookie: 1, spotCookie: 1 };
    const frame = lightFrame(lightsOf(objects), counts, 2, FORWARD);
    expect(frame.cookieProjections.map(({ light, slot }) => [light.object, slot])).toEqual([[1, 1]]);
    writeCookieProjections(frame, true);
    const light = frame.cookieProjections[0].light;
    const vp = spotViewProjection(light.matrix, light.outercone, light.radius, true);
    const at = frame.layout.projection + 16;
    expect(Array.from(frame.buffer.subarray(at, at + 16))).toEqual(Array.from(vp));
    // 方块变换那一格（cookie 段不读）保持 0；槽 0 的投影留给 planShadows
    const transform = frame.layout.projectionTransform + 4;
    expect(Array.from(frame.buffer.subarray(transform, transform + 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(frame.buffer.subarray(frame.layout.projection, frame.layout.projection + 16))).toEqual(
      new Array(16).fill(0),
    );
  });
});

// ———— 真翻译器：确定性工程 ————

function repoRoot(): string {
  let dir = __dirname;
  while (!existsSync(join(dir, "ignore", "p13", "proj")) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}
const PROJECTS = join(repoRoot(), "ignore", "p13", "proj");
const root = process.env.KABEGAME_WPE_ROOT;
const wasm = join(__dirname, "..", "wpesl2wgsl", "wpesl2wgsl.wasm");
const diskReader: SceneReader = {
  async readWhole(path) {
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      throw new TypeError("Failed to fetch");
    }
  },
  async readRange(path, start, end) {
    try {
      return new Uint8Array(readFileSync(path).subarray(start, end));
    } catch {
      throw new TypeError("Failed to fetch");
    }
  },
};

describe.skipIf(!root || !existsSync(wasm) || !existsSync(join(PROJECTS, "p13k-vol")))(
  "真翻译器：p13k 的体积光工程",
  () => {
    const compile = async (name: string) => {
      const requests: TranslateRequest[] = [];
      const real = await Wpesl2wgsl.fromBytes(readFileSync(wasm));
      const bundle = await compileScene({
        projectDir: join(PROJECTS, name),
        sceneAssets: [join(root!, "assets")],
        reader: diskReader,
        translator: {
          translate: (request: TranslateRequest) => {
            requests.push(request);
            return real.translate(request);
          },
        } as unknown as Wpesl2wgsl,
        postprocess: "disabled",
        shadows: "low",
        volumetrics: "low",
        exhaustive: true,
      });
      return { bundle, requests };
    };

    it("p13k-vol：缺省 cookie 进纹理表，正面程序读槽 2；体积光不报键（lightconfig 的 spotcookie 等 k-2）", async () => {
      const { bundle } = await compile("p13k-vol");
      expect(bundle.unsupported.filter((key) => key.startsWith("volumetrics"))).toEqual([]);
      const [light] = bundle.volumetrics!.lights;
      expect(light.cookie).not.toBeNull();
      expect(bundle.textures[light.cookie!].path).toBe("materials/cookie/flashlight1.tex");
      expect(bundle.lightObjects!.find((item) => item.object === light.object)!.cookie).toBe(light.cookie);
      const front = bundle.programs[light.front.program!];
      expect(front.textures?.map((texture) => texture.slot).sort()).toEqual([1, 2, 3]);
    });

    it("p13k-vol-both：阴影 + cookie 都编（SHADOW 读槽 0 的图集），不报 volumetrics:*", async () => {
      const { bundle } = await compile("p13k-vol-both");
      expect(bundle.unsupported.filter((key) => key.startsWith("volumetrics"))).toEqual([]);
      const [light] = bundle.volumetrics!.lights;
      expect([light.shadow, light.cookie !== null]).toEqual([true, true]);
      const front = bundle.programs[light.front.program!];
      expect(front.textures?.map((texture) => texture.slot).sort()).toEqual([0, 1, 2, 3]);
    });

    it("p13k-vol-explicit / -bad：写了的名字照用；文件不存在报 texture:missing 并绑棋盘格", async () => {
      const explicit = await compile("p13k-vol-explicit");
      const [a] = explicit.bundle.volumetrics!.lights;
      expect(explicit.bundle.textures[a.cookie!].path).toBe("materials/cookie/flashlight3.tex");
      const bad = await compile("p13k-vol-bad");
      expect(bad.bundle.unsupported).toContain("texture:missing:materials/cookie/nope.tex");
      const [b] = bad.bundle.volumetrics!.lights;
      expect(bad.bundle.textures[b.cookie!].width).toBe(6);
    });
  },
);

describe.skipIf(!root || !existsSync(wasm) || !existsSync(join(PROJECTS, "p13k-surf")))(
  "真翻译器：p13k 的表面着色工程（P13k-2）",
  () => {
    const compile = async (name: string) => {
      const requests: TranslateRequest[] = [];
      const real = await Wpesl2wgsl.fromBytes(readFileSync(wasm));
      const bundle = await compileScene({
        projectDir: join(PROJECTS, name),
        sceneAssets: [join(root!, "assets")],
        reader: diskReader,
        translator: {
          translate: (request: TranslateRequest) => {
            requests.push(request);
            return real.translate(request);
          },
        } as unknown as Wpesl2wgsl,
        postprocess: "disabled",
        shadows: "low",
        volumetrics: "low",
        exhaustive: true,
      });
      return { bundle, requests };
    };
    /** 读 `_alias_lightCookie` 的 pass 槽：`[pass.key, 槽]`。 */
    const aliasSlots = (bundle: Awaited<ReturnType<typeof compile>>["bundle"]) => {
      const out: [string, number][] = [];
      const walk = (value: unknown) => {
        if (!value || typeof value !== "object") return;
        const pass = value as { key?: unknown; runtime?: Record<string, string> };
        if (typeof pass.key === "string" && pass.runtime)
          for (const [slot, name] of Object.entries(pass.runtime))
            if (name === "_alias_lightCookie") out.push([pass.key, Number(slot)]);
        for (const item of Object.values(value)) walk(item);
      };
      walk(bundle.layers);
      return out;
    };

    it("p13k-surf：不报键；LIGHTS_COOKIE 定义；generic4 与 genericimage4 的槽 7 绑别名；渲染图输入是 light-cookie", async () => {
      const { bundle, requests } = await compile("p13k-surf");
      expect(bundle.unsupported).toEqual([]);
      expect(bundle.lights?.counts).toMatchObject({ spot: 1, spotCookie: 1 });
      expect(requests.some((request) => request.litDefines?.LIGHTS_COOKIE === "1")).toBe(true);
      // 地面、立方体（generic4，`objects` 下标 2、3）与图像层（genericimage4，预光照的基础 pass，4）都读，都是槽 7
      expect(aliasSlots(bundle)).toEqual([
        ["objects/2/meshes/0/passes/0", 7],
        ["objects/3/meshes/0/passes/0", 7],
        ["objects/4/passes/0", 7],
      ]);
      const ground = bundle.layers.find((layer) => layer.object === 2)!;
      const plan = planModelLayer(ground);
      const [mesh] = plan.steps.filter((step) => step.kind === "mesh");
      expect(mesh.kind === "mesh" && mesh.inputs[7]).toEqual({ kind: "light-cookie" });
      expect(plan.reasons).toEqual([]);
      for (const program of bundle.programs)
        for (const texture of program.textures ?? []) if (texture.slot === 7) expect(texture.kind).toBe("2d");
    });

    it("p13k-surf-shadow：阴影 + cookie 段（低档）不报键，SSC = 1", async () => {
      const { bundle } = await compile("p13k-surf-shadow");
      expect(bundle.unsupported).toEqual([]);
      expect(bundle.lights?.counts).toMatchObject({ spot: 1, spotShadowCookie: 1, spotCookie: 0 });
      expect(aliasSlots(bundle).length).toBeGreaterThan(0);
    });

    it("p13k-surf-two：两盏 cookie 各自的 cookie 都进纹理表（别名按帧解析），不报键", async () => {
      const { bundle } = await compile("p13k-surf-two");
      expect(bundle.unsupported).toEqual([]);
      const paths = bundle
        .lightObjects!.filter((light) => light.cookie !== undefined)
        .map((light) => bundle.textures[light.cookie!].path);
      expect(paths).toEqual(["materials/cookie/flashlight1.tex", "materials/cookie/flashlight3.tex"]);
    });

    it("运行中建的 cookie 聚光（片段）：同整场加载 cookie，已有的复用下标，新的随纹理增量带出", async () => {
      const real = await Wpesl2wgsl.fromBytes(readFileSync(wasm));
      const session = await openCompileSession({
        projectDir: join(PROJECTS, "p13k-surf"),
        sceneAssets: [join(root!, "assets")],
        reader: diskReader,
        translator: real,
        postprocess: "disabled",
        shadows: "low",
        volumetrics: "low",
        exhaustive: true,
      });
      for (let index = 0; index < session.objectCount; index++) await session.compileObject(index);
      const bundle = await session.finalize();
      const scene = JSON.parse(readFileSync(join(PROJECTS, "p13k-surf", "scene.json"), "utf8"));
      const lamp = scene.objects[5];
      const whole = bundle.lightObjects!.find((light) => light.object === 5)!;
      const same = await session.compileFragment({
        object: 6,
        config: JSON.stringify({ ...lamp, id: 900 }),
        parent: null,
        bone: null,
        properties: {},
      });
      expect(same.fragment.light?.cookie).toBe(whole.cookie);
      expect(same.textures.list).toEqual([]);
      const other = await session.compileFragment({
        object: 7,
        config: JSON.stringify({ ...lamp, id: 901, cookie: "cookie/flashlight3" }),
        parent: null,
        bone: null,
        properties: {},
      });
      const cookie = other.fragment.light!.cookie!;
      expect(cookie).toBeGreaterThanOrEqual(other.textures.from);
      expect(other.textures.list[cookie - other.textures.from].path).toBe("materials/cookie/flashlight3.tex");
    });
  },
);
