/**
 * 场景属性关键帧动画：编译期（Worker）产出、渲染期（主线程）消费的纯数据（P10a）。只有数、字符串、数组与普通对象，结构化克隆安全。
 *
 * 依据：`.claude/plans/wpe-import/3-scene/phase10/phase-10a-curves.md` 步骤 1，语义见 `rea-p10-keyframes.md`。
 */
import type { BindingTarget } from "../compile/bindings";
import type { ParsedKey } from "./curve";

/** 时钟模式（读码第 3 节，`options.mode`）：`"mirror"` 1，`"single"` 2，其它或缺省 0（loop）。常量见 `clock.ts`。 */
export type AnimationMode = 0 | 1 | 2;

/**
 * 属性的值类型。WPE 只写 float / vec2 / vec3 / vec4 四种（读码第 10 节），`angles` 按 vec3 写（弧度，不换算）；
 * 其它（布尔、整数、字符串）求值但不写。
 */
export type AnimationValueType = "float" | "vec2" | "vec3" | "vec4" | "angles" | "other";

/** 编译期的时钟参数（读码第 3、5 节）。`random`、`wraploop` 不在这里：前者运行时没有读者，后者加载时已作用在通道上。 */
export interface AnimationClockParams {
  /** `options.fps` 原值，时钟构造时转 float32。 */
  fps: number;
  /** `asInt(options.length)`。 */
  length: number;
  mode: AnimationMode;
  startpaused: boolean;
}

/** 一个动画事件（读码第 8 节）：`time = f(f(frame) × spf)`；`json` 是整个事件对象照 jsoncpp 序列化（键按字母序、8 位有效数字）。 */
export interface AnimationEventDef {
  time: number;
  json: string;
}

/** 一条关键帧动画：`scene.json` 里的一处 `{animation: {…}, value}`。 */
export interface SceneAnimation {
  /** `scene.json` 路径，稳定键，如 `"objects/12/origin"`、`"objects/3/effects/0/passes/0/constantshadervalues/multiply"`。 */
  id: string;
  /** 与字段脚本同一套推导；常量目标在编译 pass 时补 `uniforms`。 */
  target: BindingTarget;
  valueType: AnimationValueType;
  /** 每个 `cN` 一条，`parseChannel` + `applyWraploop` 之后。 */
  channels: ParsedKey[][];
  clock: AnimationClockParams;
  /** 父动画在 `bundle.animations` 里的下标（同一对象、按属性名找到的那条，读码第 7 节）；有父时只借父的时钟。 */
  parent: number | null;
  events: AnimationEventDef[];
  /** 通道数等于分量数，且类型是 float / vec2 / vec3 / vec4（`angles` 按 vec3）。为假时不写，字段保持 `value`（读码第 5 节）。 */
  writes: boolean;
  /** `options.name`：不是字符串（或 `options` 不是对象）时为空串（WPE `B+0x68`）。`getAnimation` 按它或属性名找（P10b）。 */
  name: string;
  /** 所属场景对象：`objects` 下标，`general` 的为 null。事件的接收范围（读码第 8 节；P10b 步骤 0 Q3）。 */
  object: number | null;
  /**
   * 属主路径：`id` 去掉最后一段（图层字段 `objects/3`、effect 常量 `…/passes/0/constantshadervalues`、effect 的 `visible`
   * `objects/3/effects/1`、`general`）。`getAnimation` 的查找范围与联动的父都在同一属主内（P10b 步骤 0 Q1、Q2：联动按 pass 算）。
   */
  owner: string;
  /**
   * 整条丢弃（`clockOf` 为 null：`options` 不合法、`fps` / `length` 不合格）：WPE 照样登记、`getAnimation` 找得到，时钟不走、不写
   * （读码第 5 节第 1 条，P10b 步骤 0 Q7）。此时 `writes` 为假、`channels` 与 `events` 为空、`clock` 是惰性时钟的参数。
   */
  inert: boolean;
}

/**
 * 时钟一帧收到的一个事件，派发给脚本运行时的内容（P10b：`AnimationHooks.event` 的参数，也是探针记下的事件）。
 * 在越过它的那一条写完之后、下一条之前同步派发（读码第 1 节第 3 条、第 8 节）。
 */
export interface AnimationEventRecord {
  /**
   * 时钟主人在 `bundle.animations` 里的下标：WPE 按它所在的对象（或 `general`）找导出了 `animationEvent` 的脚本（读码第 8 节）。
   * 子动画借父的时钟，事件只来自父自己的 `events`。
   */
  animation: number;
  /** 主人所属的场景对象（`SceneAnimation.object`）：事件按图层发，`general` 的为 null。 */
  object: number | null;
  /** 同 `AnimationEventDef.json`，派发时 `JSON.parse` 成 `AnimationEvent`。 */
  json: string;
}
