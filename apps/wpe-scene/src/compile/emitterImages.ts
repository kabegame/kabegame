/**
 * 发射图候选表的降采样材质（P4j 步骤 2a，`rea-p4j-layerimage.md` 2.2）。
 *
 * 被依赖图层的合成 RT 要降到 `w4 × h4` 的 RGBA8 再读回。WPE 用 `materials/util/downsample_quarter.json`（每个输出像素取四个对角双线性
 * 样本的平均），组合键 `WRITEALPHA = 1`；有 `mask` 纹理时再加 `OPACITYMASK = 1`（`albedo.a *= tex1(v_TexCoordBase).r`）。着色器与泛光链同样
 * 用 WPE 安装目录 assets 里的原件（运行时从用户的 WPE 读，不随应用分发），缺了照常记 `material:missing:…` 退回预览图。
 *
 * 原件材质的槽 0 写的是 `_rt_FullFrameBuffer`：这里只取着色器与 COMBO，纹理槽由渲染器在画的时候换成被依赖图层的合成 RT（槽 1 是 `mask`），
 * 所以不检查原件的纹理名（编译时翻译只需要槽位的格式）。引擎 uniform `g_Texture0Texel` 由渲染器按合成 RT 尺寸写，不读 `g_RenderVar0`。
 * 渲染与读回是步骤 2b。
 */
import type { ScenePass } from "./bundle";
import { POSTPROCESS_UNIFORMS } from "./bloom";
import { checkProgramFeatures, normalizeDepthKeys } from "./features";
import type { SceneFs } from "./fs";
import { parseMaterial } from "./model";
import { shaderUniforms, type ShaderCompiler } from "./shader";
import { FBO_FORMATS } from "./tex";
import type { TranslateResult } from "../wpesl2wgsl";

export const EMITTER_IMAGE_MATERIAL = "materials/util/downsample_quarter.json";

/** 两个变体：没有 `mask` 的与有 `mask` 的（场景里用到哪个才编哪个）。 */
export interface SceneEmitterImagePasses {
  plain?: ScenePass;
  masked?: ScenePass;
}

export interface EmitterImageCompileContext {
  fs: SceneFs;
  shader: ShaderCompiler;
  unsupported: Set<string>;
  /** 把翻译结果放进 bundle 的 `programs`，返回下标（与图层共用去重）。 */
  addProgram(result: TranslateResult): number;
}

/** 编译需要的变体；`wantMasked` 为真时多编 `OPACITYMASK = 1` 的那份。 */
export async function compileEmitterImages(
  context: EmitterImageCompileContext,
  wantMasked: boolean,
): Promise<SceneEmitterImagePasses> {
  const passes: SceneEmitterImagePasses = {};
  const plain = await compileVariant(context, "emitterimage/plain", { WRITEALPHA: 1 });
  if (plain) passes.plain = plain;
  if (wantMasked) {
    const masked = await compileVariant(context, "emitterimage/masked", { WRITEALPHA: 1, OPACITYMASK: 1 });
    if (masked) passes.masked = masked;
  }
  return passes;
}

async function compileVariant(
  { fs, shader, unsupported, addProgram }: EmitterImageCompileContext,
  key: string,
  combos: Record<string, number>,
): Promise<ScenePass | null> {
  const text = await fs.text(EMITTER_IMAGE_MATERIAL);
  const pass = text ? parseMaterial(text).passes[0] : undefined;
  if (!pass?.shader) {
    unsupported.add(`material:missing:${EMITTER_IMAGE_MATERIAL}`);
    return null;
  }
  const format = FBO_FORMATS.rgb888.tex;
  const slots = combos.OPACITYMASK ? 2 : 1;
  const textures = Array.from({ length: slots }, (_, slot) => ({ slot, format }));
  const merged = { ...(pass.combos ?? {}), ...combos };
  const result = await shader.compile(pass.shader, merged, textures);
  let program: number | null = null;
  if (result?.ok) {
    checkProgramFeatures(result, unsupported, POSTPROCESS_UNIFORMS);
    program = addProgram(result);
  }
  return {
    key,
    program,
    blending: pass.blending ?? "normal",
    ...normalizeDepthKeys(pass),
    textures: {},
    runtime: {},
    uniforms: shaderUniforms(result, pass, {}),
    framebuffer: false,
  };
}
