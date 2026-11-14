/**
 * 按指定尺寸画的投影（phase-render-size 点 1）：对齐方式 → 裁切边距 `alignEdges`、带边距的 `sceneViewProjection`、裁切下的透视粒子相机。
 * - `alignEdges` 四种模式各窗口形状，数值照读码第 1 节（rea-render-size）与 0b 实测的投影边界；
 * - MVP 与 WPE 抓帧逐位相同：真值取自 `prs-grid` / `prs-small` 两个测试工程在 15 个「窗口 × 对齐方式」组合下的 `corner_tl` 图层 MVP
 *   （RenderDoc 抓帧读到的常量，列主序，WPE 2.8.42），这里用渲染器给 draw 写 uniform 的同一条计算路径（`sceneViewProjection` 的 P、
 *   单位视图、`mulAffine(VP, 世界矩阵)`）算，每个分量都要同一个 f32；
 * - 透视粒子：不给 `crop` 时逐字节同以前；给了照读码第 5 节（对称裁切、zoom 1 时 z = 0 平面与正交画面重合）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALIGNMENT_OF_STYLE,
  alignEdges,
  clearsWithSchemeColor,
  layerLocalMatrix,
  particleViewProjection,
  sceneViewProjection,
} from "./layout";
import { mulAffine, multiply, translation, type Mat4 } from "./math";
import { generalDefaults } from "../compile/bindings";
import type { SceneBundle, SceneLayer } from "../compile/bundle";
import { particleFov } from "../compile/particles";
import { BLOOM_DEFAULTS } from "../compile/postprocess";
import type { TranslateResult } from "../wpesl2wgsl";
import { GpuScene } from "./scene";
import { SceneState } from "./state";
import type { FrameInput } from "./uniforms";

vi.mock("./device", () => ({ acquireGpu: vi.fn() }));
vi.mock("../fileUrl", () => ({ fileToUrl: (path: string) => path }));

interface MvpCase {
  tag: string;
  scene: [number, number];
  window: [number, number];
  alignment: 0 | 1 | 2 | 3;
  origin: [number, number, number];
  mvp: number[];
}

/** WPE 抓帧的真值（`ignore/prs/fixture-mvp.json`，15 段）。 */
const FIXTURE: MvpCase[] = [
  {
    tag: "grid-a0-1280x720",
    scene: [1920, 1080],
    window: [1280, 720],
    alignment: 0,
    origin: [40, 1040, 0],
    mvp: [
      0.0010416667209938169, 0.0, 0.0, 0.0, 0.0, 0.0018518518190830946, 0.0, 0.0, 0.0, 0.0, 0.0002500000118743628, 0.0,
      -0.9583333134651184, 0.9259258508682251, 0.5, 1.0,
    ],
  },
  {
    tag: "grid-a0-1440x1080",
    scene: [1920, 1080],
    window: [1440, 1080],
    alignment: 0,
    origin: [40, 1040, 0],
    mvp: [
      0.0013888889225199819, 0.0, 0.0, 0.0, 0.0, 0.0018518518190830946, 0.0, 0.0, 0.0, 0.0, 0.0002500000118743628, 0.0,
      -1.2777777910232544, 0.9259258508682251, 0.5, 1.0,
    ],
  },
  {
    tag: "grid-a0-1920x1080",
    scene: [1920, 1080],
    window: [1920, 1080],
    alignment: 0,
    origin: [40, 1040, 0],
    mvp: [
      0.0010416667209938169, 0.0, 0.0, 0.0, 0.0, 0.0018518518190830946, 0.0, 0.0, 0.0, 0.0, 0.0002500000118743628, 0.0,
      -0.9583333134651184, 0.9259258508682251, 0.5, 1.0,
    ],
  },
  {
    tag: "grid-a0-1920x800",
    scene: [1920, 1080],
    window: [1920, 800],
    alignment: 0,
    origin: [40, 1040, 0],
    mvp: [
      0.0010416667209938169, 0.0, 0.0, 0.0, 0.0, 0.0024999999441206455, 0.0, 0.0, 0.0, 0.0, 0.0002500000118743628, 0.0,
      -0.9583333134651184, 1.2499998807907104, 0.5, 1.0,
    ],
  },
  {
    tag: "grid-a1-1280x720",
    scene: [1920, 1080],
    window: [1280, 720],
    alignment: 1,
    origin: [40, 1040, 0],
    mvp: [
      0.0010416667209938169, 0.0, 0.0, 0.0, 0.0, 0.0018518518190830946, 0.0, 0.0, 0.0, 0.0, 0.0002500000118743628, 0.0,
      -0.9583333134651184, 0.9259258508682251, 0.5, 1.0,
    ],
  },
  {
    tag: "grid-a1-1440x1080",
    scene: [1920, 1080],
    window: [1440, 1080],
    alignment: 1,
    origin: [40, 1040, 0],
    mvp: [
      0.0010416667209938169, 0.0, 0.0, 0.0, 0.0, 0.0013888889225199819, 0.0, 0.0, 0.0, 0.0, 0.0002500000118743628, 0.0,
      -0.9583333134651184, 0.6944445371627808, 0.5, 1.0,
    ],
  },
  {
    tag: "grid-a1-1920x800",
    scene: [1920, 1080],
    window: [1920, 800],
    alignment: 1,
    origin: [40, 1040, 0],
    mvp: [
      0.0007716049440205097, 0.0, 0.0, 0.0, 0.0, 0.0018518518190830946, 0.0, 0.0, 0.0, 0.0, 0.0002500000118743628, 0.0,
      -0.709876537322998, 0.9259258508682251, 0.5, 1.0,
    ],
  },
  {
    tag: "grid-a2-1440x1080",
    scene: [1920, 1080],
    window: [1440, 1080],
    alignment: 2,
    origin: [40, 1040, 0],
    mvp: [
      0.0010416667209938169, 0.0, 0.0, 0.0, 0.0, 0.0018518518190830946, 0.0, 0.0, 0.0, 0.0, 0.0002500000118743628, 0.0,
      -0.9583333134651184, 0.9259258508682251, 0.5, 1.0,
    ],
  },
  {
    tag: "grid-a2-1920x800",
    scene: [1920, 1080],
    window: [1920, 800],
    alignment: 2,
    origin: [40, 1040, 0],
    mvp: [
      0.0010416667209938169, 0.0, 0.0, 0.0, 0.0, 0.0018518518190830946, 0.0, 0.0, 0.0, 0.0, 0.0002500000118743628, 0.0,
      -0.9583333134651184, 0.9259258508682251, 0.5, 1.0,
    ],
  },
  {
    tag: "grid-a3-1280x720",
    scene: [1920, 1080],
    window: [1280, 720],
    alignment: 3,
    origin: [40, 1040, 0],
    mvp: [
      0.0015625000232830644, 0.0, 0.0, 0.0, 0.0, 0.0027777778450399637, 0.0, 0.0, 0.0, 0.0, 0.0002500000118743628, 0.0,
      -1.4375, 1.3888890743255615, 0.5, 1.0,
    ],
  },
  {
    tag: "grid-a3-1440x1080",
    scene: [1920, 1080],
    window: [1440, 1080],
    alignment: 3,
    origin: [40, 1040, 0],
    mvp: [
      0.0013888889225199819, 0.0, 0.0, 0.0, 0.0, 0.0018518518190830946, 0.0, 0.0, 0.0, 0.0, 0.0002500000118743628, 0.0,
      -1.2777777910232544, 0.9259258508682251, 0.5, 1.0,
    ],
  },
  {
    tag: "grid-a3-1920x800",
    scene: [1920, 1080],
    window: [1920, 800],
    alignment: 3,
    origin: [40, 1040, 0],
    mvp: [
      0.0010416667209938169, 0.0, 0.0, 0.0, 0.0, 0.0024999999441206455, 0.0, 0.0, 0.0, 0.0, 0.0002500000118743628, 0.0,
      -0.9583333134651184, 1.2499998807907104, 0.5, 1.0,
    ],
  },
  {
    tag: "small-a0-1920x1080",
    scene: [960, 540],
    window: [1920, 1080],
    alignment: 0,
    origin: [20, 520, 0],
    mvp: [
      0.0020833334419876337, 0.0, 0.0, 0.0, 0.0, 0.003703703638166189, 0.0, 0.0, 0.0, 0.0, 0.0002500000118743628, 0.0,
      -0.9583333134651184, 0.9259258508682251, 0.5, 1.0,
    ],
  },
  {
    tag: "small-a1-1920x1080",
    scene: [960, 540],
    window: [1920, 1080],
    alignment: 1,
    origin: [20, 520, 0],
    mvp: [
      0.0020833334419876337, 0.0, 0.0, 0.0, 0.0, 0.003703703638166189, 0.0, 0.0, 0.0, 0.0, 0.0002500000118743628, 0.0,
      -0.9583333134651184, 0.9259258508682251, 0.5, 1.0,
    ],
  },
  {
    tag: "small-a3-1920x1080",
    scene: [960, 540],
    window: [1920, 1080],
    alignment: 3,
    origin: [20, 520, 0],
    mvp: [
      0.0010416667209938169, 0.0, 0.0, 0.0, 0.0, 0.0018518518190830946, 0.0, 0.0, 0.0, 0.0, 0.0002500000118743628, 0.0,
      -0.4791666567325592, 0.46296292543411255, 0.5, 1.0,
    ],
  },
];

/** 两个 f32 之间隔了多少个 ulp（同号的整数位模式差；异号时取到 0 的距离之和）。 */
function ulpDistance(a: number, b: number): number {
  const view = new DataView(new ArrayBuffer(4));
  const bits = (x: number) => {
    view.setFloat32(0, x);
    const raw = view.getInt32(0);
    return raw < 0 ? -(raw & 0x7fffffff) : raw; // 符号位翻成负数，−0 与 +0 同为 0
  };
  return Math.abs(bits(a) - bits(b));
}

describe("alignEdges：对齐方式 → 裁切边距 [E0 左, E1 上, E2 右, E3 下]", () => {
  const scene = [1920, 1080] as const;

  it("0（fill / cover）：窗口更宽裁上下，更高裁左右，同比例不裁", () => {
    expect(alignEdges(0, ...scene, 1920, 800)).toEqual([0, 140, 0, 140]);
    expect(alignEdges(0, ...scene, 1440, 1080)).toEqual([240, 0, 240, 0]);
    expect(alignEdges(0, ...scene, 1280, 720)).toEqual([0, 0, 0, 0]);
    expect(alignEdges(0, ...scene, 1920, 1080)).toEqual([0, 0, 0, 0]);
  });

  it("1（fit，WPE 叫 fill）：窗口更宽左右留边（负），更高上下留边，同比例不留", () => {
    expect(alignEdges(1, ...scene, 1920, 800)).toEqual([-336, 0, -336, 0]);
    expect(alignEdges(1, ...scene, 1440, 1080)).toEqual([0, -180, 0, -180]);
    expect(alignEdges(1, ...scene, 1280, 720)).toEqual([0, 0, 0, 0]);
  });

  it("2（stretch）：全 0", () => {
    for (const window of [
      [1920, 800],
      [1440, 1080],
      [1280, 720],
    ] as const) {
      expect(alignEdges(2, scene[0], scene[1], window[0], window[1])).toEqual([0, 0, 0, 0]);
    }
  });

  it("3（center）：一个场景单位对一个窗口像素，窗口比场景小时裁、大时留边", () => {
    expect(alignEdges(3, ...scene, 1280, 720)).toEqual([320, 180, 320, 180]);
    expect(alignEdges(3, ...scene, 1920, 800)).toEqual([0, 140, 0, 140]);
    expect(alignEdges(3, 960, 540, 1920, 1080)).toEqual([-480, -270, -480, -270]);
    expect(alignEdges(3, ...scene, 1920, 1080)).toEqual([0, 0, 0, 0]);
  });

  it("0–3 以外的值（含 4 自由）按缺省分支铺满裁切", () => {
    expect(alignEdges(4, ...scene, 1920, 800)).toEqual(alignEdges(0, ...scene, 1920, 800));
    expect(alignEdges(-1, ...scene, 1440, 1080)).toEqual(alignEdges(0, ...scene, 1440, 1080));
  });

  it("样式表与清屏色来源：tile 不在表里；对齐方式 1 / 3 用 schemecolor", () => {
    expect(ALIGNMENT_OF_STYLE).toEqual({ fill: 0, fit: 1, stretch: 2, center: 3 });
    expect("tile" in ALIGNMENT_OF_STYLE).toBe(false);
    expect([0, 1, 2, 3].map(clearsWithSchemeColor)).toEqual([false, true, false, true]);
  });
});

describe("sceneViewProjection(…, edges)：MVP 与 WPE 抓帧逐位相同", () => {
  for (const item of FIXTURE) {
    it(`${item.tag}（场景 ${item.scene.join("×")}，窗口 ${item.window.join("×")}，对齐方式 ${item.alignment}）`, () => {
      const general = { width: item.scene[0], height: item.scene[1] };
      const edges = alignEdges(item.alignment, ...item.scene, ...item.window);
      // 渲染器的路径：P = sceneViewProjection，视图是单位阵（不抖动时 VP 就是 P），MVP = mulAffine(VP, 图层世界矩阵)
      const vp = sceneViewProjection(general, 1, edges);
      const world = layerLocalMatrix({ origin: item.origin, angles: [0, 0, 0], scale: [1, 1, 1] });
      const mvp = mulAffine(vp, world);
      const worst = Math.max(...item.mvp.map((expected, i) => ulpDistance(mvp[i], expected)));
      expect(worst, `最大 ${worst} ulp`).toBe(0);
    });
  }

  it("不给 edges 时字节同以前（走原来的 orthographic）", () => {
    const general = { width: 1920, height: 1080 };
    expect(sceneViewProjection(general)).toEqual(sceneViewProjection(general, 1, undefined));
    expect(sceneViewProjection(general, 1.5)).toEqual(sceneViewProjection(general, 1.5, undefined));
  });

  it("边距全 0 且 zoom 1 时与不带边距逐位相同（rea-matrix-order 2.2：三步精确）", () => {
    const general = { width: 1920, height: 1080 };
    expect([...sceneViewProjection(general, 1, [0, 0, 0, 0])]).toEqual([...sceneViewProjection(general)]);
  });
});

/** 4×4（列主序）乘 (x, y, z, 1)，返回透视除法之后的 NDC xy。 */
function ndc(m: Mat4, x: number, y: number, z = 0): [number, number] {
  const c = (row: number) => m[row] * x + m[4 + row] * y + m[8 + row] * z + m[12 + row];
  return [c(0) / c(3), c(1) / c(3)];
}

describe("particleViewProjection(…, crop)：透视粒子在裁切下的相机（读码第 5 节）", () => {
  const FOV = (60 * Math.PI) / 180;
  const general = { width: 1920, height: 1080, perspectiveOverrideFov: FOV };

  /** 不给 crop 的旧公式（重述一遍，防止改动动了原路径）。 */
  function legacy(zoom: number, view?: Mat4): Mat4 {
    const { width, height } = general;
    const focal = 1 / Math.tan(general.perspectiveOverrideFov / 2);
    const d = (height / (2 * zoom)) * focal;
    const far = Math.max(15000, d + 1000);
    const projection = new Float32Array(16);
    projection[0] = (focal * height) / width;
    projection[5] = focal;
    projection[10] = 5 / (far - 5);
    projection[11] = -1;
    projection[14] = (far * 5) / (far - 5);
    if (!view) return multiply(projection, translation(-width / 2, -height / 2, -d));
    const moved = new Float32Array(view);
    moved[12] = view[12] - width / 2;
    moved[13] = view[13] - height / 2;
    moved[14] = -d;
    return multiply(projection, moved);
  }

  it("不给 crop 时逐字节同以前（含 zoom 与相机视图）", () => {
    expect([...particleViewProjection(general)]).toEqual([...legacy(1)]);
    expect([...particleViewProjection(general, 1.5)]).toEqual([...legacy(1.5)]);
    const view = translation(30, -20, 0);
    expect([...particleViewProjection(general, 0.8, view)]).toEqual([...legacy(0.8, view)]);
    expect([...particleViewProjection(general, 1, undefined, undefined)]).toEqual([...legacy(1)]);
  });

  it("对称裁切（fill，窗口 1920×800）：zoom 1 时 z = 0 平面与裁切后的正交画面重合", () => {
    const edges = alignEdges(0, 1920, 1080, 1920, 800);
    const ortho = sceneViewProjection(general, 1, edges);
    const persp = particleViewProjection(general, 1, undefined, { edges, window: [1920, 800] });
    for (const [x, y] of [
      [960, 540],
      [0, 140],
      [1920, 940],
      [300, 700],
      [1500, 250],
    ]) {
      const a = ndc(ortho, x, y);
      const b = ndc(persp, x, y);
      expect(b[0]).toBeCloseTo(a[0], 4);
      expect(b[1]).toBeCloseTo(a[1], 4);
    }
    // 可见区的四角落在 NDC 的 ±1
    expect(ndc(persp, 0, 140)[1]).toBeCloseTo(-1, 4);
    expect(ndc(persp, 1920, 940)[1]).toBeCloseTo(1, 4);
  });

  it("对称裁切带 zoom：绕场景中心缩放，z = 0 平面仍与正交画面重合", () => {
    const edges = alignEdges(0, 1920, 1080, 1440, 1080);
    const ortho = sceneViewProjection(general, 1.5, edges);
    const persp = particleViewProjection(general, 1.5, undefined, { edges, window: [1440, 1080] });
    for (const [x, y] of [
      [960, 540],
      [400, 300],
      [1500, 800],
    ]) {
      const a = ndc(ortho, x, y);
      const b = ndc(persp, x, y);
      expect(b[0]).toBeCloseTo(a[0], 4);
      expect(b[1]).toBeCloseTo(a[1], 4);
    }
  });

  it("fit（留白，E 为负）与 center 同样重合；宽高比取窗口、相机在可见区中心", () => {
    for (const [mode, window] of [
      [1, [1920, 800]],
      [3, [1280, 720]],
      [3, [2560, 1440]],
    ] as const) {
      const edges = alignEdges(mode, 1920, 1080, window[0], window[1]);
      const ortho = sceneViewProjection(general, 1, edges);
      const persp = particleViewProjection(general, 1, undefined, { edges, window });
      for (const [x, y] of [
        [960, 540],
        [100, 100],
        [1800, 900],
      ]) {
        const a = ndc(ortho, x, y);
        const b = ndc(persp, x, y);
        expect(b[0], `${mode} ${window}`).toBeCloseTo(a[0], 4);
        expect(b[1], `${mode} ${window}`).toBeCloseTo(a[1], 4);
      }
    }
  });

  it("边距为 0 且窗口 = 场景时与不裁切的结果在 f32 误差内相同", () => {
    const crop = { edges: [0, 0, 0, 0] as const, window: [1920, 1080] as const };
    const a = particleViewProjection(general);
    const b = particleViewProjection(general, 1, undefined, crop);
    // 平移列的量级是上千，按相对误差比
    for (let i = 0; i < 16; i++) expect(Math.abs(b[i] - a[i])).toBeLessThanOrEqual(2e-6 * Math.max(1, Math.abs(a[i])));
  });

  it("带相机视图时平移列换成 (V − 可见区中心, −d)，旋转部分不变", () => {
    const edges = alignEdges(0, 1920, 1080, 1920, 800);
    const view = translation(10, -20, 0);
    const withView = particleViewProjection(general, 1, view, { edges, window: [1920, 800] });
    const without = particleViewProjection(general, 1, undefined, { edges, window: [1920, 800] });
    // 视图多出 (10, −20) 的平移：z = 0 平面上 NDC 随之平移 10、−20 个场景单位对应的量
    const a = ndc(without, 960, 540);
    const b = ndc(withView, 960, 540);
    expect(b[0] - a[0]).toBeCloseTo((10 * 2) / 1920, 4);
    expect(b[1] - a[1]).toBeCloseTo((-20 * 2) / 800, 4);
  });
});

// ———— GpuScene：按指定尺寸建场景目标、主目标清屏色（假设备，写法同 p5b-fullscreen.test.ts） ————

interface Recorded {
  textures: { label: string; width: number; height: number }[];
  /** 每个 beginRenderPass 的第一个附件：目标 label、loadOp、clearValue。 */
  passes: { label: string; loadOp: string; clearValue?: { r: number; g: number; b: number; a: number } }[];
}

function fakeDevice(): { device: GPUDevice; recorded: Recorded } {
  const recorded: Recorded = { textures: [], passes: [] };
  const renderPass = {
    setViewport() {},
    setPipeline() {},
    setBindGroup() {},
    setVertexBuffer() {},
    setIndexBuffer() {},
    draw() {},
    drawIndexed() {},
    end() {},
  };
  const device = {
    limits: { maxTextureDimension2D: 8192 },
    lost: new Promise(() => {}),
    destroy() {},
    createTexture: (d: GPUTextureDescriptor) => {
      const size = d.size as { width: number; height: number };
      recorded.textures.push({ label: d.label ?? "", width: size.width, height: size.height });
      return {
        label: d.label ?? "",
        format: d.format,
        usage: d.usage,
        createView: () => ({ label: d.label ?? "" }),
        destroy() {},
      };
    },
    createSampler: () => ({}),
    createBuffer: (d: GPUBufferDescriptor) => ({ label: d.label ?? "", bytes: new Uint8Array(d.size), destroy() {} }),
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createRenderPipelineAsync: async (d: GPURenderPipelineDescriptor) => ({ label: d.label }),
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({
      beginRenderPass: (d: GPURenderPassDescriptor) => {
        const attachment = [...d.colorAttachments][0]!;
        const { label } = attachment.view as unknown as { label: string };
        recorded.passes.push({
          label,
          loadOp: attachment.loadOp as string,
          clearValue: attachment.clearValue as Recorded["passes"][number]["clearValue"],
        });
        return renderPass;
      },
      copyTextureToTexture() {},
      copyTextureToBuffer() {},
      finish: () => ({}),
    }),
    queue: {
      writeBuffer: (buffer: { bytes: Uint8Array }, offset: number, data: ArrayBuffer) => {
        buffer.bytes.set(new Uint8Array(data), offset);
      },
      writeTexture() {},
      submit() {},
      onSubmittedWorkDone: async () => {},
    },
    pushErrorScope() {},
    popErrorScope: async () => null,
  } as unknown as GPUDevice;
  return { device, recorded };
}

const SCENE_W = 1920;
const SCENE_H = 1080;
const CLEAR_COLOR = [0.25, 0.5, 0.75] as const;

function sceneBundle(): SceneBundle {
  const mat4 = (name: string, offset: number) => ({ name, type: "mat4x4<f32>", declared: "mat4", offset, size: 64 });
  const program = {
    ok: true,
    vertex: { wgsl: "// v", entryPoint: "main" },
    fragment: { wgsl: "// f", entryPoint: "main" },
    attributes: [
      { name: "a_Position", type: "vec3", location: 0 },
      { name: "a_TexCoord", type: "vec2", location: 1 },
    ],
    uniforms: [mat4("g_ModelViewProjectionMatrix", 0), mat4("g_ViewProjectionMatrix", 64)],
    uniformBlockSize: 128,
    textures: [{ slot: 0, binding: 1, samplerBinding: 2, kind: "2d" }],
  } as unknown as TranslateResult;
  const layer = {
    id: 1,
    object: 0,
    parent: null,
    name: "L",
    origin: [960, 540, 0],
    scale: [1, 1, 1],
    angles: [0, 0, 0],
    size: [1920, 1080],
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
    passes: [
      {
        key: "objects/0/passes/0",
        program: 0,
        blending: "translucent",
        cullmode: "nocull",
        depthtest: "disabled",
        depthwrite: "disabled",
        textures: { 0: 0 },
        runtime: {},
        uniforms: {},
        framebuffer: false,
      },
    ],
    colorBlendMode: 0,
    effects: [],
    passthrough: null,
    particle: null,
  } as unknown as SceneLayer;
  return {
    general: {
      width: SCENE_W,
      height: SCENE_H,
      fields: { ...generalDefaults(), clearcolor: [...CLEAR_COLOR] },
      clearVariable: false,
      perspectiveOverrideFov: particleFov(undefined),
      postprocess: { level: "disabled", bloomFlag: false, hdrFlag: false, bloom: false, hdr: false },
      bloom: { ...BLOOM_DEFAULTS, tint: [1, 1, 1] },
    },
    layers: [layer],
    programs: [program],
    textures: [
      {
        path: "t",
        source: "",
        format: 0,
        width: 4,
        height: 4,
        textureWidth: 4,
        textureHeight: 4,
        flags: 0,
        clampUVs: true,
        noInterpolation: false,
        mips: [{ width: 4, height: 4, bytes: new Uint8Array(64) }],
      },
    ],
    bloom: null,
    unsupported: [],
    bindings: [],
    scripts: { list: [] },
  } as unknown as SceneBundle;
}

const FRAME: FrameInput = {
  time: 1,
  frametime: 0.05,
  daytime: 0.5,
  pointer: [0.5, 0.5],
  pointerLast: [0.5, 0.5],
  cursor: [0.5, 0.5],
};

type Target = {
  size: [number, number];
  edges: [number, number, number, number];
  clear: [number, number, number] | null;
};

/** 建场景、编码一帧；返回场景目标的尺寸与主场景 pass 的清屏。 */
async function encodeOne(target?: Target) {
  const { device, recorded } = fakeDevice();
  const bundle = sceneBundle();
  const state = SceneState.fromBundle(bundle);
  const scene = await GpuScene.build(device, bundle, state, new Set(), [], {
    ignoreUnsupported: true,
    particles: { seed: 1 },
    ...(target ? { target } : {}),
  });
  scene.update(FRAME, state);
  scene.encode(device.createCommandEncoder(), state);
  const sceneTarget = recorded.textures.find((t) => t.label === "scene target")!;
  const pass = recorded.passes.find((p) => p.label === "scene target")!;
  scene.destroy();
  return { sceneTarget, pass };
}

describe("GpuScene.build 的 target：场景目标尺寸与主目标清屏色", () => {
  beforeEach(() => {
    vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2, COPY_SRC: 4, COPY_DST: 8 });
    vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, UNIFORM: 2, COPY_DST: 4, MAP_READ: 8, INDEX: 16 });
    vi.stubGlobal("GPUMapMode", { READ: 1 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("不给 target：场景目标仍是场景尺寸，清成 clearcolor", async () => {
    const { sceneTarget, pass } = await encodeOne();
    expect([sceneTarget.width, sceneTarget.height]).toEqual([SCENE_W, SCENE_H]);
    expect(pass.loadOp).toBe("clear");
    expect(pass.clearValue).toEqual({ r: CLEAR_COLOR[0], g: CLEAR_COLOR[1], b: CLEAR_COLOR[2], a: 1 });
  });

  it("target.clear 非空（fit，schemecolor）：场景目标 = size，主 pass 清成它而不是 clearcolor", async () => {
    const { sceneTarget, pass } = await encodeOne({
      size: [1280, 720],
      edges: alignEdges(1, SCENE_W, SCENE_H, 1280, 720),
      clear: [0, 0, 0.6],
    });
    expect([sceneTarget.width, sceneTarget.height]).toEqual([1280, 720]);
    expect(pass.loadOp).toBe("clear");
    expect(pass.clearValue).toEqual({ r: 0, g: 0, b: 0.6, a: 1 });
  });

  it("target.clear 为 null（fill / stretch）：清成 clearcolor", async () => {
    const { sceneTarget, pass } = await encodeOne({
      size: [1280, 720],
      edges: alignEdges(0, SCENE_W, SCENE_H, 1280, 720),
      clear: null,
    });
    expect([sceneTarget.width, sceneTarget.height]).toEqual([1280, 720]);
    expect(pass.clearValue).toEqual({ r: CLEAR_COLOR[0], g: CLEAR_COLOR[1], b: CLEAR_COLOR[2], a: 1 });
  });

  it("宽高不等的窗口分得出宽高对调：1280×720 与 720×1280", async () => {
    for (const size of [
      [1280, 720],
      [720, 1280],
    ] as const) {
      const { sceneTarget } = await encodeOne({
        size: [size[0], size[1]],
        edges: alignEdges(0, SCENE_W, SCENE_H, size[0], size[1]),
        clear: null,
      });
      expect([sceneTarget.width, sceneTarget.height]).toEqual([size[0], size[1]]);
    }
  });

  it("超过设备纹理上限时报错、不缩", async () => {
    await expect(encodeOne({ size: [9000, 720], edges: [0, 0, 0, 0], clear: null })).rejects.toThrow(
      /render:target-size/,
    );
  });
});
