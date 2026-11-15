/**
 * P12b2-1 点 4：模型对象的骨骼运行时（`ScenePuppets` 的 `"model"` 模式，`.claude/plans/wpe-import/3-scene/phase12/phase-12b2-texchan-model.md`）。
 *
 * 样本 `fixtures/p12b2-*.json`（生成脚本 `ignore/p12/b2/impl/mkfix_model.py`，WPE 抓帧 `ignore/p12/b2/gen/out`，实测报告 `ignore/p12/b2/meas/report.txt`）：
 * - `p12b2-mdl` / `p12b2-mdl2`：覆盖、混合、加法、权重 0 的层、全部为 0、只有隐藏的层、静止姿势动画、没有层、17 根 / 3 根骨骼（`BONECOUNT`）。
 *   按日志 dt 从第 1 帧推进，`g_Bones` 和 WPE 比：容差 5 ulp 或绝对差 2e-6（二者取宽，差来自 `rsqrtps` 的硬件近似，同 `player.test.ts`）；
 *   模型与同 mdl 同动画层的图像层 puppet 在覆盖 / 混合 / 加法下逐位相同；权重 0 的层整层跳过（与去掉它逐位相同），图像层不跳过。
 * - `p12b2-vis`：模型自己或父链隐藏时时钟冻结（看上一帧脚本写下的可见性），图像层 puppet 照常推进；`g_Bones` 对 WPE。
 * - `p12b2-morph`：变形 uniform 的 `g_MorphOffsets` / `g_MorphWeights` 对 WPE（覆盖不钳制、混合钳 [0, 1]、加法夹在 [min, max]、前 11 个生效目标再按权重排序）。
 *   **两处 WPE 缺陷不照抄**（决定 1，2026-11-15）：偏移按各网格自己的顶点数、缩放与权重按真实网格下标取——`mo_two`、`mo_sort` 断言「正确做法」的值，注释里写明 WPE 的值。
 * - `p12b2-rest`：静止姿势只用 `MDLS` 局部矩阵（mdl 带可选骨骼矩阵也不读）。
 * - `p12b2-cull`：剔除盒取可见层动画包围盒的并，WPE 画没画对视锥剔除结果。
 * - `p12b2-att`：挂点用的模型空间骨骼矩阵（`pose`）与图像层逐位相同。
 */
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { isOpaqueBlending } from "../compile/bundle";
import { meshDrawOrder, parseMdl, type MdlFile } from "../compile/mdl";
import { buildModelSkeleton, buildPuppet, type ModelSkeleton } from "../compile/puppet";
import { frustumCulled } from "../render/mesh";
import { sceneViewProjection } from "../render/layout";
import { translation } from "../render/math";
import att from "./fixtures/p12b2-att.json";
import cull from "./fixtures/p12b2-cull.json";
import mdl from "./fixtures/p12b2-mdl.json";
import mdl2 from "./fixtures/p12b2-mdl2.json";
import morph from "./fixtures/p12b2-morph.json";
import rest from "./fixtures/p12b2-rest.json";
import vis from "./fixtures/p12b2-vis.json";
import { puppetEntries, ScenePuppets, type PuppetLayerFields, type PuppetSink } from "./player";
import { blendModelMorphWeights, blendMorphWeights } from "./pose";

interface Draw {
  bones: number[];
  offsets?: number[];
  weights?: number[];
  res?: number[];
}
interface FixtureObject {
  name: string;
  object: number;
  path: string;
  layers: unknown[];
  bones: number;
  origin: number[];
  draws: Record<string, Draw[]>;
  texels?: number[];
}
interface Fixture {
  dt: number[];
  runtime: number[];
  frames: number[];
  mdls: Record<string, string>;
  objects: FixtureObject[];
}

const mdlBytes = (text: string) => new Uint8Array(gunzipSync(Buffer.from(text, "base64")));

interface Loaded {
  object: FixtureObject;
  file: MdlFile;
  skeleton: ModelSkeleton;
}

function load(fixture: Fixture, object: FixtureObject): Loaded {
  const file = parseMdl(mdlBytes(fixture.mdls[object.path]));
  const built = buildModelSkeleton(file, object.layers, {}, {});
  expect([...built.issues], object.name).toEqual([]);
  expect(built.skeleton, object.name).not.toBeNull();
  return { object, file, skeleton: built.skeleton! };
}

const loadAll = (fixture: Fixture) => fixture.objects.map((object) => load(fixture, object));
const modelEntries = (items: Loaded[]) =>
  items.map(({ object, skeleton }) => ({ object: object.object, puppet: skeleton, kind: "model" as const }));

const bitsF = new Float32Array(1);
const bitsI = new Int32Array(bitsF.buffer);
/** float32 的有序整数（+0 与 −0 都是 0），相减就是相差几个 ulp。 */
function ordered(value: number): number {
  bitsF[0] = value;
  const i = bitsI[0];
  return i < 0 ? -(i & 0x7fffffff) : i;
}

/** 模型空间骨骼矩阵里最大的绝对值：`K = B · 逆绑定` 的中间量大小，蒙皮矩阵的舍入误差随它放大（这几个工程的平移到 270 左右）。 */
function poseScale(puppets: ScenePuppets, object: number): number {
  return Math.max(1, ...Array.from(puppets.pose(object)!, Math.abs));
}

/** 全部比较里「绝对差 / 中间量大小」的最大值（`worst` 在最后打印，调容差用）。 */
const worst = { ratio: 0, label: "" };

/**
 * 单个数的容差：5 ulp 或 2e-6（同 `player.test.ts`），再放宽到中间量大小的 2e-6 倍（`scale × 2e-6`）：`K` 的元素是几十到几百量级的 `B` 与逆绑定相乘后相消得到的小数，
 * `rsqrtps` 的硬件近似（四元数归一化，各家 CPU 的近似值不同）与 float32 舍入在中间量上就是这个量级（实测最大约 1e-6 倍）；层级、权重、顺序这类逻辑错误的差
 * 是 1e-2 量级以上（比如图像层不跳过权重 0 的层是 0.018），不会被它放过。
 */
function expectClose(got: ArrayLike<number>, want: readonly number[], label: string, scale = 1): void {
  expect(got.length >= want.length, `${label}：长度`).toBe(true);
  const tolerance = Math.max(2e-6, 2e-6 * scale);
  for (let i = 0; i < want.length; i++) {
    const ratio = Math.abs(got[i] - Math.fround(want[i])) / scale;
    if (ratio > worst.ratio) {
      worst.ratio = ratio;
      worst.label = `${label} [${i}]`;
    }
  }
  for (let i = 0; i < want.length; i++) {
    const ref = Math.fround(want[i]);
    const abs = Math.abs(got[i] - ref);
    const ulp = Math.abs(ordered(got[i]) - ordered(ref));
    if (ulp > 5 && abs > tolerance)
      expect.fail(`${label} [${i}]：得到 ${got[i]}，WPE ${ref}，差 ${abs}（${ulp} ulp，容差 ${tolerance}）`);
  }
}

/** 两份数组逐位相同（−0 与 +0 视为不同）。 */
function expectSameBits(a: ArrayLike<number>, b: ArrayLike<number>, label: string): void {
  expect(a.length, label).toBe(b.length);
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) expect.fail(`${label} [${i}]：${a[i]} ≠ ${b[i]}`);
}

/** 按日志的 dt 从第 1 帧推进，每个想要的帧后回调一次。 */
function replay(
  fixture: Fixture,
  puppets: ScenePuppets,
  at: (frame: number) => void,
  sink: (frame: number) => PuppetSink | undefined = () => undefined,
): void {
  const last = fixture.frames[fixture.frames.length - 1];
  const wanted = new Set(fixture.frames);
  for (let k = 1; k <= last; k++) {
    puppets.frame(fixture.dt[k - 1], sink(k));
    if (wanted.has(k)) at(k);
  }
}

// ———— g_Bones 对 WPE ————

describe.each([
  ["p12b2-mdl", mdl],
  ["p12b2-mdl2", mdl2],
  ["p12b2-rest", rest],
] as [string, Fixture][])("模型的 g_Bones 逐帧对 WPE：%s", (name, fixture) => {
  it("从第 1 帧起按日志的 dt 推进，≤ 5 ulp 或 ≤ 2e-6", () => {
    const items = loadAll(fixture);
    const puppets = new ScenePuppets(modelEntries(items));
    let compared = 0;
    replay(fixture, puppets, (k) => {
      for (const { object } of items) {
        const draw = object.draws[String(k)]?.[0];
        if (!draw) continue;
        expectClose(
          puppets.skin(object.object)!,
          draw.bones,
          `${name} ${object.name} 帧 ${k}`,
          poseScale(puppets, object.object),
        );
        compared++;
      }
    });
    // 每个模型每个想要的帧都有绘制
    expect(compared).toBe(items.length * fixture.frames.length);
  });
});

afterAll(() => {
  console.log(`[p12b2-model] g_Bones 对 WPE：最大绝对差 / 中间量 = ${worst.ratio.toExponential(2)}（${worst.label}）`);
});

describe("p12b2-mdl：模型与图像层 puppet", () => {
  const items = loadAll(mdl as Fixture);
  const byName = new Map(items.map((item) => [item.object.name, item]));

  /** 同 mdl、同动画层的图像层 puppet（`kind: "image"`），对象号换成 1000 + 原号。 */
  function imageTwins(names: string[]): {
    entries: { object: number; puppet: ReturnType<typeof twin>; kind: "image" }[];
  } {
    return {
      entries: names.map((name) => {
        const { object, file } = byName.get(name)!;
        return { object: 1000 + object.object, puppet: twin(file, object), kind: "image" as const };
      }),
    };
  }
  function twin(file: MdlFile, object: FixtureObject) {
    const built = buildPuppet(file, object.layers, object.path);
    expect([...built.issues], object.name).toEqual([]);
    return built.puppet!;
  }

  it("覆盖、混合、加法：模型与图像层的 g_Bones 逐帧逐位相同（p12b2-mdl 实测：同一套采样 / 混合 / 加法 / 父链 / 蒙皮）", () => {
    const names = ["M_ovr", "M_mix", "M_add"];
    const puppets = new ScenePuppets([
      ...modelEntries(names.map((name) => byName.get(name)!)),
      ...imageTwins(names).entries,
    ]);
    let checked = 0;
    for (let k = 1; k <= (mdl as Fixture).frames[(mdl as Fixture).frames.length - 1]; k++) {
      puppets.frame((mdl as Fixture).dt[k - 1]);
      for (const name of names) {
        const { object } = byName.get(name)!;
        expectSameBits(puppets.skin(object.object)!, puppets.skin(1000 + object.object)!, `${name} 帧 ${k}`);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("权重 0 的层整层跳过、不算「已有层」：全部为 0 与没有层逐位相同（走 MDLS 局部矩阵，不经分解）；只有 visible 假的层也一样", () => {
    const puppets = new ScenePuppets(modelEntries(items));
    const id = (name: string) => byName.get(name)!.object.object;
    let different = 0;
    for (let k = 1; k <= 12; k++) {
      puppets.frame((mdl as Fixture).dt[k - 1]);
      const none = puppets.skin(id("M_nolayer"))!;
      expectSameBits(puppets.skin(id("M_allw0"))!, none, `M_allw0 帧 ${k}`);
      expectSameBits(puppets.skin(id("M_hidlayer"))!, none, `M_hidlayer 帧 ${k}`);
      // 对照：静止姿势动画（覆盖）要经分解，和没有层不同（最大 1.1e-5）
      const rested = puppets.skin(id("M_rest1"))!;
      if (!rested.every((value, i) => Object.is(value, none[i]))) different++;
    }
    expect(different).toBeGreaterThan(0);
  });

  it("p12b2-mdl2：带 0 权重层的与去掉它的逐位相同（模型）；图像层不跳过，结果不同", () => {
    const fixture = mdl2 as Fixture;
    const second = loadAll(fixture);
    const named = new Map(second.map((item) => [item.object.name, item]));
    const pairs: [string, string][] = [
      ["M_w0first", "M_bonly"],
      ["M_w0mid", "M_ac"],
      ["M_w0addfirst", "M_ovr"],
    ];
    const images = ["M_w0first", "M_bonly"].map((name, i) => ({
      object: 2000 + i,
      puppet: twin(named.get(name)!.file, named.get(name)!.object),
      kind: "image" as const,
    }));
    const puppets = new ScenePuppets([...modelEntries(second), ...images]);
    let imageDiffers = 0;
    for (let k = 1; k <= fixture.frames[fixture.frames.length - 1]; k++) {
      puppets.frame(fixture.dt[k - 1]);
      for (const [a, b] of pairs)
        expectSameBits(
          puppets.skin(named.get(a)!.object.object)!,
          puppets.skin(named.get(b)!.object.object)!,
          `${a} / ${b} 帧 ${k}`,
        );
      const [x, y] = [puppets.skin(2000)!, puppets.skin(2001)!];
      if (!x.every((value, i) => Object.is(value, y[i]))) imageDiffers++;
    }
    // p12b2-mdl 实测：P[A 权重 0, B 0.5] 与 P[B 0.5] 22/48 个 float 不同、最大 0.0182
    expect(imageDiffers).toBeGreaterThan(0);
  });

  it("BONECOUNT 与骨骼数：蒙皮矩阵只有真实骨骼数（17 根 → 17 × 12 个 float；组合键取 2 的幂在编译侧）", () => {
    const puppets = new ScenePuppets(modelEntries(items));
    puppets.frame(0.05);
    expect(puppets.skin(byName.get("M_b17")!.object.object)!.length).toBe(17 * 12);
    expect(puppets.skin(byName.get("M_b3")!.object.object)!.length).toBe(3 * 12);
  });
});

// ———— 隐藏冻结 ————

describe("p12b2-vis：模型隐藏时时钟冻结（rea-texchan-model 4，p12b2-vis 实测）", () => {
  const fixture = vis as Fixture;
  const items = loadAll(fixture);
  const byName = new Map(items.map((item) => [item.object.name, item]));
  const ids = {
    ref: byName.get("M_ref")!.object.object,
    hide: byName.get("M_hide")!.object.object,
    child: byName.get("M_child")!.object.object,
  };

  /**
   * 脚本 `visible: !(runtime % 3 ∈ [1, 2))` 在每帧更新之后写：第 f 帧的更新看到的是第 f−1 帧脚本写下的可见性（初值 true）。
   * M_child 的父对象用同一个脚本，所以父链不可见时它同样不可见。
   */
  function sinkFor(): { sink: (frame: number) => PuppetSink; after: (frame: number) => void } {
    let visible = true;
    return {
      sink: () => ({
        animationLayer: () => undefined as PuppetLayerFields | undefined,
        visible: (object) => (object === ids.ref ? true : visible),
      }),
      after: (frame) => {
        const t = fixture.runtime[frame - 1] % 3;
        visible = !(t >= 1 && t < 2);
      },
    };
  }

  it("g_Bones 对 WPE：隐藏的帧没有绘制；重新可见的第一帧画的是隐藏前的姿势（那一帧的更新已被跳过）", () => {
    const puppets = new ScenePuppets(modelEntries(items));
    const { sink, after } = sinkFor();
    let hiddenFrames = 0;
    let compared = 0;
    const wanted = new Set(fixture.frames);
    for (let k = 1; k <= fixture.frames[fixture.frames.length - 1]; k++) {
      puppets.frame(fixture.dt[k - 1], sink(k));
      after(k);
      if (!wanted.has(k)) continue;
      for (const { object } of items) {
        const draw = object.draws[String(k)]?.[0];
        if (!draw) {
          hiddenFrames++;
          continue;
        }
        expectClose(
          puppets.skin(object.object)!,
          draw.bones,
          `${object.name} 帧 ${k}`,
          poseScale(puppets, object.object),
        );
        compared++;
      }
    }
    expect(hiddenFrames).toBeGreaterThan(0);
    expect(compared).toBeGreaterThan(50);
  });

  it("M_hide 与 M_child 每帧完全相同（父链不可见也冻结）；图像层 puppet 用同一个 sink 照常推进，和一直可见的逐位相同", () => {
    const file = byName.get("M_ref")!.file;
    const image = buildPuppet(file, byName.get("M_ref")!.object.layers, "models/rig4.mdl").puppet!;
    const puppets = new ScenePuppets([
      ...modelEntries(items),
      { object: 100, puppet: image, kind: "image" },
      { object: 101, puppet: image, kind: "image" },
    ]);
    const { sink, after } = sinkFor();
    let frozen = 0;
    for (let k = 1; k <= fixture.frames[fixture.frames.length - 1]; k++) {
      // 图像层 101 用「被隐藏的」sink 也不看可见性（隐藏照推进，rea-RT 2）
      puppets.frame(fixture.dt[k - 1], sink(k));
      after(k);
      expectSameBits(puppets.skin(ids.hide)!, puppets.skin(ids.child)!, `M_hide / M_child 帧 ${k}`);
      expectSameBits(puppets.skin(100)!, puppets.skin(101)!, `图像层 帧 ${k}`);
      // 图像层不冻结：和一直可见的模型逐位相同
      expectSameBits(puppets.skin(100)!, puppets.skin(ids.ref)!, `图像层 / M_ref 帧 ${k}`);
      if (!puppets.skin(ids.hide)!.every((value, i) => Object.is(value, puppets.skin(ids.ref)![i]))) frozen++;
    }
    expect(frozen).toBeGreaterThan(0);
  });

  it("没有 visible 方法的 sink 或 refresh 不做门（建场景、探针 seek 是按当前时钟重算，不是 WPE 的更新）", () => {
    const puppets = new ScenePuppets(modelEntries(items));
    const hidden: PuppetSink = { animationLayer: () => undefined, visible: () => false };
    puppets.frame(0.05, hidden);
    const frozen = Float32Array.from(puppets.skin(ids.hide)!);
    puppets.frame(0.05); // 没有 sink：不看可见性
    expect(Array.from(puppets.skin(ids.hide)!)).not.toEqual(Array.from(frozen));
    const moved = Float32Array.from(puppets.skin(ids.hide)!);
    puppets.frame(0.05, hidden);
    expectSameBits(puppets.skin(ids.hide)!, moved, "隐藏的帧不动");
    puppets.refresh(hidden);
    expectSameBits(puppets.skin(ids.hide)!, moved, "refresh 按当前时钟重算，结果不变");
  });
});

// ———— 变形 ————

describe("p12b2-morph：变形 uniform", () => {
  const fixture = morph as Fixture;
  const items = loadAll(fixture);
  const orders = new Map(
    items.map(({ object, file }) => [
      object.name,
      // 材质 `white_tr.json` 是 translucent，其余 normal：不透明在前（`meshDrawOrder`，MSVC std::sort）
      meshDrawOrder(
        file.meshes.map((mesh) =>
          isOpaqueBlending(mesh.materials[0].endsWith("white_tr.json") ? "translucent" : "normal"),
        ),
      ),
    ]),
  );
  /** WPE 的两处缺陷在这两个对象上表现（决定 1）：不照抄，断言正确做法。 */
  const DEFECTS = new Set(["mo_two", "mo_sort"]);

  it("除缺陷外的对象：每个网格每次绘制的 g_MorphOffsets[0..个数] 与 g_MorphWeights[0..个数] 都和 WPE 相同；纹理边长相同", () => {
    const puppets = new ScenePuppets(modelEntries(items));
    let compared = 0;
    replay(fixture, puppets, (k) => {
      for (const { object, skeleton } of items) {
        if (DEFECTS.has(object.name)) continue;
        const draws = object.draws[String(k)];
        expect(draws, `${object.name} 帧 ${k}`).toBeDefined();
        draws.forEach((draw, d) => {
          const mesh = orders.get(object.name)![d];
          const got = puppets.morph(object.object, mesh)!;
          const count = draw.offsets![0];
          const label = `${object.name} 帧 ${k} 绘制 ${d}`;
          expect(Array.from(got.offsets.subarray(0, 1 + count)), label).toEqual(draw.offsets!.slice(0, 1 + count));
          expectSameBits(
            got.weights.subarray(0, 1 + count),
            Float32Array.from(draw.weights!.slice(0, 1 + count)),
            label,
          );
          // 余下的槽：WPE 的偏移不清（留着上一次的值）、权重清 0；我们都清成 0，没人读
          expect(
            Array.from(got.weights.subarray(1 + count)).every((value) => value === 0),
            label,
          ).toBe(true);
          expect(draw.res![0], label).toBe(skeleton.morphs[mesh]!.side);
          compared++;
        });
      }
    });
    expect(compared).toBeGreaterThan(40);
  });

  it("缺陷 1（偏移用最后一个变形网格的顶点数）：mo_two 网格 0 有 8 个顶点，偏移是 目标号 × 8 = [2, 8, 16]；WPE 是 [2, 4, 8]（× 4，网格 1 的）", () => {
    const { object } = items.find((item) => item.object.name === "mo_two")!;
    const puppets = new ScenePuppets(modelEntries(items));
    replay(fixture, puppets, (k) => {
      const [first, second] = object.draws[String(k)];
      // WPE：两个网格的绘制顺序 0、1（都不透明）；网格 0 的偏移按最后一个变形网格的顶点数 4
      expect(first.offsets!.slice(0, 3)).toEqual([2, 4, 8]);
      const mesh0 = puppets.morph(object.object, 0)!;
      const mesh1 = puppets.morph(object.object, 1)!;
      expect(Array.from(mesh0.offsets.subarray(0, 3))).toEqual([2, 8, 16]);
      expectSameBits(
        mesh0.weights.subarray(0, 3),
        Float32Array.from(first.weights!.slice(0, 3)),
        `帧 ${k} 网格 0 权重`,
      );
      // 网格 1（4 个顶点）与 WPE 一致：按自己的顶点数 4，目标 1（0.9）在前、目标 0（0.5）在后
      expect(Array.from(mesh1.offsets.subarray(0, 3))).toEqual([2, 4, 0]);
      expect(Array.from(mesh1.offsets.subarray(0, 3))).toEqual(second.offsets!.slice(0, 3));
      expectSameBits(
        mesh1.weights.subarray(0, 3),
        Float32Array.from(second.weights!.slice(0, 3)),
        `帧 ${k} 网格 1 权重`,
      );
    });
  });

  it("缺陷 2（缩放与权重按排序后的记录下标取）：mo_sort 网格 0 半透明排在后面；每个网格取自己的缩放与权重（WPE 的第一次绘制用了网格 0 的）", () => {
    const { object } = items.find((item) => item.object.name === "mo_sort")!;
    expect(orders.get("mo_sort")).toEqual([1, 0]);
    const puppets = new ScenePuppets(modelEntries(items));
    replay(fixture, puppets, (k) => {
      // WPE 的两次绘制：第一次画网格 1 的几何，用了网格 0 的缩放 40 与权重（0.75、0.25）；第二次画网格 0 的几何，用了网格 1 的 25 与（0.6、0.1）
      const [wpeFirst, wpeSecond] = object.draws[String(k)];
      expect(wpeFirst.weights![0]).toBe(40);
      expect(wpeSecond.weights![0]).toBe(25);
      // 正确做法：网格 1（不透明，缩放 25，目标 0 = 0.6、目标 1 = 0.1）与网格 0（半透明，缩放 40，目标 1 = 0.75、目标 0 = 0.25）——
      // 恰好是 WPE 两次绘制的值互换
      const mesh1 = puppets.morph(object.object, 1)!;
      const mesh0 = puppets.morph(object.object, 0)!;
      expect(Array.from(mesh1.offsets.subarray(0, 3))).toEqual(wpeSecond.offsets!.slice(0, 3));
      expectSameBits(mesh1.weights.subarray(0, 3), Float32Array.from(wpeSecond.weights!.slice(0, 3)), `帧 ${k} 网格 1`);
      expect(Array.from(mesh0.offsets.subarray(0, 3))).toEqual(wpeFirst.offsets!.slice(0, 3));
      expectSameBits(mesh0.weights.subarray(0, 3), Float32Array.from(wpeFirst.weights!.slice(0, 3)), `帧 ${k} 网格 0`);
    });
  });

  it("morph(object) 不给网格号时模型返回 null；没有变形目标的网格与不是模型的对象为 null", () => {
    const puppets = new ScenePuppets(modelEntries(items));
    const id = items[0].object.object;
    expect(puppets.morph(id)).toBeNull();
    expect(puppets.morph(id, 9)).toBeNull();
    expect(puppets.morph(12345, 0)).toBeNull();
  });
});

// ———— 变形权重叠法（pose.ts） ————

describe("blendModelMorphWeights：p12b2-morph 的实测值", () => {
  const f = Math.fround;
  const track = (value: number) => Float32Array.from([value, value, value]);
  const run = (layers: { v: number[]; w: number; additive?: boolean }[], targets = layers[0].v.length) => {
    const weights = new Float32Array(targets);
    const active = new Uint8Array(targets);
    for (const { v, w, additive } of layers)
      blendModelMorphWeights(weights, active, v.map(track), 0, 1, 0.5, w, additive ?? false);
    return { weights: Array.from(weights), active: Array.from(active) };
  };

  it("覆盖不钳制：1.5、−0.3 原样；混合钳 [0, 1]：覆盖 (0.2, 1.5, 0.9) + 混合 0.5 (0.6, 1.5, −0.5) → (0.4, 1, 0.2)", () => {
    expect(run([{ v: [0.2, 1.5, -0.3], w: 1 }]).weights).toEqual([f(0.2), 1.5, f(-0.3)]);
    const mixed = run([
      { v: [0.2, 1.5, 0.9], w: 1 },
      { v: [0.6, 1.5, -0.5], w: 0.5 },
    ]);
    expect(mixed.weights[0]).toBeCloseTo(0.4, 6);
    expect(mixed.weights[1]).toBe(1);
    expect(mixed.weights[2]).toBeCloseTo(0.2, 6);
    // 图像层的混合不钳：同输入第二个目标是 1.5
    const weights = new Float32Array(3);
    const active = new Uint8Array(3);
    blendMorphWeights(weights, active, [0.2, 1.5, 0.9].map(track), 0, 1, 0.5, 1, false);
    blendMorphWeights(weights, active, [0.6, 1.5, -0.5].map(track), 0, 1, 0.5, 0.5, false);
    expect(weights[1]).toBe(1.5);
  });

  it("加法夹在 [min(cur, d), max(cur, d)]：覆盖 (0.4, −0.2, 0) + 加法 1.0 (0.3, 0.5, 0.6) → (0.4, 0.3, 0.6)，朴素相加会是 0.7", () => {
    const out = run([
      { v: [0.4, -0.2, 0], w: 1 },
      { v: [0.3, 0.5, 0.6], w: 1, additive: true },
    ]);
    expect(out.weights[0]).toBeCloseTo(0.4, 6);
    expect(out.weights[1]).toBeCloseTo(0.3, 6);
    expect(out.weights[2]).toBeCloseTo(0.6, 6);
    // 加法 0.5：(0.4, 0.05, 0.3)
    const half = run([
      { v: [0.4, -0.2, 0], w: 1 },
      { v: [0.3, 0.5, 0.6], w: 0.5, additive: true },
    ]);
    expect(half.weights[0]).toBeCloseTo(0.4, 6);
    expect(half.weights[1]).toBeCloseTo(0.05, 6);
    expect(half.weights[2]).toBeCloseTo(0.3, 6);
    // 只有加法 0.5：(0.15, 0.25, 0.3)
    const only = run([{ v: [0.3, 0.5, 0.6], w: 0.5, additive: true }]);
    expect(only.weights.map((value) => Math.round(value * 1e6) / 1e6)).toEqual([0.15, 0.25, 0.3]);
  });

  it("生效阈值 |v| > FLT_EPSILON：1e-8 不置位（覆盖时清位），恰为 FLT_EPSILON 也不置位（图像层 ≥ 置位）", () => {
    const eps = 2 ** -23;
    expect(run([{ v: [1e-8, 0.3], w: 1 }]).active).toEqual([0, 1]);
    expect(run([{ v: [eps, 0.3], w: 1 }]).active).toEqual([0, 1]);
    const weights = new Float32Array(1);
    const active = new Uint8Array(1);
    blendMorphWeights(weights, active, [track(eps)], 0, 1, 0.5, 1, false);
    expect(active[0]).toBe(1);
    // 混合从不清位；加法 |v| ≤ ε 整条跳过
    const mix = run([
      { v: [0.5], w: 1 },
      { v: [1e-8], w: 0.5 },
    ]);
    expect(mix.active).toEqual([1]);
    const add = run([{ v: [1e-8], w: 1, additive: true }]);
    expect(add).toEqual({ weights: [0], active: [0] });
  });
});

// ———— 剔除盒 ————

describe("p12b2-cull：剔除盒取可见层动画包围盒的并（rea-texchan-model 7.6，p12b2-cull 实测）", () => {
  const fixture = cull as Fixture;
  const items = loadAll(fixture);
  const vp = sceneViewProjection({ width: 1920, height: 1080 });

  it("WPE 画没画 = 用 ScenePuppets.bounds（没有就退回 mdl 包围盒）做外接球视锥剔除的结果", () => {
    const puppets = new ScenePuppets(modelEntries(items));
    const drawn: Record<string, boolean> = {};
    replay(fixture, puppets, (k) => {
      for (const { object, file } of items) {
        const world = translation(object.origin[0], object.origin[1], 0);
        const culled = frustumCulled(puppets.bounds(object.object) ?? file.bounds, world, vp);
        const present = object.draws[String(k)] !== undefined;
        expect(!culled, `${object.name} 帧 ${k}`).toBe(present);
        drawn[object.name] = present;
      }
    });
    // 网格盒在屏内、动画盒在屏外 → 不画；没有层 / 层不可见 → mdl 盒 → 画；层权重 0（可见层不看权重）→ 动画盒 → 不画
    expect(drawn).toEqual({
      cull_a: false,
      cull_a_nolayer: true,
      cull_a_hidlayer: true,
      cull_a_w0: false,
      cull_b: true,
      cull_ctrl: true,
    });
  });

  it("bounds：没有层或没有可见层为 null；可见层的并至少含原点（全 0 的盒子也并进去）；运行时改 visible 立刻跟上", () => {
    const [a] = items.filter((item) => item.object.name === "cull_a");
    const puppets = new ScenePuppets(modelEntries([a]));
    puppets.frame(0.05);
    expect(puppets.bounds(a.object.object)).toEqual([10, -10, -10, 50, 10, 10]);
    const hidden: PuppetSink = { animationLayer: () => ({ rate: 1, blend: 1, visible: false }) };
    puppets.frame(0.05, hidden);
    expect(puppets.bounds(a.object.object)).toBeNull();
    expect(puppets.bounds(999)).toBeNull();
  });
});

// ———— 挂点 ————

describe("p12b2-att：挂点用的模型空间骨骼矩阵（pose）", () => {
  const fixture = att as Fixture;
  const items = loadAll(fixture);

  it("g_Bones 对 WPE；pose 与同 mdl 的图像层逐位相同（绑定姿势或有层）；MDAT 三个挂点", () => {
    const images = items.map(({ object, file }, i) => ({
      object: 500 + i,
      puppet: buildPuppet(file, object.layers, object.path).puppet!,
      kind: "image" as const,
    }));
    const puppets = new ScenePuppets([...modelEntries(items), ...images]);
    // 没有层的模型一直是绑定姿势；加载时（第一帧之前）就有值
    items.forEach(({ object }, i) =>
      expectSameBits(puppets.pose(object.object)!, puppets.pose(500 + i)!, `${object.name} 加载时`),
    );
    replay(fixture, puppets, (k) => {
      items.forEach(({ object }, i) => {
        expectClose(
          puppets.skin(object.object)!,
          object.draws[String(k)][0].bones,
          `${object.name} 帧 ${k}`,
          poseScale(puppets, object.object),
        );
        expectSameBits(puppets.pose(object.object)!, puppets.pose(500 + i)!, `${object.name} pose 帧 ${k}`);
      });
    });
    expect(items[0].skeleton.attachments.map((item) => [item.name, item.bone])).toEqual([
      ["tipA", 1],
      ["tipB", 2],
      ["tipC", 3],
    ]);
  });
});

describe("puppetEntries", () => {
  it("图像层 puppet 与带骨骼的模型按图层顺序进运行时，别的图层不进", () => {
    const [first] = loadAll(mdl as Fixture);
    const image = buildPuppet(first.file, first.object.layers, first.object.path).puppet!;
    const entries = puppetEntries([
      { object: 0, puppet: null, model: null },
      { object: 1, puppet: { ...image, composite: false, passes: [], upload: null }, model: null },
      {
        object: 2,
        puppet: null,
        model: { path: "a", version: 23, meshes: [], order: [], bounds: [], skeleton: first.skeleton },
      },
      { object: 3, puppet: null, model: { path: "b", version: 23, meshes: [], order: [], bounds: [] } },
    ]);
    expect(entries.map((entry) => [entry.object, entry.kind])).toEqual([
      [1, "image"],
      [2, "model"],
    ]);
  });
});
