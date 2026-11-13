/**
 * 场景属性关键帧动画的编译期（P10a 步骤 2）：把 `scene.json` 里每处 `{animation: {…}, value}` 解析成一条 `SceneAnimation`（纯数据，
 * 随 bundle 交给主线程）。目标与字段脚本共用 `targetOf`；材质常量的 uniform 要等着色器编完才知道，由 `bundle.ts` 编译 pass 时调
 * `settleConstantAnimation` 补上。
 *
 * 依据：`.claude/plans/wpe-import/3-scene/phase10/phase-10a-curves.md` 步骤 2；语义见 `rea-p10-keyframes.md` 第 5 节（丢弃、通道数、
 * `relative`）、第 7 节（联动）、第 8 节（事件）、第 10 节（通道到分量、只写四种类型），实测见 `p10-REPORT.md`。
 */
import { applyWraploop, parseChannel, type ParsedKey } from "../animation/curve";
import type { AnimationClockParams, AnimationEventDef, AnimationValueType, SceneAnimation } from "../animation/types";
import type { BindingTarget, ValueType } from "./bindings";
import { isSoundObject, isTextObject, objectKind } from "./features";
import { atof, constantTargetFields, type MaterialSlot } from "./materialValues";
import { isKeyframedValue, type SceneJson, type SceneObject, type SceneScalar } from "./model";
import { targetOf, targetValueType, type ScriptOwner } from "./scripts";

const f = Math.fround;

/**
 * 过渡键：有任何一条会写字段的动画（`writes` 为真）时报，P10a 步骤 3 接上运行时后删掉（同 P5c 的 `model:pending`）。
 * `writes` 为假的（布尔、字符串、通道数不对、常量没有 uniform）WPE 也什么都不做，不报。
 */
export const ANIMATION_PENDING = "value:animation:pending";

export interface CollectedAnimations {
  /** 按遍历顺序（登记顺序，读码第 7 节）：`general` 先，再 `objects`。 */
  list: SceneAnimation[];
  /**
   * 不进列表、照报的能力键：灯对象上的 `value:animation:light`（P13）、相机对象上的 `value:animation:camera`（P5d）、
   * 没有就地目标的 `value:animation:other`。
   */
  unsupported: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * 时钟参数（`FUN_1401a96b0` → `FUN_1401a8c10`，读码第 3、5 节）；整条丢弃时返回 null：
 * - `options` 不是对象；`fps`、`length` 不是 JSON 数（类型 1–3，布尔不算）；
 * - `fps ≤ 0`（float32），或 `(float)(int)length / fps ≤ 0`（`length` 截断成 0、为负）。
 * `mode` 只认字符串 `"mirror"` / `"single"`，`startpaused` 只认布尔 `true`。
 */
function clockOf(options: unknown): AnimationClockParams | null {
  if (!isRecord(options)) return null;
  const { fps, length } = options;
  if (typeof fps !== "number" || typeof length !== "number") return null;
  const rate = f(fps);
  const frames = Math.trunc(length);
  if (!(rate > 0) || !(f(f(frames) / rate) > 0)) return null;
  return {
    fps,
    length: frames,
    mode: options.mode === "mirror" ? 1 : options.mode === "single" ? 2 : 0,
    startpaused: options.startpaused === true,
  };
}

/**
 * `relative` 的三个偏移（`FUN_1401a4db0` 的 `0x1401a538a`–`0x1401a54f2`，读码第 5 节第 3 条）。只看 `animation.relative` 这个键在不在，
 * 不看取值（语料都是 `true`）。属性的 `value` 必须是字符串（作者写的，不是套用户属性后的值），逐字照汇编扫，只认空格（0x20）作分隔，
 * 每段 `atof`、再转 float32（`cvtsd2ss`）：
 * - 空串：三个偏移都是 0（照样换算，等于不变）；
 * - 只有一段，或第二段一直到串尾（标量、两段的 vec2）：不换算，返回 null；
 * - 第二段之后还有空格：第三段读剩下的部分，串尾时读空串得 0。前导空格会让第一段读两次（同 `atof` 跳空白）。
 */
function relativeOffsets(value: unknown): number[] | null {
  if (typeof value !== "string") return null;
  if (value === "") return [0, 0, 0];
  const x = atof(value);
  let at = 0;
  while (at < value.length && value[at] !== " ") at++;
  if (at >= value.length) return null;
  while (at < value.length && value[at] === " ") at++;
  const y = atof(value.slice(at));
  while (at < value.length && value[at] !== " ") at++;
  if (at >= value.length) return null;
  while (at < value.length && value[at] === " ") at++;
  const z = atof(value.slice(at));
  return [f(x), f(y), f(z)];
}

/**
 * 一个 `cN` 数组加偏移（`FUN_1401a89a0`）：只改元素里是数的 `value`，`asFloat(值) + 偏移` 用 float32 加；不是数组的原样返回。
 * 不改入参（WPE 改的是 JSON 本身，我们的 scene 还要接着编译）。
 */
function offsetChannel(raw: unknown, offset: number): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((item) =>
    isRecord(item) && typeof item.value === "number" ? { ...item, value: f(f(item.value) + offset) } : item,
  );
}

/** 码点序比较：jsoncpp 的对象键按 UTF-8 字节比较（`memcmp` 后比长度），UTF-8 的字节序就是码点序。 */
function compareKeys(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n;) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(i)!;
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}

/**
 * jsoncpp 解析出的整数（int64 / uint64）原样写，其余（实数）按 `precision 8` 写（`%.8g`）。JS 分不出 `30` 与 `30.0`，整数值的实数
 * 按整数写：解析后的数只在超过 8 位有效数字时不同（如 `123456789.0`，语料没有）。
 */
function jsoncppNumber(value: number): number {
  return Number.isInteger(value) && value >= -(2 ** 63) && value < 2 ** 64 ? value : Number(value.toPrecision(8));
}

function jsoncppValue(value: unknown): unknown {
  if (typeof value === "number") return jsoncppNumber(value);
  if (Array.isArray(value)) return value.map(jsoncppValue);
  if (isRecord(value))
    // `Object.fromEntries` 建自有属性：`__proto__` 这样的键也照常进串
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareKeys)
        .map((key) => [key, jsoncppValue(value[key])]),
    );
  return value;
}

/**
 * 事件对象照 jsoncpp `writeString` 序列化（`FUN_140004d00`：紧凑、`precision 8`，对象键排序，读码第 8 节）。dll 派发时 `JSON.parse` 它，
 * 所以只要求解析出的对象和 WPE 的相同：键递归排序、实数取 8 位有效数字后交给 `JSON.stringify`。数字键（`"10"`）在 JS 对象里总排在前面，
 * 串的键序和 jsoncpp 不同，解析出的对象相同。
 */
export function eventJson(event: Record<string, unknown>): string {
  return JSON.stringify(jsoncppValue(event));
}

/**
 * 事件（`FUN_1401a9410`，读码第 8 节）：`events` 是数组时按下标、是对象时按键序（jsoncpp 对象的遍历顺序）取元素，只收 `name` 是字符串、
 * `frame` 是数的；`time = f(f(frame) × spf)`，`spf = f(1 / f(fps))`。
 */
function eventsOf(raw: unknown, fps: number): AnimationEventDef[] {
  const items = Array.isArray(raw)
    ? raw
    : isRecord(raw)
      ? Object.keys(raw)
          .sort(compareKeys)
          .map((key) => raw[key])
      : [];
  const spf = f(1 / f(fps));
  const out: AnimationEventDef[] = [];
  for (const item of items)
    if (isRecord(item) && typeof item.name === "string" && typeof item.frame === "number")
      out.push({ time: f(f(item.frame) * spf), json: eventJson(item) });
  return out;
}

/** 值类型 → 动画的值类型：WPE 只写 float / vec2 / vec3 / vec4（描述符类型 4、1、2、3，读码第 10 节），`angles` 按 vec3，其余不写。 */
function animationType(type: ValueType | "string" | null): AnimationValueType {
  return type === "float" || type === "vec2" || type === "vec3" || type === "vec4" || type === "angles"
    ? type
    : "other";
}

/** 每种类型要的通道数（读码第 5 节第 2 条：必须正好相等）。 */
const COMPONENTS: Record<Exclude<AnimationValueType, "other">, number> = {
  float: 1,
  vec2: 2,
  vec3: 3,
  vec4: 4,
  angles: 3,
};

/** 这条动画写不写字段：类型是四种之一，且通道数正好等于分量数（读码第 5 节第 2 条、第 10 节）。 */
export function animationWrites(valueType: AnimationValueType, channels: number): boolean {
  return valueType !== "other" && COMPONENTS[valueType] === channels;
}

/**
 * 动画目标的值类型。和字段脚本同一个 `targetValueType`，另有两处按 WPE 的描述符改：
 * - 文本的 `maxrows` 是整数（描述符类型 0，rea-p6b-layout 1.2），动画不写；字段脚本照旧按数收发；
 * - 泛光参数（字段脚本按初值猜）：`bloomtint` 是 vec3，`bloomhdriterations` 是整数（场景 `+0x3d4`）不写，其余 float；
 * - effect 可见性、`general.bloom` 是布尔，不写；
 * - 材质常量：先按初值的形状占位，编译 pass 后由 `settleConstantAnimation` 按 uniform 改。
 */
function valueTypeOf(target: BindingTarget, owner: ScriptOwner, key: string): AnimationValueType {
  if (target.kind === "text" && target.field === "maxrows") return "other";
  if (target.kind === "bloom")
    return target.field === "tint" ? "vec3" : target.field === "hdrIterations" ? "other" : "float";
  if (target.kind === "effect" || target.kind === "bloom-enabled") return "other";
  if (target.kind === "constant") return animationType(target.type);
  return animationType(targetValueType(target, owner, key));
}

/** 联动的属主：路径去掉最后一段（`objects/3/alpha` → `objects/3`；effect 常量是 `…/constantshadervalues`；实例覆盖是 `…/instanceoverride`）。 */
function ownerOf(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}

function propertyOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** 灯对象（P13）与相机对象（P5d）：有这个键（不为 null）。 */
const isLightObject = (object: SceneObject) => object.light !== undefined && object.light !== null;
const isCameraObject = (object: SceneObject) => object.camera !== undefined && object.camera !== null;

/**
 * 收集 `scene.json` 里的关键帧动画。坐标遍历同 `collectScripts`（`general` 先，再 `objects`；effect 实例常量的属主是材质 pass；
 * `instanceoverride` 在对象下）。遇到关键帧值不再往里走；脚本值照常往里走（`scriptproperties` 里的关键帧报 `other`）。其余顶层键里的
 * 关键帧没有就地目标，报 `other`。
 *
 * 每处关键帧依次：
 * 1. 丢弃（`clockOf`）：不进列表、不报键，WPE 什么都不做、属性保持 `value`；
 * 2. 灯 / 相机对象上的：不进列表，报 `value:animation:light` / `camera`；
 * 3. 目标（`targetOf`）没有就地目标：不进列表，报 `value:animation:other`；
 * 4. `relative`（先于通道解析）→ `c0`… 连续的数组（最多 `c3`，空数组也算一条）逐个 `parseChannel` → `wraploop: true` 时 `applyWraploop`；
 * 5. 值类型与 `writes`；事件；
 * 6. 全部收完后联动：`options.parent.key` 是非空字符串时，找同一属主、属性名等于它、自己没有 parent key 的第一条作父（读码第 7 节）；
 *    找不到时用自己的时钟。`children` 不读。
 */
export function collectAnimations(scene: SceneJson): CollectedAnimations {
  const list: SceneAnimation[] = [];
  /** 与 `list` 对齐：各条的 `options.parent.key`（没有为 null）。 */
  const parentKeys: (string | null)[] = [];
  const unsupported = new Set<string>();
  const objects = (Array.isArray(scene.objects) ? scene.objects : []) as SceneObject[];

  function add(raw: Record<string, unknown>, path: string, owner: ScriptOwner | null, layer: number | null): void {
    const animation = raw.animation as Record<string, unknown>;
    const options = animation.options;
    const clock = clockOf(options);
    if (!clock || !isRecord(options)) return;
    const object = layer === null ? undefined : objects[layer];
    if (isRecord(object) && isLightObject(object)) {
      unsupported.add("value:animation:light");
      return;
    }
    if (isRecord(object) && isCameraObject(object)) {
      unsupported.add("value:animation:camera");
      return;
    }
    const key = propertyOf(path);
    const initial = (raw.value ?? null) as SceneScalar;
    const target = owner
      ? targetOf(
          path,
          owner,
          key,
          initial,
          isRecord(object) && isSoundObject(object),
          isRecord(object) && isTextObject(object),
          isRecord(object) && objectKind(object) === "particle",
        )
      : ({ kind: "unsupported", path } as const);
    if (target.kind === "unsupported" || target.kind === "recompile") {
      unsupported.add("value:animation:other");
      return;
    }
    const offsets = "relative" in animation ? relativeOffsets(raw.value) : null;
    const channels: ParsedKey[][] = [];
    for (let i = 0; i < 4 && Array.isArray(animation[`c${i}`]); i++) {
      const source = offsets && i < 3 ? offsetChannel(animation[`c${i}`], offsets[i]) : animation[`c${i}`];
      const keys = parseChannel(source);
      channels.push(options.wraploop === true ? applyWraploop(keys, clock.length) : keys);
    }
    const valueType = valueTypeOf(target, owner!, key);
    const parent = isRecord(options.parent) ? options.parent.key : undefined;
    list.push({
      id: path,
      target,
      valueType,
      channels,
      clock,
      parent: null,
      events: eventsOf(options.events, clock.fps),
      // 常量目标的类型要等编译 pass 后才知道（`settleConstantAnimation`）
      writes: target.kind !== "constant" && animationWrites(valueType, channels.length),
    });
    parentKeys.push(typeof parent === "string" && parent !== "" ? parent : null);
  }

  function visit(value: unknown, path: string, owner: ScriptOwner | null, layer: number | null): void {
    if (!value || typeof value !== "object") return;
    if (isKeyframedValue(value)) {
      add(value as Record<string, unknown>, path, owner, layer);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        const next: ScriptOwner | null =
          owner && path === "objects"
            ? { kind: "layer", object: index }
            : owner && /^objects\/\d+\/effects$/.test(path)
              ? { kind: "effect", object: layer!, effect: index }
              : owner;
        visit(entry, `${path}/${index}`, next, owner && path === "objects" ? index : layer);
      });
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      let next = owner;
      let nextLayer = layer;
      if (owner && path === "objects") {
        next = { kind: "layer", object: Number(key) };
        nextLayer = Number(key);
      } else if (owner && /^objects\/\d+\/effects$/.test(path)) {
        next = { kind: "effect", object: layer!, effect: Number(key) };
      } else if (owner && key === "constantshadervalues" && /\/passes\/\d+$/.test(path)) {
        next = { kind: "material", pass: path, layer: layer! };
      }
      visit(entry, path ? `${path}/${key}` : key, next, nextLayer);
    }
  }

  if (scene.general) visit(scene.general, "general", { kind: "general" }, null);
  visit(scene.objects, "objects", { kind: "general" }, null);
  // 其余顶层键（`camera` 等）不经属性框架：照报，不进列表
  for (const [key, value] of Object.entries(scene))
    if (key !== "general" && key !== "objects") visit(value, key, null, null);

  // 联动（读码第 7 节）：父必须同一属主、属性名等于 parent key、自己没有 parent key，只有一层；先登记的优先
  // TODO:[WPE_SCENE] effect 常量联动的属主按 pass 算（`…/passes/<k>/constantshadervalues`），没核对：WPE 比的是绑定的目标对象
  // （`B+8`），它也可能是整个 effect 或图层。语料 `3577990983` 的 `objects/41` 在 pass 2、4、5 上各有一个 `Aperture`（parent key
  // `Opacity`），`Opacity` 只在 pass 3 上：按 pass 算它们用自己的时钟，按 effect / 图层算会挂到 pass 3 的 `Opacity` 上。两边参数相同
  // （30 fps、length 120、single），画面无差；要核对就在 WPE 里放一个 effect 的两个 pass 上分别写父、子，看子跟不跟父的暂停
  list.forEach((animation, index) => {
    const key = parentKeys[index];
    if (key === null) return;
    const owner = ownerOf(animation.id);
    const parent = list.findIndex(
      (candidate, at) => parentKeys[at] === null && ownerOf(candidate.id) === owner && propertyOf(candidate.id) === key,
    );
    animation.parent = parent < 0 ? null : parent;
  });
  return { list, unsupported: [...unsupported].sort() };
}

/**
 * 编译 pass 后补关键帧的常量目标（`bundle.ts` 编译 pass 处调，同字段脚本）：整组 uniform 名、主格 setter 的类型与各格取值方式
 * （`constantTargetFields`），再按主格类型定 `valueType` / `writes`。这个键在着色器里没有 uniform（`slot` 为空）时 WPE 没有描述符、
 * 不建绑定，什么都不做：`uniforms` 为空、`writes` 为假。
 */
export function settleConstantAnimation(animation: SceneAnimation, slot: MaterialSlot | undefined): void {
  const target = animation.target;
  if (target.kind !== "constant") return;
  if (slot) Object.assign(target, constantTargetFields(slot));
  else target.uniforms = [];
  animation.valueType = animationType(target.type);
  animation.writes = !!slot && animationWrites(animation.valueType, animation.channels.length);
}
