import { init, initSync, parse } from "es-module-lexer";
import {
  GENERAL_FIELDS,
  type AnimationLayerField,
  isTextRuntimeField,
  type BindingTarget,
  type GeneralKey,
  type SceneBinding,
  type TargetKey,
  type TextRuntimeField,
  type ValueType,
} from "./bindings";
import { isCameraObject, isMixedCameraObject, isSoundObject, isTextObject, objectKind } from "./features";
import {
  resolveValue,
  userCondition,
  type SceneJson,
  type SceneObject,
  type SceneScalar,
  type SceneValue,
} from "./model";
import { registrationKeys } from "./registration";
import { usesEffectAccess } from "./scriptApi";
import { instanceControlPoint, SCRIPT_INSTANCE_KEYS, type InstanceKey } from "./particles";
import { BLOOM_FIELDS } from "./postprocess";

export type ScriptOwner =
  | { kind: "layer"; object: number }
  /**
   * puppet 动画层的字段脚本（P12c）：路径 `objects/<i>/animationlayers/<k>/<字段>`。`entry` 是 JSON 里的下标 k，`layer` 是层 id（P12e：编译期的层 id = `entry`，
   * 收集时就填好；运行时建的层是负数、没有字段脚本）。bundle 编完 puppet 后只核对这一项建出来了没有，没建出来的脚本从列表里删掉。
   * `thisLayer` 是所属图层，`thisObject` 是这个动画层。
   */
  | { kind: "animation-layer"; object: number; entry: number; layer: number }
  | { kind: "material"; pass: TargetKey; layer: number }
  | { kind: "effect"; object: number; effect: number }
  | { kind: "general" };

export interface SceneScript {
  id: string;
  source: string;
  target: BindingTarget | { kind: "unsupported"; path: string };
  valueType: ValueType | "string";
  initial: SceneScalar;
  owner: ScriptOwner;
  layer: number | null;
  scriptProperties: Record<string, SceneScalar> | null;
  imports: string[];
  errors: string[];
}

export interface SceneScripts {
  list: SceneScript[];
  /**
   * 会执行的脚本里有 `getEffect` 成员访问（P6d1a，词法同 `scriptApi.ts` 的 `memberAccesses`，任意接收者）：为真时写死关闭的 effect
   * 也编进 bundle（`visibleBound`），脚本才拿得到、打得开。可选：测试里手写的 `{ list: [] }` 视同 false。
   */
  usesEffectAccess?: boolean;
}

const layerTypes: Record<string, ValueType> = {
  origin: "vec3",
  scale: "vec3",
  angles: "angles",
  alpha: "float",
  color: "vec3",
  brightness: "float",
  visible: "bool",
  // P5a 步骤 2：字段脚本写回到视差深度（语料 2582765611、2896608544）
  parallaxDepth: "vec2",
  // P6c：字段脚本写回到光标命中的开关（布尔，只改状态）
  solid: "bool",
};

/**
 * 文本对象运行中可改的字段 → 字段脚本收发的形状（P6b 1e）：按字段定，不按初值猜。`text` 恒为字符串——初值是两三个词时
 * （`"Song Title"`、`"<Time and Date>"`）按初值猜会当成 vec2 / vec3，`update(value)` 收到 `Vec2(NaN, NaN)`；枚举同样是字符串
 * （WPE 类型 5），数字键 float、向量键 vec2、布尔位 bool。
 */
const textTypes: Record<TextRuntimeField, ValueType | "string"> = {
  text: "string",
  pointsize: "float",
  padding: "vec2",
  spacing: "vec2",
  maxwidth: "float",
  maxrows: "float",
  limitwidth: "bool",
  limitrows: "bool",
  limituseellipsis: "bool",
  blockalign: "bool",
  horizontalalign: "string",
  verticalalign: "string",
};

function valueType(initial: SceneScalar): ValueType | "string" {
  if (typeof initial === "boolean") return "bool";
  if (typeof initial === "number") return "float";
  if (typeof initial === "string") {
    const parts = initial.trim().split(/\s+/);
    if (parts.length === 2) return "vec2";
    if (parts.length === 3) return "vec3";
    if (parts.length === 4) return "vec4";
  }
  return "string";
}

function isAnimationLayerField(key: string): key is AnimationLayerField {
  return key === "rate" || key === "blend" || key === "visible";
}

/**
 * 字段脚本的写回目标。`sound`：声音对象自己的 `volume`（P6a 步骤 2）写回到就地目标 `{ kind: "sound" }`，返回值每帧写回、
 * 当场交给排期器（同 API 写 `thisLayer.volume`）。只认对象顶层的 `objects/<i>/volume`。
 * `text`：文本对象顶层的 `objects/<i>/<TEXT_RUNTIME_FIELDS 之一>`（P6b 1e）写回到文本目标，值变了才重排；`font`、
 * `opaquebackground` 等其余文本键仍是 `unsupported`（能力表另报 `text:script:<键>`）。
 *
 * `particle`：粒子对象的 `objects/<i>/instanceoverride/<键>`（P4f 步骤 1–3，rea-p4f-script.md 第 5–7 节）。`SCRIPT_INSTANCE_KEYS` 的
 * 24 个键（6 个系数、`brightness`、`colorn` 与 16 个控制点键）写回到就地目标 `particle-instance`：WPE 的回调返回值走和脚本赋值、用户
 * 属性改值同一个 setter（6.2，每帧写、不比较），下一帧对象更新开头才进模拟（6.3），和我们「脚本之后 `sync`、下一次 `stepParticles`
 * 才用」的帧序等价；`rate` 在 `SceneState.write` 里另走一条路（没有改值回调，5.4）。其余键与非粒子对象上的 `instanceoverride` 没有
 * 目标（能力表照报），也不落到图层的同名字段上（`alpha`、`brightness` 是图层字段，路径不同）。
 *
 * `camera`：相机对象（P5d 步骤 3，`isCameraObject` 且不带别的内容）顶层的 `objects/<i>/fov` / `zoom` 写回到就地目标
 * `{ kind: "camera" }`（rea-p5-camera 4.1：两个 float 描述符可挂脚本），渲染器每帧选相机时读。
 *
 * 属性关键帧动画（P10a，`animations.ts`）用同一个函数推目标，参数照字段脚本的算法给（相机对象上的关键帧在那边先报
 * `value:animation:camera`，不走到这里，所以 `camera` 缺省 false）。
 */
export function targetOf(
  path: string,
  owner: ScriptOwner,
  key: string,
  initial: SceneScalar,
  sound: boolean,
  text: boolean,
  particle: boolean,
  camera = false,
): SceneScript["target"] {
  if (
    owner.kind === "layer" &&
    camera &&
    (key === "fov" || key === "zoom") &&
    path === `objects/${owner.object}/${key}`
  )
    return { kind: "camera", object: owner.object, field: key };
  if (owner.kind === "layer" && sound && path === `objects/${owner.object}/volume`)
    return { kind: "sound", object: owner.object, field: "volume" };
  if (owner.kind === "layer" && text && path === `objects/${owner.object}/${key}` && isTextRuntimeField(key))
    return { kind: "text", object: owner.object, field: key };
  if (owner.kind === "layer" && path === `objects/${owner.object}/instanceoverride/${key}`)
    return particle && (SCRIPT_INSTANCE_KEYS as readonly string[]).includes(key)
      ? { kind: "particle-instance", object: owner.object, field: key as InstanceKey }
      : { kind: "unsupported", path };
  // 动画层字段脚本（P12c）：只有 rate / blend / visible 有目标；其余字段 unsupported（`layerDefs` 另报 `puppet:layer-script`）
  if (owner.kind === "animation-layer")
    return path === `objects/${owner.object}/animationlayers/${owner.entry}/${key}` && isAnimationLayerField(key)
      ? { kind: "animation-layer", object: owner.object, layer: owner.layer, field: key }
      : { kind: "unsupported", path };
  if (owner.kind === "layer" && key in layerTypes)
    return { kind: "layer", object: owner.object, field: key as Extract<BindingTarget, { kind: "layer" }>["field"] };
  if (owner.kind === "effect" && key === "visible")
    return { kind: "effect", object: owner.object, effect: owner.effect };
  if (owner.kind === "general" && key === "bloom") return { kind: "bloom-enabled" };
  if (owner.kind === "general" && key in BLOOM_FIELDS)
    return { kind: "bloom", field: BLOOM_FIELDS[key as keyof typeof BLOOM_FIELDS] };
  if (owner.kind === "general" && key in GENERAL_FIELDS) return { kind: "general", key: key as GeneralKey };
  if (owner.kind === "material")
    return {
      kind: "constant",
      pass: owner.pass,
      material: key,
      uniforms: [],
      type: valueType(initial) === "string" ? "float" : (valueType(initial) as ValueType),
    };
  return { kind: "unsupported", path };
}

/**
 * 按目标定的值类型（不按初值猜），字段脚本与属性关键帧动画（P10a，`animations.ts`）共用：声音的 `volume`、相机对象（P5d 步骤 3）的
 * `fov` / `zoom` 是 float；文本按 `textTypes`；粒子实例覆盖的 `colorn` 与控制点键是 vec3（WPE 的描述符，rea-p4f-script.md 1.3、5.1），其余系数是 float；图层字段按 `layerTypes`；
 * `general` 字段按 `GENERAL_FIELDS`。其余（材质常量、泛光参数、没有目标的）返回 null，由调用方另定。
 */
export function targetValueType(
  target: SceneScript["target"],
  owner: ScriptOwner,
  key: string,
): ValueType | "string" | null {
  if (target.kind === "sound" || target.kind === "camera") return "float";
  if (target.kind === "animation-layer") return target.field === "visible" ? "bool" : "float";
  if (target.kind === "text") return textTypes[target.field];
  if (target.kind === "particle-instance")
    return target.field === "colorn" || instanceControlPoint(target.field) ? "vec3" : "float";
  if (owner.kind === "layer" && key in layerTypes) return layerTypes[key];
  if (owner.kind === "general" && key in GENERAL_FIELDS) return GENERAL_FIELDS[key as GeneralKey].type;
  return null;
}

/**
 * 脚本遍历的共用部分（`collectScripts` 与 `collectObjectScripts`）：`objectAt` 按 `objects` 下标给出对象（声音 / 文本 / 粒子 / 相机的目标判定要看它），
 * 返回的 `visit` 把找到的脚本条目追加进 `list`。键序、属主、写回目标只有这一份。
 */
function scriptVisitor(
  objectAt: (index: number) => unknown,
  properties: Record<string, SceneScalar>,
  bindings: SceneBinding[],
  list: SceneScript[],
): (value: unknown, path: string, owner: ScriptOwner, layer: number | null) => void {
  function visit(value: unknown, path: string, owner: ScriptOwner, layer: number | null): void {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value) && "script" in value && typeof value.script === "string") {
      const raw = value as { script: string; value?: SceneScalar; scriptproperties?: Record<string, SceneValue> };
      const initial = raw.value ?? null;
      const key = path.split("/").at(-1) ?? "";
      const imports: string[] = [];
      const errors: string[] = [];
      try {
        for (const item of parse(raw.script)[0]) {
          // 只看静态导入与再导出（t 为 1 / 4 / 6）：动态导入（2 / 5 / 7）在 WPE 里一律 reject、不影响加载，import.meta（3）无关
          if (item.t !== 1 && item.t !== 4 && item.t !== 6) continue;
          if (item.n === undefined) continue;
          if (item.n === null) continue; // 变量动态 import 无法在编译期确定
          if (/^(?![./]|[a-z][\w+.-]*:)[\w-]+$/i.test(item.n)) imports.push(item.n);
          else errors.push(`不支持的模块说明符：${item.n}`);
        }
      } catch (error) {
        errors.push(`扫描导入失败：${String(error)}`);
      }
      const scriptProperties: Record<string, SceneScalar> = {};
      for (const [property, source] of Object.entries(raw.scriptproperties ?? {})) {
        scriptProperties[property] = resolveValue(source, properties) ?? null;
        if (source && typeof source === "object" && "user" in source) {
          const user = source.user;
          const name = typeof user === "string" ? user : user.name;
          // 空串 condition 算没写（`userCondition`）
          const condition = userCondition(user);
          bindings.push({
            property: name,
            ...(condition !== undefined ? { condition } : {}),
            target: { kind: "script-property", script: path, key: property },
          });
        }
      }
      const object = owner.kind === "layer" ? (objectAt(owner.object) as SceneObject | undefined) : undefined;
      const sound = !!object && typeof object === "object" && isSoundObject(object);
      const text = !!object && typeof object === "object" && isTextObject(object);
      const particle = !!object && typeof object === "object" && objectKind(object) === "particle";
      const camera = !!object && typeof object === "object" && isCameraObject(object) && !isMixedCameraObject(object);
      const target = targetOf(path, owner, key, initial, sound, text, particle, camera);
      list.push({
        id: path,
        source: raw.script,
        target,
        valueType: targetValueType(target, owner, key) ?? valueType(initial),
        initial,
        owner,
        layer,
        scriptProperties: raw.scriptproperties ? scriptProperties : null,
        imports: [...new Set(imports)],
        errors,
      });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        const next =
          path === "objects"
            ? { kind: "layer" as const, object: index }
            : /^objects\/\d+\/effects$/.test(path)
              ? { kind: "effect" as const, object: layer!, effect: index }
              : /^objects\/\d+\/animationlayers$/.test(path)
                ? { kind: "animation-layer" as const, object: layer!, entry: index, layer: index }
                : owner;
        visit(entry, `${path}/${index}`, next, path === "objects" ? index : layer);
      });
      return;
    }
    // 键序照 WPE 的登记顺序（P10b 决定 3，`registration.ts`），不按书写顺序
    const record = value as Record<string, unknown>;
    for (const key of registrationKeys(path, Object.keys(record))) {
      const entry = record[key];
      let next = owner;
      let nextLayer = layer;
      if (path === "objects") {
        next = { kind: "layer", object: Number(key) };
        nextLayer = Number(key);
      } else if (/^objects\/\d+\/effects$/.test(path)) {
        next = { kind: "effect", object: layer!, effect: Number(key) };
      } else if (/^objects\/\d+\/animationlayers$/.test(path)) {
        next = { kind: "animation-layer", object: layer!, entry: Number(key), layer: Number(key) };
      } else if (key === "constantshadervalues" && /\/passes\/\d+$/.test(path)) {
        next = { kind: "material", pass: path, layer: layer! };
      }
      visit(entry, path ? `${path}/${key}` : key, next, nextLayer);
    }
  }
  return visit;
}

/** 原始 JSON 坐标扫描；不受可见性、effect 开关或编译快速回退影响。 */
export async function collectScripts(
  scene: SceneJson,
  properties: Record<string, SceneScalar>,
  bindings: SceneBinding[],
): Promise<SceneScripts> {
  await init;
  const list: SceneScript[] = [];
  const visit = scriptVisitor((index) => (scene.objects as unknown[])[index], properties, bindings, list);
  if (scene.general) visit(scene.general, "general", { kind: "general" }, null);
  visit(scene.objects, "objects", { kind: "general" }, null);
  // 导入说明符无效的整段不求值（`ScriptRuntime.load`），同能力表只看会执行的脚本
  return { list, usesEffectAccess: list.some((script) => !script.errors.length && usesEffectAccess(script.source)) };
}

/**
 * 只收一个对象上的脚本（P6d3b，`createLayer` 的新建对象）：路径 `objects/<index>/…`，属主、写回目标、键序与 `collectScripts` 同一套遍历。
 * `bindings` 缺省不登记属性绑定（运行时当场建层时由编译那一次登记）。
 */
export async function collectObjectScripts(
  object: unknown,
  index: number,
  properties: Record<string, SceneScalar>,
  bindings: SceneBinding[] = [],
): Promise<SceneScript[]> {
  await init;
  return collectObjectScriptsSync(object, index, properties, bindings);
}

/**
 * 同步版（P6d3b）：运行时 `createLayer` 要在返回前拿到条目。调用前词法分析器必须已初始化——主线程在建 realm 时已 `await init`；没有就退回
 * `initSync()`（同步编译 wasm，主线程可能被浏览器拒绝，所以只当兜底）。
 */
export function collectObjectScriptsSync(
  object: unknown,
  index: number,
  properties: Record<string, SceneScalar>,
  bindings: SceneBinding[] = [],
): SceneScript[] {
  try {
    initSync();
  } catch {
    // 已经初始化、或这里不允许同步编译：照常往下走，真没初始化时 parse 自己会抛
  }
  const list: SceneScript[] = [];
  const visit = scriptVisitor((at) => (at === index ? object : undefined), properties, bindings, list);
  visit(object, `objects/${index}`, { kind: "layer", object: index }, index);
  return list;
}
