/**
 * 文本对象 → bundle 的文本表（P6b 1d）。文本对象在 WPE 里是一种图层：变换、可见性、`color` / `alpha` / `brightness`、effect 链都和
 * 图像层一样，只是基础 pass 画的不是一张贴图，而是逐字四边形（`render/graph.ts` 的 `text` 步骤）。这里只做 Worker 能做的部分：
 * - 把对象的排版字段规整成 `text/layout.ts` 的 `TextFields`（取值规则照 WPE 的 JSON setter，rea-p6b-layout 1.2、1.3）；
 * - 定位主字体（工程 → `scene.pkg` → WPE `assets`；`systemfont_*` 由宿主读 `%WINDIR%\Fonts`）；
 * - 编四个宿主指定材质的 pass：`basefont`（普通字形）、`basefontrgba`（彩色字形）、`fontbackground`（直接上屏的背景）、
 *   `composelayer_clearalpha`（合成路径没开背景时 RT 的初值）。正交场景一律用不带 `_depth` 的材质（rea-p6b-raster 1，5.4）；
 * - 背景色（`g_Color` = `backgroundcolor` × (HDR ? `backgroundbrightness` : 1)）。
 * 排版、栅格化要 wasm、字体字节与图集，在宿主主线程（`text/host.ts`），结果经 `GpuScene.build` 的 `texts` 交给渲染器。
 *
 * 绑定（P3a）：`TEXT_RUNTIME_FIELDS` 里的排版字段（文字、字号、padding、对齐等）绑用户属性登记成文本目标
 * `{ kind: "text", object, field }`（P6b 1e：就地写进 `SceneState.textFields`、值变了渲染器重排，不整场重编译）；`font`、
 * `opaquebackground`、MSDF 开关、`anchor` 照旧登记成重编译（1e 已定 3）；
 * `backgroundcolor` 在 LDR（或 HDR 下 `backgroundbrightness` 恒为 1）时登记成背景常量的就地目标（`background.key` 的 `g_Color`），
 * 否则重编译；`backgroundbrightness` 只在 HDR 下读，绑了属性登记成重编译。
 */
import {
  isTextRuntimeField,
  isUserBinding,
  type BindingCollector,
  type BindingTarget,
  type TargetKey,
} from "./bindings";
import type { ScenePass } from "./bundle";
import { checkTextOptions } from "./features";
import type { SceneFs } from "./fs";
import { numbers, type SceneObject, type SceneScalar, type SceneValue } from "./model";
import {
  TEXT_DEFAULTS,
  textEnum,
  textFieldFromJson,
  textFloat,
  type TextFieldKey,
  type TextFields,
} from "../text/fields";
import { fontPath, SYSTEM_FONT_PREFIX, type FontPath } from "../text/fonts";
import type { ShaderTextureSlot } from "./shader";

/** 宿主指定的四个材质（WPE 自带，`assets/materials/...`）。 */
export const TEXT_MATERIALS = {
  glyphs: "materials/fonts/basefont.json",
  color: "materials/fonts/basefontrgba.json",
  background: "materials/fonts/fontbackground.json",
  clearAlpha: "materials/util/composelayer_clearalpha.json",
} as const;

/** R8 图集的 `.tex` 格式号（`__font_atlas_` 用格式 9，rea-p6b-raster 3.2）。 */
const R8_FORMAT = 9;

/** 主字体文件。 */
export interface SceneFontFile {
  /** `fontPath(font)`：`system:<文件>`，或引擎路径。 */
  path: FontPath;
  /**
   * 引擎路径按场景的资源查找顺序（工程 → `scene.pkg` → WPE `assets`）定位到的真实文件与内容起点（同 `SceneSoundFile.location`）；
   * `system:` 字体与哪里都找不到的为 null（宿主读 system 字体；找不到时排版换 arial，同 WPE）。
   */
  location: { path: string; offset: number } | null;
  /** pkg 条目的长度；散文件为 null（整读）。 */
  size: number | null;
}

/** 编译期的文本表（每个文本图层一份，挂在 `SceneLayer.text`）。 */
export interface SceneText {
  fields: TextFields;
  font: SceneFontFile;
  /** `basefont`：普通字形，槽 0 是 R8 图集（渲染图填）。 */
  glyphPass: ScenePass;
  /** `basefontrgba`：彩色字形，槽 0 是 RGBA8 图集。 */
  colorPass: ScenePass;
  /** `fontbackground`（`flat` 着色器）：开了 `opaquebackground` 时编；只在直接上屏时画（合成路径改成清屏）。 */
  backgroundPass: ScenePass | null;
  /**
   * `composelayer_clearalpha`：没开 `opaquebackground`、图层可能走合成（有 effect 或 colorBlendMode ∉ {0, 31}）时编；合成 RT 的初值是
   * 文字框背后的场景快照、alpha 清 0。
   */
  clearAlphaPass: ScenePass | null;
  /**
   * 背景色：`key` 是背景常量在 `SceneState.constants` 里的键（有背景 pass 时就是它的 pass 键），`color` 是 `g_Color` 的初值
   * （`backgroundcolor` × (HDR ? `backgroundbrightness` : 1)）。直接上屏的背景 pass 与合成路径的清屏色读同一份值。
   */
  background: { key: TargetKey; color: [number, number, number] };
}

/** 编一个宿主指定材质的 pass：读不到材质时由它报 `material:missing:<路径>` 并返回 null。 */
export type HostPassCompiler = (
  path: string,
  key: TargetKey,
  planned: ShaderTextureSlot[],
  options?: { text?: boolean },
) => Promise<ScenePass | null>;

export interface TextCompileContext {
  fs: SceneFs;
  properties: Record<string, SceneScalar>;
  bindings: BindingCollector;
  /** 场景实际的 HDR（`postprocess.hdr`）：`backgroundbrightness` 只在 HDR 下乘。 */
  hdr: boolean;
  /** 编译期启用的 effect 个数（WPE `+0x320`）与 `colorBlendMode`：决定加不加 `padding`。 */
  visibleEffects: number;
  colorBlendMode: number;
  /** 图层可能走合成（有任何 effect，或 colorBlendMode ∉ {0, 31}）：要编 `composelayer_clearalpha`。 */
  mayComposite: boolean;
  hostPass: HostPassCompiler;
  /** 场景级不支持项：`msdf` 等开关与 `anchor` 按生效值（绑了属性的取当前值）报（`features.ts` 的 `checkTextOptions`）。 */
  unsupported: Set<string>;
}

/** `anchor` 的取值表：查不到取 WPE 表里的第一项 none（rea-p6b-layout 1.2；对齐的两张表在 `text/fields.ts`）。 */
export const TEXT_ANCHORS = [
  "none",
  "center",
  "top",
  "topright",
  "right",
  "bottomright",
  "bottom",
  "bottomleft",
  "left",
  "topleft",
] as const;

/** JSON 里写成对象、没挂 `user` / `script` 的值：WPE 的 setter 读它的 `value`（rea-p6b-layout 1.3）。 */
function plainValue(raw: unknown): unknown {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && !("user" in raw) && !("script" in raw) && "value" in raw)
    return (raw as { value: unknown }).value;
  return undefined;
}

// 取值规则（float / vec2 / 枚举）在 `text/fields.ts`，属性就地写与脚本写回共用（P6b 1e）；这里再导出给原有的调用方与单测
export { textFloat, textVec2 } from "../text/fields";

/**
 * 解析一个文本对象（`isTextObject` 为真）。读不到 `basefont` / `basefontrgba` 时返回 null（已报 `material:missing`），图层照常存在、
 * 没有文本表，渲染器不画它。
 */
export async function compileText(
  index: number,
  object: SceneObject,
  ctx: TextCompileContext,
): Promise<SceneText | null> {
  const { properties, bindings } = ctx;
  const recompile = (key: string): BindingTarget => ({
    kind: "recompile",
    reason: "layer-structure",
    path: `objects/${index}/${key}`,
  });
  /** 读一个键：`{user}` 登记绑定并取当前值，`{script}` 取初值，写成对象的取 `value`。 */
  const read = (key: string, target: BindingTarget = recompile(key)): unknown => {
    const raw = object[key];
    const resolved = bindings.bind(raw as SceneValue | undefined, properties, target);
    return resolved === undefined ? plainValue(raw) : resolved;
  };
  const flag = (key: string) => read(key) === true;
  /**
   * 排版字段：取值规则与属性就地写、脚本写回同一份（`textFieldFromJson`，P6b 1e），不写时取 WPE 缺省。`text` / `font` 只收字符串
   * （或对象里的字符串 `value`），别的类型当缺省（`text` 为空串、不可见，rea-p6b-layout 1.3）。
   * 绑了用户属性时：运行中可改的字段（`TEXT_RUNTIME_FIELDS`）登记文本目标、就地重排（P6b 1e），`font` / `opaquebackground` 照旧重编译。
   */
  const field = <F extends TextFieldKey>(key: F): TextFields[F] => {
    const target: BindingTarget = isTextRuntimeField(key)
      ? { kind: "text", object: index, field: key }
      : recompile(key);
    const value = textFieldFromJson(key, read(key, target));
    if (value !== undefined) return value;
    // 向量的缺省给一份新数组，不与 `TEXT_DEFAULTS` 共用
    const fallback = TEXT_DEFAULTS[key];
    return (Array.isArray(fallback) ? [...fallback] : fallback) as TextFields[F];
  };

  const fields: TextFields = {
    text: field("text"),
    font: field("font"),
    pointsize: field("pointsize"),
    padding: field("padding"),
    spacing: field("spacing"),
    maxwidth: field("maxwidth"),
    maxrows: field("maxrows"),
    limitwidth: field("limitwidth"),
    limitrows: field("limitrows"),
    limituseellipsis: field("limituseellipsis"),
    blockalign: field("blockalign"),
    opaquebackground: field("opaquebackground"),
    horizontalalign: field("horizontalalign"),
    verticalalign: field("verticalalign"),
    visibleEffects: ctx.visibleEffects,
    colorBlendMode: ctx.colorBlendMode,
  };
  // 只影响能力判断的键：绑了属性同样登记成重编译（改了重编译后按新值重新判断）
  checkTextOptions(
    {
      msdf: flag("msdf"),
      outline: flag("outline"),
      blur: flag("blur"),
      dropshadow: flag("dropshadow"),
      anchor: textEnum(read("anchor"), TEXT_ANCHORS, "none"),
    },
    ctx.unsupported,
  );

  // 主字体：`systemfont_*` 与引擎路径（rea-p6b-raster 2.1、2.2）；引擎路径按场景的资源查找顺序定位，宿主按位置读
  const path = fontPath(fields.font);
  let location: SceneFontFile["location"] = null;
  let size: number | null = null;
  if (path && !path.startsWith(SYSTEM_FONT_PREFIX)) {
    try {
      const file = await ctx.fs.resolve(path);
      if (file) {
        location = { ...file.location };
        size = file.size;
      }
    } catch {
      // 越界、绝对路径：WPE 也读不到，排版换 arial
    }
  }

  // 背景色：`backgroundcolor` × (HDR ? `backgroundbrightness` : 1)（rea-p6b-layout 第 4 节；LDR 下 brightness 不读）
  const backgroundKey = `objects/${index}/text/background`;
  const brightness = ctx.hdr ? textFloat(read("backgroundbrightness"), 1) : 1;
  // HDR 下 brightness 绑了属性或不为 1：就地写 `g_Color` 只写得了颜色，乘不了它，`backgroundcolor` 改走重编译
  const inPlace = !ctx.hdr || (brightness === 1 && !isUserBinding(object.backgroundbrightness));
  const colorTarget: BindingTarget = inPlace
    ? { kind: "constant", pass: backgroundKey, material: "backgroundcolor", uniforms: ["g_Color"], type: "vec3" }
    : recompile("backgroundcolor");
  const rgb = numbers(read("backgroundcolor", colorTarget) as SceneScalar | undefined, [0, 0, 0]);
  const color: [number, number, number] = [
    (rgb[0] ?? 0) * brightness,
    (rgb[1] ?? 0) * brightness,
    (rgb[2] ?? 0) * brightness,
  ];

  // 四个宿主材质（WPE 自带，`textures` 都没有静态纹理）：字形的槽 0 是图集，由渲染图填
  const glyphPass = await ctx.hostPass(
    TEXT_MATERIALS.glyphs,
    `objects/${index}/text/glyphs`,
    [{ slot: 0, format: R8_FORMAT }],
    { text: true },
  );
  const colorPass = await ctx.hostPass(TEXT_MATERIALS.color, `objects/${index}/text/color`, [{ slot: 0 }], {
    text: true,
  });
  const backgroundPass = fields.opaquebackground
    ? await ctx.hostPass(TEXT_MATERIALS.background, backgroundKey, [])
    : null;
  const clearAlphaPass =
    !fields.opaquebackground && ctx.mayComposite
      ? await ctx.hostPass(TEXT_MATERIALS.clearAlpha, `objects/${index}/text/clearalpha`, [])
      : null;
  // 背景 pass 的 `g_Color` 是材质值：图层就地刷新不覆盖，绑定的就地写经常量表改它
  if (backgroundPass) backgroundPass.uniforms.g_Color = [...color];
  if (!glyphPass || !colorPass) return null;
  return {
    fields,
    font: { path, location, size },
    glyphPass,
    colorPass,
    backgroundPass,
    clearAlphaPass,
    background: { key: backgroundKey, color },
  };
}
