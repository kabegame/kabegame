/**
 * P14d（`.claude/plans/wpe-import/3-scene/phase14/phase-14d-group-particles.md`）：组里的粒子。期望值是 WPE 抓帧
 * `A:\p14d\gp\gp-frame198.rdc`（工程 `ignore/p14/d/gen_p14d.py` 的 `p14d-gp`，几何阶段常量 `kbp rdc consts`）：组 G 带 x / y 旋转与
 * 非等比缩放，组里每格一颗静止粒子。WPE 画组的子树时绘制栈从 `inverse(W_组)` 起（`ctx+0xaf0` 同值，rea-p4c-sim 5.3）：
 * - 本地系统的模型矩阵 `inverse(W_组) · W`（glm 乘法），世界系统与世界子系统 `inverse(W_组)`，本地子系统在栈顶上照 P4e 乘局部矩阵；
 * - 视图投影是组的局部正交 P，MVP = `P ⊗ M`；朝向、`g_ModelMatrix`、拖尾的 `g_ModelMatrixInverse` 都从 M 来；
 * - 世界父画完的栈顶 WPE 是 `W`（不带组的逆），挂在下面的本地子系统画到组 RT 外：缺陷不复现，我们取 `inverse(W_组) · W`（有意不同）。
 */
import { describe, expect, it } from "vitest";
import { childLocalMatrix, parseParticle, type ParticleChildType, type SceneParticle } from "../compile/particles";
import type { JsonObject } from "../compile/model";
import { orientationVectors } from "../particles/orientation";
import { ParticleSystem } from "../particles/system";
import { SeededRandom } from "../particles/random";
import { drawMatrixOf, groupMvpParts, type LayerTransform } from "./layout";
import { identity, mulAffine, multiply, type Mat4 } from "./math";
import { particleUniformValues } from "./uniforms";

const WPE = {
  PS: {
    event: 125,
    ModelViewProjectionMatrix: [
      0.002199807669967413, 0.0012400848791003227, -0.00014776010357309133, 0.0, -0.0009007475455291569,
      0.003093161154538393, 4.7687262849649414e-5, 0.0, 0.0007742731249891222, 7.517814810853451e-5,
      0.0004752819368150085, 0.0, -0.699999988079071, 0.6000002026557922, 0.5024999976158142, 1.0,
    ],
    OrientationUp: [0.028314054012298584, 0.9954414367675781, -0.09107469022274017],
    OrientationRight: [0.954916775226593, 9.355874652783314e-8, 0.2968734800815582],
    OrientationForward: [-0.29552018642425537, 0.09537452459335327, 0.9505638480186462],
  },
  WS: {
    event: 138,
    ModelViewProjectionMatrix: [
      0.0018412955105304718, -0.0011351309949532151, 0.00012710111332125962, 0.0, 0.0006721252575516701,
      0.0038231199141591787, -9.660133946454152e-5, 0.0, -0.00039733864832669497, 0.0012067893985658884,
      0.0004255878448020667, 0.0, -1.6533769369125366, -1.382559061050415, 0.45235833525657654, 1.0,
    ],
    OrientationUp: [-0.13282886147499084, 0.957253098487854, 0.25694960355758667],
    OrientationRight: [0.9508774280548096, 0.1962156593799591, -0.23944030702114105],
    OrientationForward: [0.27962246537208557, -0.2125229686498642, 0.936293363571167],
  },
  PU: {
    event: 151,
    ModelViewProjectionMatrix: [
      0.002199807669967413, 0.0012400848791003227, -0.00014776010357309133, 0.0, -0.0009007475455291569,
      0.003093161154538393, 4.7687262849649414e-5, 0.0, 0.0007742731249891222, 7.517814810853451e-5,
      0.0004752819368150085, 0.0, -1.5258788721439487e-7, 0.6000002026557922, 0.5024999976158142, 1.0,
    ],
    OrientationUp: [-1.1734665861240501e-7, 1.0, 5.960465188081798e-8],
    OrientationRight: [0.9549168944358826, 9.436125480988267e-8, 0.2968735098838806],
    OrientationForward: [-0.2968734800815582, 7.484699970916608e-9, 0.954916775226593],
  },
  PF: {
    event: 164,
    ModelViewProjectionMatrix: [
      0.002199807669967413, 0.0012400848791003227, -0.00014776010357309133, 0.0, -0.0009007475455291569,
      0.003093161154538393, 4.7687262849649414e-5, 0.0, 0.0007742731249891222, 7.517814810853451e-5,
      0.0004752819368150085, 0.0, 0.3499998450279236, 0.6000002026557922, 0.5024999976158142, 1.0,
    ],
    OrientationUp: [-1.1734665861240501e-7, 1.0, 5.960465188081798e-8],
    OrientationRight: [1.0, 1.1734665861240501e-7, 2.9802311729554276e-8],
    OrientationForward: [-2.9802318834981634e-8, 5.960463766996327e-8, 1.0],
  },
  PT: {
    event: 177,
    ModelViewProjectionMatrix: [
      0.002199807669967413, 0.0012400848791003227, -0.00014776010357309133, 0.0, -0.0009007475455291569,
      0.003093161154538393, 4.7687262849649414e-5, 0.0, 0.0007742731249891222, 7.517814810853451e-5,
      0.0004752819368150085, 0.0, -0.699999988079071, -0.06666656583547592, 0.5024999976158142, 1.0,
    ],
    ModelMatrixInverse: [
      0.8799232840538025, -0.3602989614009857, 0.30970925092697144, -0.0, 0.37202560901641846, 0.927948534488678,
      0.022553393617272377, 0.0, -0.29552021622657776, 0.0953744500875473, 0.9505637288093567, -0.0, 255.29661560058594,
      -82.80165100097656, 82.4168472290039, 1.0,
    ],
    EyePosition: [960.0, 540.0, 2000.0],
    RenderVar0: [0.6000000238418579, 400.0, 0.0, 0.0],
  },
  PL: {
    event: 194,
    ModelViewProjectionMatrix: [
      0.002199807669967413, 0.0012400848791003227, -0.00014776010357309133, 0.0, -0.0009007475455291569,
      0.003093161154538393, 4.7687262849649414e-5, 0.0, 0.0007742731249891222, 7.517814810853451e-5,
      0.0004752819368150085, 0.0, -0.14999999105930328, -0.06666656583547592, 0.5024999976158142, 1.0,
    ],
    ModelMatrix: [
      0.8799231052398682, 0.3720254600048065, -0.29552018642425537, 0.0, -0.3602990210056305, 0.9279483556747437,
      0.09537452459335327, 0.0, 0.30970925092697144, 0.022553443908691406, 0.9505638480186462, 0.0, -60.0,
      -19.999969482421875, 5.0000152587890625, 1.0,
    ],
    OrientationUp: [0.028314054012298584, 0.9954414367675781, -0.09107469022274017],
    OrientationRight: [0.954916775226593, 9.355874652783314e-8, 0.2968734800815582],
    OrientationForward: [-0.29552018642425537, 0.09537452459335327, 0.9505638480186462],
    EyePosition: [960.0, 540.0, 2000.0],
  },
  LC: {
    event: 208,
    ModelViewProjectionMatrix: [
      0.002199807669967413, 0.0012400848791003227, -0.00014776010357309133, 0.0, -0.0009007475455291569,
      0.003093161154538393, 4.7687262849649414e-5, 0.0, 0.0007742731249891222, 7.517814810853451e-5,
      0.0004752819368150085, 0.0, 0.24999983608722687, -0.06666656583547592, 0.5024999976158142, 1.0,
    ],
    OrientationUp: [0.028314054012298584, 0.9954414367675781, -0.09107469022274017],
    OrientationRight: [0.954916775226593, 9.355874652783314e-8, 0.2968734800815582],
    OrientationForward: [-0.29552018642425537, 0.09537452459335327, 0.9505638480186462],
  },
  LCa: {
    event: 221,
    ModelViewProjectionMatrix: [
      0.0018353675259277225, 0.0020987901370972395, -0.000127068065921776, 0.0, -0.001510604633949697,
      0.002588539617136121, 8.922348206397146e-5, 0.0, 0.0007742731249891222, 7.517814810853451e-5,
      0.0004752819368150085, 0.0, 0.345958411693573, 0.13146497309207916, 0.49554187059402466, 1.0,
    ],
    OrientationUp: [0.046089477837085724, 0.9839494824409485, -0.1723921298980713],
    OrientationRight: [0.9660696387290955, 7.572117510790122e-8, 0.2582816183567047],
    OrientationForward: [-0.2541361153125763, 0.1784469485282898, 0.9505638480186462],
  },
  LCb: {
    event: 234,
    ModelViewProjectionMatrix: [
      0.0018412955105304718, -0.0011351309949532151, 0.00012710111332125962, 0.0, 0.0006721252575516701,
      0.0038231199141591787, -9.660133946454152e-5, 0.0, -0.00039733864832669497, 0.0012067893985658884,
      0.0004255878448020667, 0.0, -1.6533769369125366, -1.382559061050415, 0.45235833525657654, 1.0,
    ],
    OrientationUp: [-0.13282886147499084, 0.957253098487854, 0.25694960355758667],
    OrientationRight: [0.9508774280548096, 0.1962156593799591, -0.23944030702114105],
    OrientationForward: [0.27962246537208557, -0.2125229686498642, 0.936293363571167],
  },
  WC: {
    event: 247,
    ModelViewProjectionMatrix: [
      0.0018412955105304718, -0.0011351309949532151, 0.00012710111332125962, 0.0, 0.0006721252575516701,
      0.0038231199141591787, -9.660133946454152e-5, 0.0, -0.00039733864832669497, 0.0012067893985658884,
      0.0004255878448020667, 0.0, -1.6533769369125366, -1.382559061050415, 0.45235833525657654, 1.0,
    ],
    OrientationUp: [-0.13282886147499084, 0.957253098487854, 0.25694960355758667],
    OrientationRight: [0.9508774280548096, 0.1962156593799591, -0.23944030702114105],
    OrientationForward: [0.27962246537208557, -0.2125229686498642, 0.936293363571167],
  },
  WCa: {
    event: 260,
    ModelViewProjectionMatrix: [
      0.0015736720524728298, 0.00276662758551538, -0.0001490835566073656, 0.0, -0.002024319488555193,
      0.0009149380493909121, 0.0002568870841059834, 0.0, 0.001609700033441186, -0.0002518703695386648,
      0.00045366049744188786, 0.0, 2.356948137283325, 1.7315515279769897, 0.4908612072467804, 1.0,
    ],
    OrientationUp: [-0.2958672046661377, 0.7672664523124695, -0.5690033435821533],
    OrientationRight: [0.9119367599487305, 0.40417319536209106, 0.07081925123929977],
    OrientationForward: [-0.27493995428085327, 0.4737512469291687, 0.8366408348083496],
  },
};

type T = Pick<LayerTransform, "origin" | "angles" | "scale" | "offset" | "parent">;
const at = (x: number, y: number): T => ({ origin: [x, y, 5], angles: [0.1, 0.3, 0.4], scale: [1, 1, 1], parent: 10 });
const layers = new Map<number, T>([
  [10, { origin: [700, 560, 30], angles: [0.3, 0.2, 0.35], scale: [1.25, 0.8, 1.1], parent: null }],
  [20, at(-280, 180)],
  [21, at(-140, 180)],
  [22, at(0, 180)],
  [23, at(140, 180)],
  [24, at(-280, -20)],
  [25, at(-60, -20)],
  [26, at(100, -20)],
  [27, at(250, -180)],
]);
const cache = new Map<number, Mat4>();
const parts = groupMvpParts([800, 600], drawMatrixOf(10, layers, cache))!;

/** 一颗静止粒子的系统（同 `gen_p14d.py`），renderer 与 flags 按格子给。 */
const system = (renderer: JsonObject = { name: "sprite" }, flags = 0): SceneParticle =>
  parseParticle(
    {
      flags,
      maxcount: 1,
      emitter: [{ name: "sphererandom", distancemax: 0, rate: 0, instantaneous: 1 }],
      initializer: [{ name: "lifetimerandom", min: 100000, max: 100000 }],
      renderer: [renderer],
    },
    { file: "p.json", orthographic: true },
  );

/** 挂一个 static 子系统（`gen_p14d.py`：`angles 0 0 0.3`）。 */
function attach(parent: SceneParticle, child: SceneParticle, origin: number[]): SceneParticle {
  parent.children.push({
    index: parent.children.length,
    type: "static" as ParticleChildType,
    flags: 0,
    controlPointStartIndex: 0,
    probability: 1,
    maxcount: 10,
    local: childLocalMatrix(origin, [0, 0, 0.3], [1, 1, 1]),
    system: child,
  });
  return parent;
}

const layerState = {
  origin: [0, 0, 0],
  scale: [1, 1, 1],
  angles: [0, 0, 0],
  alpha: 1,
  color: [1, 1, 1],
  brightness: 1,
  visible: true,
  parallaxDepth: [1, 1],
  parent: null,
};

/**
 * 组里一棵粒子树逐个绘制的 uniform：绘制先序与模型矩阵取 `forEachDrawn(…, W, inverse(W_组))`（同时核对 `drawTransform` 逐位相同），
 * uniform 走 `particleUniformValues`，视图投影是组的局部正交 P（同 `GpuScene.uniformValues` 的粒子分支）。
 */
function drawn(object: number, def: SceneParticle): { model: Mat4; values: Record<string, number[]> }[] {
  const W = drawMatrixOf(object, layers, cache);
  const out: { model: Mat4; values: Record<string, number[]> }[] = [];
  new ParticleSystem(def, new SeededRandom(1), 1).forEachDrawn(
    (node, _template, model) => {
      expect(Array.from(node.drawTransform(W, parts.inverse).model)).toEqual(Array.from(model));
      const values = particleUniformValues({
        layer: layerState,
        world: model,
        constants: {},
        viewProjection: parts.projection,
        colorScale: 1,
        screenSize: [1920, 1080],
        textures: [{ width: 32, height: 32, textureWidth: 32, textureHeight: 32 }],
        eye: [960, 540, 2000],
        renderer: node.def.renderer,
      });
      out.push({ model, values });
    },
    W,
    parts.inverse,
  );
  return out;
}

/** −0 与 0 当成相同（WPE 的导出有 −0）。 */
const norm = (values: readonly number[]) => values.map((value) => value + 0);
const ours = (values: Record<string, number[]>, names: readonly string[]) =>
  Object.fromEntries(names.map((name) => [name, norm(values[`g_${name}`])]));
const theirs = (wpe: Record<string, unknown>, names: readonly string[]) =>
  Object.fromEntries(names.map((name) => [name, norm(wpe[name] as number[])]));
const SPRITE = ["ModelViewProjectionMatrix", "OrientationUp", "OrientationRight", "OrientationForward"] as const;

describe("组里的粒子照 WPE 用组内局部的绘制矩阵（p14d-gp）", () => {
  it.each([
    ["PS 本地 sprite（事件 125）", 20, system(), WPE.PS],
    ["WS 世界 sprite（事件 138）：模型矩阵是 inverse(W_组)", 21, system(undefined, 1), WPE.WS],
    ["PU 本地 upright（事件 151）", 22, system({ name: "sprite", orientation: "upright" }), WPE.PU],
    ["PF 本地 fixed（事件 164）", 23, system({ name: "sprite", orientation: "fixed", axis: "0 0 1" }), WPE.PF],
  ] as const)("%s：MVP 与三个朝向逐位", (_name, object, def, wpe) => {
    const [only] = drawn(object, def);
    expect(ours(only.values, SPRITE)).toEqual(theirs(wpe, SPRITE));
  });

  it("本地系统的模型矩阵是 glm 乘法（仿射乘法差 1 ulp）", () => {
    const W = drawMatrixOf(20, layers, cache);
    const [only] = drawn(20, system());
    expect(Array.from(only.model)).toEqual(Array.from(multiply(parts.inverse, W)));
    expect(Array.from(mulAffine(parts.inverse, W))).not.toEqual(Array.from(only.model));
  });

  it("PT 本地 spritetrail（事件 177）：拖尾读的 g_ModelMatrixInverse 是组内局部的", () => {
    const names = ["ModelViewProjectionMatrix", "ModelMatrixInverse", "EyePosition", "RenderVar0"];
    const [only] = drawn(24, system({ name: "spritetrail", length: 0.6, maxlength: 400 }));
    expect(ours(only.values, names)).toEqual(theirs(WPE.PT, names));
  });

  it("PL 本地 sprite + LIGHTING（事件 194）：g_ModelMatrix 是组内局部的", () => {
    const names = [...SPRITE, "ModelMatrix", "EyePosition"];
    const [only] = drawn(25, system());
    expect(ours(only.values, names)).toEqual(theirs(WPE.PL, names));
  });

  it("LC 本地父（事件 208）→ 本地 static 子（221）→ 世界 static 子（234，模型矩阵是 inverse(W_组)）", () => {
    const def = attach(attach(system(), system(), [60, 40, 0]), system(undefined, 1), [60, -60, 0]);
    expect(drawn(26, def).map(({ values }) => ours(values, SPRITE))).toEqual(
      [WPE.LC, WPE.LCa, WPE.LCb].map((wpe) => theirs(wpe, SPRITE)),
    );
  });

  it("WC 世界父（事件 247）相同；挂在下面的本地子（260）和 WPE 有意不同：WPE 的栈顶是不带组逆的 W", () => {
    const def = attach(system(undefined, 1), system(), [-60, 60, 0]);
    const [root, child] = drawn(27, def);
    expect(ours(root.values, SPRITE)).toEqual(theirs(WPE.WC, SPRITE));
    // WPE：世界系统画完把栈顶恢复成 sys+0x3a0 = W（rea-p4e-children 第 6 节），子系统的模型矩阵是 W · L，配组的局部正交画到组 RT 外
    const W = drawMatrixOf(27, layers, cache);
    const wpeModel = multiply(W, new Float32Array(def.children[0].local));
    const { up, right, forward } = orientationVectors(
      def.children[0].system.renderer.orientation,
      wpeModel,
      [0, 0, -1],
      [0, 1, 0],
    );
    expect({
      ModelViewProjectionMatrix: norm(Array.from(mulAffine(parts.projection, wpeModel))),
      OrientationUp: up,
      OrientationRight: right,
      OrientationForward: forward,
    }).toEqual(theirs(WPE.WCa, SPRITE));
    // 我们：栈顶 inverse(W_组) · W，子系统落在组里该在的位置（缺陷不复现）
    expect(Array.from(child.model)).toEqual(
      Array.from(multiply(multiply(parts.inverse, W), new Float32Array(def.children[0].local))),
    );
    expect(norm(child.values.g_ModelViewProjectionMatrix)).not.toEqual(norm(WPE.WCa.ModelViewProjectionMatrix));
  });

  it("不给起点时同以前：本地根 W、本地子 W · L、世界子单位阵", () => {
    const W = drawMatrixOf(26, layers, cache);
    const def = attach(attach(system(), system(), [60, 40, 0]), system(undefined, 1), [60, -60, 0]);
    const models: Mat4[] = [];
    new ParticleSystem(def, new SeededRandom(1), 1).forEachDrawn((_node, _t, model) => void models.push(model), W);
    expect(models.map((m) => Array.from(m))).toEqual(
      [W, multiply(W, new Float32Array(def.children[0].local)), identity()].map((m) => Array.from(m)),
    );
  });
});
