/**
 * 用户纹理（P11b，`.claude/plans/wpe-import/3-scene/phase11/phase-11b-usertextures.md`）：材质 pass 的 `usertextures` 让某个纹理槽在运行中
 * 换成场景外的图。读码 rea-p11-textures 第 1、2 节与 rea-p11b，实测 p11-REPORT「属性纹理」「P11b 补测」。
 *
 * 本文件是编译期与渲染期的共同约定：
 * - 编译期 `compilePass` 解析出每个生效的槽（`UserTextureSlot`），挂在 `ScenePass.userTextures`；用到的来源汇总进 `SceneBundle.userTextures`；
 *   属性来源在绑定表登记 `{ kind: "user-texture"; name }`（就地目标，不重编译）。
 * - 渲染期 `src/usertex/` 按来源的当前值读文件、解码、裁切；`GpuScene` 解析纹理来源时，槽上登记了用户纹理且当前有图就用那张图，
 *   否则用缺省纹理（`ScenePass.textures[slot]` 或 `layerComposites[slot]`，同没有用户纹理时）。
 */

/** 来源类型（`FUN_140154480`：字符串项 → 属性；对象项 `type` 为 `"system"` → 系统伪属性、`"usershortcut"` → 快捷方式、其它 → 属性）。 */
export type UserTextureKind = "property" | "system" | "usershortcut";

/** 一个来源：同一个来源可以绑在多个 pass 的多个槽上。 */
export interface UserTextureSource {
  kind: UserTextureKind;
  /** 属性名（`property` / `usershortcut`）或伪属性名（`system`：`$mediaThumbnail`、`$mediaPreviousThumbnail`）；大小写敏感。 */
  name: string;
}

/**
 * 参考尺寸：用户图按它的宽高比在源图正中裁出最大矩形（`FUN_1401702f0`，`keepAspect` 时不裁）。
 * 运行期的纹理名（缓存键）是 `值 + "x" + round(比例 · 10)`（`roundf`，四舍五入远离 0），比例相近的槽共用一张、按先建的槽的精确比例裁
 * （rea-p11b「顺带」）。
 */
export type UserTextureReference =
  /**
   * 定值，三种来历：缺省纹理的图像尺寸（`.tex` 头的图像宽高，不是补到 2 的幂的纹理尺寸；精灵表取帧尺寸）；instanced 图层取对象
   * `size`（WPE 把它写进 `instance.usertexturereference`，p11-REPORT M2）；显式的 `usertexturereference`（两个都非 0 时优先）。
   */
  | { kind: "size"; width: number; height: number }
  /**
   * 缺省纹理是被依赖图层的合成 RT（`_rt_imageLayerComposite_<id>_a`，P8 的 `ScenePass.layerComposites`）：渲染期取那张 RT 的尺寸
   * （p11-REPORT M3）。加载时属性就有值的话不生效（参考尺寸查不到，M8、rea-p11b 5.2），运行中第一次改值之后才生效。
   * `object` 是被依赖图层的 `objects` 下标。
   */
  | { kind: "layer"; object: number };

/** 一个生效的用户纹理槽（`textures[slot]` 是非空字符串、`slot < 10`、`usertextures[slot]` 有非空名字）。 */
export interface UserTextureSlot {
  /** 槽号：`usertextures` 的数组下标，同 `textures` 的下标。 */
  slot: number;
  source: UserTextureSource;
  /** 对象项的 `keepaspect: true`：不裁，用户图整张进纹理（语料 0 处，能力表照报 `usertextures:keepaspect`）。 */
  keepAspect: boolean;
  reference: UserTextureReference;
  /**
   * 建出的用户纹理的采样（`FUN_1401556e0` 的请求标志 `8 | 缺省纹理的点采样位 1 | 夹取位 2`，`FUN_140099980`）：
   * - `nearest`：缺省纹理 `.tex` 的 NoInterpolation 位；GIF 另强制点采样（步骤 4，渲染期决定，不在这里）；
   * - `clamp`：缺省纹理 `.tex` 的 ClampUVs 位；缺省是合成 RT 时夹取（M3）；快捷方式另加夹取（P11d）。
   * 过滤只有点 / 线性两种，没有各向异性、1 级 mip（p11-REPORT「属性纹理」第 4 条）。
   */
  nearest: boolean;
  clamp: boolean;
}

// ———— 编译期解析（P11b 步骤 1） ————

/**
 * 槽上缺省纹理（`textures[slot]` 解析出的东西）的描述，由 `compilePass` 在纹理解析之后按槽给出（`parseUserTextures` 的 `defaultOf`）。
 * 返回 undefined = 这个槽没有缺省纹理（`textures[slot]` 不是非空字符串、被渲染图占用的 `planned` 槽、纹理缺失等）：不登记用户纹理槽。
 */
export type UserTextureDefault =
  /**
   * 静态纹理。`width` / `height` 是参考尺寸要用的那一对：`.tex` 头的**图像**尺寸（不是补到 2 的幂的纹理尺寸），帧表纹理（`sheet`）取
   * 第 0 帧的像素尺寸（`FUN_1401556e0`：标志位 4 → 帧尺寸，rea-p11-textures 2.2）。
   */
  | { kind: "texture"; width: number; height: number; clampUVs: boolean; noInterpolation: boolean; sheet: boolean }
  /** 被依赖图层的合成 RT（`ScenePass.layerComposites[slot]`）。 */
  | { kind: "layer"; object: number }
  /** `_rt_imageLayerComposite_*` 没被依赖、解析不到：绑棋盘格（P8），WPE 此时的行为只读码到【推】，照报。 */
  | { kind: "placeholder" }
  /** `_rt_FullFrameBuffer` 或本 effect 的 fbo：缺省纹理是运行时 RT，参考尺寸取法没实测（语料 0 处），照报。 */
  | { kind: "runtime"; name: string };

/** 把 bundle 里的静态纹理换成 `UserTextureDefault`（精灵表取第 0 帧的像素尺寸：`renderVar1` 的前两项是归一化的帧宽高，乘图像尺寸【推】）。 */
export function defaultOfTexture(texture: {
  width: number;
  height: number;
  clampUVs: boolean;
  noInterpolation: boolean;
  sheet?: { renderVar1: readonly number[] };
}): UserTextureDefault {
  const { sheet } = texture;
  return {
    kind: "texture",
    width: sheet ? Math.round(sheet.renderVar1[0] * texture.width) : texture.width,
    height: sheet ? Math.round(sheet.renderVar1[1] * texture.height) : texture.height,
    clampUVs: texture.clampUVs,
    noInterpolation: texture.noInterpolation,
    sheet: !!sheet,
  };
}

/** `usertextures` 里最多看前 10 个槽（`FUN_1401556e0` 的 `min(len(textures), 10)`）。 */
const MAX_SLOTS = 10;

interface ParsedItem {
  kind: UserTextureKind;
  name: string;
  keepAspect: boolean;
}

/** 一项的解析（`FUN_140154480`）：字符串 → 属性；对象读 `name`（字符串才算）、`type`、`keepaspect`（JSON true）；null、数字、空名字跳过。 */
function parseItem(item: unknown): ParsedItem | null {
  if (typeof item === "string") return item ? { kind: "property", name: item, keepAspect: false } : null;
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const { name, type, keepaspect } = item as Record<string, unknown>;
  if (typeof name !== "string" || name === "") return null;
  const kind: UserTextureKind = type === "system" ? "system" : type === "usershortcut" ? "usershortcut" : "property";
  return { kind, name, keepAspect: keepaspect === true };
}

/** 显式的 `usertexturereference`：对象、`width` / `height` 都是数字且都非 0 才算（rea-p11-textures 2.2）。 */
function explicitReference(raw: unknown): { width: number; height: number } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { width, height } = raw as Record<string, unknown>;
  if (typeof width !== "number" || typeof height !== "number" || width === 0 || height === 0) return null;
  return { width, height };
}

/** instanced 对象 `size`（`"w h"`，按空格切、各取 `atof`）→ 参考尺寸；不是字符串、解析不出、有 0 都返回 null（那时回到缺省纹理的尺寸）。 */
export function instanceReferenceSize(size: unknown): { width: number; height: number } | null {
  if (typeof size !== "string") return null;
  const [w, h] = size.trim().split(/\s+/).map(Number.parseFloat);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w === 0 || h === 0) return null;
  return { width: w, height: h };
}

/** `parseUserTextures` 的结果：生效的槽（按槽号升序）与这个 pass 要报的不支持项。 */
export interface UserTextureParse {
  slots: UserTextureSlot[];
  issues: string[];
}

/** `parseUserTextures` 的附加条件。 */
export interface UserTextureOptions {
  /**
   * instanced 图层：对象 `size` 解析出的参考尺寸（`instanceReferenceSize`）。WPE 加载 instanced 图层时把对象 `size` 写进
   * `instance.usertexturereference`，覆盖材质 pass 自己的同名键（p11-REPORT M2），所以它优先于显式的 `usertexturereference`，
   * 也不报 `usertextures:reference`。非 instanced 不传。
   */
  instanceSize?: { width: number; height: number } | null;
  /** 粒子材质 pass：槽 0 的缺省纹理是精灵表时报 `usertextures:particle-sheet`（帧表与 `g_RenderVar1` 只在加载时按槽 0 定一次，M4）。 */
  particle?: boolean;
}

/**
 * 解析一个 pass（已合并 instance / effect 实例覆盖）的 `usertextures`（rea-p11-textures 第 1、2.2 节）。
 * - 只认 `textures[slot]` 是非空字符串、`slot < 10` 的槽：`defaultOf(slot)` 返回 undefined 的槽（含 `textures[slot]` 为空）一律跳过。
 *   槽号 = `usertextures` 数组下标；
 * - 参考尺寸：instanced 的对象 `size`（`options.instanceSize`）> 显式 `usertexturereference` > 缺省纹理：合成 RT 取 `{ kind: "layer" }`
 *   （渲染期取 RT 尺寸），静态纹理取图像尺寸（精灵表取帧尺寸）。取到的宽或高为 0 时这个槽永远是缺省纹理（`FUN_1401556e0`：`W == 0 || H == 0`
 *   goto 缺省），**不登记**；
 * - 采样位：缺省纹理的 `noInterpolation` / `clampUVs`（`FUN_1401556e0` 的请求标志）；缺省是合成 RT 时夹取、线性（M3）；
 * - 名字大小写敏感，同名可以绑多个槽；
 * - 不支持项：`usertextures:system` / `:usershortcut`（P11c、P11d）、`:keepaspect`（语料 0 处）、`:reference`（非 instanced 的有效显式参考，
 *   语料 0 处）、`:particle-sheet`、`:rendertarget:placeholder`、`:rendertarget:runtime`。后两种缺省纹理的槽不登记。
 */
export function parseUserTextures(
  pass: Readonly<Record<string, unknown>>,
  defaultOf: (slot: number) => UserTextureDefault | undefined,
  options: UserTextureOptions = {},
): UserTextureParse {
  const slots: UserTextureSlot[] = [];
  const issues = new Set<string>();
  const items = pass.usertextures;
  if (!Array.isArray(items)) return { slots, issues: [] };
  const explicit = explicitReference(pass.usertexturereference);
  const override = options.instanceSize ? explicitReference(options.instanceSize) : null;
  for (let slot = 0; slot < Math.min(items.length, MAX_SLOTS); slot++) {
    const item = parseItem(items[slot]);
    if (!item) continue;
    const base = defaultOf(slot);
    if (!base) continue;
    if (base.kind === "placeholder") {
      issues.add("usertextures:rendertarget:placeholder");
      continue;
    }
    if (base.kind === "runtime") {
      issues.add("usertextures:rendertarget:runtime");
      continue;
    }
    let reference: UserTextureReference;
    const given = override ?? explicit;
    if (given) {
      reference = { kind: "size", width: given.width, height: given.height };
      if (!override) issues.add("usertextures:reference");
    } else if (base.kind === "layer") {
      reference = { kind: "layer", object: base.object };
    } else {
      if (base.width === 0 || base.height === 0) continue; // 参考尺寸为 0：这个槽永远是缺省纹理，不登记
      reference = { kind: "size", width: base.width, height: base.height };
    }
    if (item.kind === "system") issues.add("usertextures:system");
    if (item.kind === "usershortcut") issues.add("usertextures:usershortcut");
    if (item.keepAspect) issues.add("usertextures:keepaspect");
    if (options.particle && slot === 0 && base.kind === "texture" && base.sheet)
      issues.add("usertextures:particle-sheet");
    slots.push({
      slot,
      source: { kind: item.kind, name: item.name },
      keepAspect: item.keepAspect,
      reference,
      nearest: base.kind === "texture" ? base.noInterpolation : false,
      clamp: base.kind === "texture" ? base.clampUVs : true,
    });
  }
  return { slots, issues: [...issues] };
}

/**
 * instanced 的 `instance.usertextures` 与材质 pass 的按槽合并（同 `textures`）：覆盖项是非空字符串或对象才替换，null / 空串 / 别的类型保留
 * 材质自己的；两边都不是数组时返回 undefined。
 */
export function mergeUserTextures(base: unknown, override: unknown): unknown[] | undefined {
  const baseItems = Array.isArray(base) ? base : undefined;
  const overrideItems = Array.isArray(override) ? override : undefined;
  if (!baseItems && !overrideItems) return undefined;
  const merged = [...(baseItems ?? [])];
  for (const [slot, item] of (overrideItems ?? []).entries()) {
    const valid = typeof item === "string" ? item !== "" : !!item && typeof item === "object" && !Array.isArray(item);
    if (valid) merged[slot] = item;
  }
  return merged;
}
