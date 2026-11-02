/**
 * 泛光链与最终合成的材质（PLAN P2b，p2-REPORT A1–A4 / J5）。
 *
 * 着色器一律用 WPE 安装目录 `assets/materials/util/` 里的原件，经翻译器编译，和图层材质走同一套管线（运行时从用户的
 * WPE 读，不随应用分发）；缺了照常记 `material:missing:…` / `shader:…` 退回预览图。渲染步骤、RT 尺寸与参数换算见
 * `render/bloom.ts`。
 *
 * - **LDR**：`downsample_quarter_bloom`（快照 → 1/4）→ `downsample_eighth_blur_v`（→ 1/8）→ `blur_h_bloom`（→ `_rt_Bloom`）
 *   → `combine_ldr`（`scene + bloom`，写回场景目标，RGBA8 自然截断）。
 * - **HDR**：`hdr_downsample_bloom`（快照 → L0）→ `hdr_downsample` × (N−1) → `hdr_upsample(_cubic)` × (N−1) → 收尾。
 *   WPE 在 SDR 显示上用 `combine_hdr_upsample` 输出 `saturate(lin(scene + bloom)) · RV0.x`（RV0.x = 1）到 FP16 线性交换链；
 *   我们的画布是 8 位 sRGB 编码，用同一份着色器的 `LINEAR=1` 变体 `combine_hdr_upsample_linear`（`saturate(scene + bloom)`，
 *   也是 WPE assets 里的原件）。sRGB 编码是 `lin()` 的精确反函数且两者都单调、把 [0, 1] 映到 [0, 1]，所以
 *   encode(saturate(lin(x))) = saturate(x)，两者在画布上逐值相等，还省掉一次 pow 往返与 cover 时的编码。
 */
import type { ScenePass } from "./bundle";
import { checkPassFeatures, checkProgramFeatures } from "./features";
import type { SceneFs } from "./fs";
import { parseMaterial } from "./model";
import { shaderUniforms, type ShaderCompiler } from "./shader";
import { FBO_FORMATS } from "./tex";
import type { TranslateResult } from "../wpesl2wgsl";

export type LdrBloomPass = "quarter" | "eighth" | "blur" | "combine";
export type HdrBloomPass = "downsampleBloom" | "downsample" | "upsample" | "upsampleCubic" | "combine";
export type BloomPassName = LdrBloomPass | HdrBloomPass;

/** 每个 pass 的材质与由渲染器填的槽位数（槽 0 是上一步 / 快照，combine 的槽 1 是泛光结果）。 */
export const LDR_BLOOM_MATERIALS: Readonly<Record<LdrBloomPass, { material: string; slots: number }>> = {
  quarter: { material: "materials/util/downsample_quarter_bloom.json", slots: 1 },
  eighth: { material: "materials/util/downsample_eighth_blur_v.json", slots: 1 },
  blur: { material: "materials/util/blur_h_bloom.json", slots: 1 },
  combine: { material: "materials/util/combine_ldr.json", slots: 2 },
};
export const HDR_BLOOM_MATERIALS: Readonly<Record<HdrBloomPass, { material: string; slots: number }>> = {
  downsampleBloom: { material: "materials/util/hdr_downsample_bloom.json", slots: 1 },
  downsample: { material: "materials/util/hdr_downsample.json", slots: 1 },
  upsample: { material: "materials/util/hdr_upsample.json", slots: 1 },
  upsampleCubic: { material: "materials/util/hdr_upsample_cubic.json", slots: 1 },
  combine: { material: "materials/util/combine_hdr_upsample_linear.json", slots: 2 },
};

/** 泛光链里由渲染器写、图层材质里没有意义的引擎 uniform（RV0：纹素偏移，A2 / I4）。 */
export const POSTPROCESS_UNIFORMS: ReadonlySet<string> = new Set(["g_RenderVar0"]);

/** 一份 bundle 的泛光：开着时才有（`general.postprocess.bloom` 且场景有对象，A1）。 */
export interface SceneBloom {
  hdr: boolean;
  /** 各 pass 编好的材质；`uniforms` 只是着色器注解默认值，场景参数由渲染图按材质名写入。 */
  passes: Partial<Record<BloomPassName, ScenePass>>;
}

export interface BloomCompileContext {
  fs: SceneFs;
  shader: ShaderCompiler;
  unsupported: Set<string>;
  /** 把翻译结果放进 bundle 的 `programs`，返回下标（与图层共用去重）。 */
  addProgram(result: TranslateResult): number;
}

/**
 * 编译一条泛光链的全部材质。槽位格式按 WPE 的 RT 格式枚举给翻译器（只影响 `TEX<n>FORMAT`）：LDR `rgb888`，
 * HDR 的快照与金字塔都是 `rgb161616f`（A1 / A4）。
 */
export async function compileBloom(context: BloomCompileContext, hdr: boolean): Promise<SceneBloom> {
  const table: Record<string, { material: string; slots: number }> = hdr ? HDR_BLOOM_MATERIALS : LDR_BLOOM_MATERIALS;
  const format = FBO_FORMATS[hdr ? "rgb161616f" : "rgb888"].tex;
  const passes: Partial<Record<BloomPassName, ScenePass>> = {};
  for (const [name, { material, slots }] of Object.entries(table)) {
    const pass = await compileBloomPass(context, material, slots, format);
    if (pass) passes[name as BloomPassName] = pass;
  }
  return { hdr, passes };
}

async function compileBloomPass(
  { fs, shader, unsupported, addProgram }: BloomCompileContext,
  path: string,
  slots: number,
  format: number,
): Promise<ScenePass | null> {
  const text = await fs.text(path);
  const pass = text ? parseMaterial(text).passes[0] : undefined;
  if (!pass?.shader) {
    unsupported.add(`material:missing:${path}`);
    return null;
  }
  checkPassFeatures(pass, unsupported);
  const textures = Array.from({ length: slots }, (_, slot) => ({ slot, format }));
  const result = await shader.compile(pass.shader, pass.combos ?? {}, textures);
  let program: number | null = null;
  if (result?.ok) {
    checkProgramFeatures(result, unsupported, POSTPROCESS_UNIFORMS);
    program = addProgram(result);
  }
  return {
    program,
    blending: pass.blending ?? "normal",
    cullmode: pass.cullmode ?? "nocull",
    depthtest: pass.depthtest ?? "disabled",
    depthwrite: pass.depthwrite ?? "disabled",
    textures: {},
    runtime: {},
    uniforms: shaderUniforms(result, pass, {}),
    framebuffer: false,
  };
}
