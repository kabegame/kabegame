/**
 * dev 探针的系统媒体回放（P11c 步骤 2，`renderFrame` 的 `media`）：确定性回放没有宿主、没有订阅与计时器，按请求给的 `[{ frame, messages }]`
 * 在第 `frame` 帧之前把这批消息并进一个 `MediaPending`、立刻 `flush` 进场景队列（不走计时器），这一帧脚本阶段开头取空、逐条派发，
 * 顺序与宿主 `drainMedia` 相同（`media/scene.ts`）。`frame` 从 1 起，同 `particles.dts`（第 i 项是第 i + 1 帧）；没有回放时读回帧是第 1 帧。
 *
 * 封面要等解码完才算并入，而回放循环是同步的：所以建回放之前就把每一步的消息按帧序并进同一个 pending、等解码完、`flush` 成事件存起来
 * （`createProbeMedia` 是异步的），回放时只按帧取。同一个 pending 贯穿全部步骤，合并语义（同类只留最后一条、flags 按位或、值留作缓存）与宿主相同。
 *
 * 封面增量的落点：位图交来源表（`provide`）、名字写进用户纹理的绑定目标（`planApply` → `SceneState.write`，来源表解码完成时标脏、下一次 `sync`
 * 换上）、脚本的 `applyUserProperties`（只收到 `{}`）与 `engine.userProperties`。没有脚本时只做前两项，回调是空操作。
 */
import { mergeProperties, planApply, type UserProperty } from "../compile/bindings";
import type { SceneBundle } from "../compile/bundle";
import { scriptMediaCallbacks } from "../media/events";
import { MediaPending, type MediaPendingDeps } from "../media/pending";
import { SceneMedia, type MediaCallbacks, type MediaDelta, type SceneMediaSnapshot } from "../media/scene";
import type { MediaEvent } from "../media/types";
import type { SceneState } from "../render/state";
import type { UserTextureSources } from "../usertex/sources";

/** `renderFrame` 的 `media` 的一项：第 `frame` 帧（1 起）之前并入的消息（形状同后端场景投影，`SceneMediaMessage`）。 */
export interface ProbeMediaStep {
  frame: number;
  messages: ({ type: string } & Record<string, unknown>)[];
}

/** 校验 `media`：数组，每项 `{ frame: 正整数, messages: 对象数组（每个有字符串 type） }`；缺省返回 undefined，不合法抛 RangeError（编译之前查）。 */
export function checkProbeMedia(value: unknown): ProbeMediaStep[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new RangeError(`media 要是数组（每项 { frame, messages }），收到 ${JSON.stringify(value)}`);
  value.forEach((step, index) => {
    const item = step as Partial<ProbeMediaStep> | null;
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new RangeError(`media[${index}] 要是 { frame, messages }，收到 ${JSON.stringify(step)}`);
    if (typeof item.frame !== "number" || !Number.isInteger(item.frame) || item.frame < 1)
      throw new RangeError(`media[${index}].frame 要是从 1 起的整数（第几帧之前），收到 ${JSON.stringify(item.frame)}`);
    if (
      !Array.isArray(item.messages) ||
      item.messages.some((message) => !message || typeof message !== "object" || typeof message.type !== "string")
    )
      throw new RangeError(`media[${index}].messages 要是消息数组（每条是带字符串 type 的对象）`);
  });
  return value as ProbeMediaStep[];
}

export interface ProbeMediaInput {
  steps: readonly ProbeMediaStep[];
  bundle: Pick<SceneBundle, "bindings">;
  state: SceneState;
  /** 来源表（有属性或封面来源时探针才建）；没有时封面位图直接关掉。 */
  sources: UserTextureSources | undefined;
  /** 脚本看到的用户属性全集（探针自己的 Map，增量并进去）。 */
  properties: Map<string, UserProperty>;
  /** 当前的脚本运行时接口（建好之后才有，所以每次现取）。 */
  scripts: () => {
    mediaCallbacks?(): MediaCallbacks;
    applyProperties?(delta: Record<string, UserProperty>, full: ReadonlyMap<string, UserProperty>): void;
  } | null;
  /** 测试注入假的封面解码。 */
  pending?: Partial<MediaPendingDeps>;
}

export interface ProbeMediaResult {
  /** 请求的步骤数与切出的事件数。 */
  steps: number;
  events: number;
  /** 回放结束时场景媒体状态的快照。 */
  scene: SceneMediaSnapshot;
  /** 每个事件的 flags，按派发先后：`frame` 与 `flags`。 */
  drained: { frame: number; flags: number }[];
}

export interface ProbeMedia {
  /** 脚本 `init` 之后的补发（`createProbeScripts` 的 `media`）。 */
  replayAfterInit(callbacks: MediaCallbacks): void;
  /** 第 `frame` 帧（1 起）脚本阶段开头：该帧之前的事件入队，再取空队列派发。 */
  beforeFrame(frame: number): void;
  result(): ProbeMediaResult;
  dispose(): void;
}

/** 建探针的媒体回放：按帧序并入、等封面解码完、切成事件存好。 */
export async function createProbeMedia(input: ProbeMediaInput): Promise<ProbeMedia> {
  const pending = new MediaPending(input.pending);
  const byFrame = new Map<number, MediaEvent[]>();
  const frames = [...new Set(input.steps.map((step) => step.frame))].sort((a, b) => a - b);
  let events = 0;
  for (const frame of frames) {
    for (const step of input.steps)
      if (step.frame === frame) for (const message of step.messages) pending.push(message);
    // 要等封面解码完再画这一帧
    await pending.settled();
    const flushed = pending.flush();
    events += flushed.length;
    byFrame.set(frame, flushed);
  }
  const scene = new SceneMedia();
  const drained: { frame: number; flags: number }[] = [];
  // 来源表解码完成（这里是当场）→ 标脏，下一次 `sync` 换上；运行中写进用户纹理目标时同步交给来源表
  if (input.sources) {
    const sources = input.sources;
    input.sources.onReady = (name) => input.state.touchUserTexture(name);
    input.state.onUserTexture = (name, value) => sources.setValue(name, value);
  }
  const applyDelta = (delta: MediaDelta) => {
    const changes = mergeProperties(input.properties, delta as unknown as Record<string, UserProperty>);
    if (!changes.size) return;
    for (const { binding, value } of planApply(input.bundle.bindings, changes).writes)
      input.state.write(binding, value);
    input
      .scripts()
      ?.applyProperties?.(
        Object.fromEntries([...changes].map(([key]) => [key, input.properties.get(key)!])),
        input.properties,
      );
  };
  let disposed = false;
  return {
    replayAfterInit: (callbacks) => scene.replayAfterInit(callbacks),
    beforeFrame(frame) {
      if (disposed) return;
      const due = byFrame.get(frame);
      byFrame.delete(frame);
      for (const event of due ?? []) {
        drained.push({ frame, flags: event.flags });
        scene.push(event);
      }
      if (!scene.queued) return;
      scene.drain({
        ...(input.scripts()?.mediaCallbacks?.() ?? scriptMediaCallbacks(null)),
        cover: (name, image, delta) => {
          if (input.sources) input.sources.provide(name, image);
          else (image?.source as { close?: () => void } | undefined)?.close?.();
          applyDelta(delta);
        },
      });
    },
    result: () => ({ steps: input.steps.length, events, scene: scene.snapshot(), drained: [...drained] }),
    dispose() {
      disposed = true;
      pending.dispose();
      scene.discard();
      for (const list of byFrame.values())
        for (const event of list) (event.cover?.image?.source as { close?: () => void } | undefined)?.close?.();
      byFrame.clear();
    },
  };
}
