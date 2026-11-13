/**
 * dev 探针建场景前排好文本层（P6b 1d）：探针不走宿主的 `reload`，直接调 `GpuScene.build`，文本层要的排版结果在这里按宿主同一套做法
 * 准备（`text/host.ts` 的 `SceneTexts`：每次新建图集、按对象顺序排、缺字体就读完重排）。没有文本层时不碰 wasm。
 *
 * 结清（P6b 1e-3）：探针写进状态的文本字段（`scriptValues`）在 `sync` 里按重排器重排；缺字体时重排器保留旧排版、后台读字体，宿主靠帧循环
 * 下一帧补上，探针没有帧外的补画，读回帧就会画旧文字。所以回放之前 `settle`：`sync` 一次，有字体在读就等读完（`SceneTexts.idle()`，
 * 读完时 `onReady` 已记下那一层），把记下的层重新标脏（`touchText`，同宿主的 `onTextReady`）再 `sync`，直到没有在读的字体。
 */
import type { SceneBundle } from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import type { SceneState } from "../render/state";
import { MAX_FONT_ROUNDS, SceneTexts, type TextRelayouter } from "../text/host";
import type { TextLayout } from "../text/layout";

/** `settle` 要的场景：只调 `sync`（`GpuScene` 满足）。泛型让单测传假的状态。 */
export interface SettleScene<S> {
  sync(state: S): void;
}

export interface ProbeTexts {
  /** 交给 `GpuScene.build` 的 `texts`；没有文本层时为 undefined。 */
  texts: Map<number, TextLayout> | undefined;
  /**
   * 交给 `GpuScene.build` 的 `relayout`（P6b 1e）：探针写进状态的文本字段（`scriptValues`，1e-3）在 `sync` 里按它重排。缺字体时
   * 这一次 `sync` 照画旧排版，由 `settle` 等字体读完再排。没有文本层时为 undefined。
   */
  relayout: TextRelayouter | undefined;
  /**
   * 回放之前把文本字段的重排做完（P6b 1e-3，`settleTexts`）。每轮先 `touchText` 上一轮读完字体的对象，再 `scene.sync(state)`；之后
   * `idle()` 返回 false（没有在读的字体）就结束，否则继续下一轮。读了 `MAX_FONT_ROUNDS` 轮仍有在读的时抛错。返回 `sync` 的次数。
   * 没有文本层时返回 0、不调 sync。
   */
  settle<S extends Pick<SceneState, "touchText">>(scene: SettleScene<S>, state: S): Promise<number>;
  /** 场景用完之后释放字体（图集像素在 JS 里，建场景时已整张上传）；之后重排器不再工作。 */
  dispose: () => void;
}

/**
 * 结清运行中重排（P6b 1e-3，`ProbeTexts.settle` 的实现，单测直接调）：`ready` 是 `onReady` 记下的「字体读完、可以再排」的对象，每轮
 * 开头取空。轮数上限同 `SceneTexts.prepare`（每个对象最多读 `MAX_FONT_ROUNDS` 轮字体）：第 `MAX_FONT_ROUNDS + 1` 次 `sync` 之后
 * 仍有在读的就抛错，不一直等。
 */
export async function settleTexts<S extends Pick<SceneState, "touchText">>(
  owner: Pick<SceneTexts, "idle">,
  ready: Set<number>,
  scene: SettleScene<S>,
  state: S,
): Promise<number> {
  for (let syncs = 1; ; syncs++) {
    // 上一轮读完字体的层重新标脏，这一次 `sync` 按当前字段再排（同宿主 `onTextReady` 的 `touchText`）
    for (const object of ready) state.touchText(object);
    ready.clear();
    scene.sync(state);
    // 没有在读的字体：这次 `sync` 里的重排都排成了（出错的保留旧排版，同宿主），结清
    if (!(await owner.idle())) return syncs;
    if (syncs > MAX_FONT_ROUNDS) {
      throw new Error(`文本重排的字体读了 ${MAX_FONT_ROUNDS} 轮仍有在读的（对象 ${[...ready].join("、") || "?"}）`);
    }
  }
}

export async function prepareProbeTexts(
  bundle: Pick<SceneBundle, "layers">,
  reader: SceneReader,
  sceneAssets: readonly string[],
): Promise<ProbeTexts> {
  if (!bundle.layers.some((layer) => layer.text)) {
    return { texts: undefined, relayout: undefined, settle: async () => 0, dispose: () => {} };
  }
  // 运行中重排读完字体的对象：宿主在这里标脏、补画，探针记下来，`settle` 的下一轮再标脏（P6b 1e-3）
  const ready = new Set<number>();
  const owner = new SceneTexts({ reader, onReady: (object) => ready.add(object) });
  try {
    const texts = (await owner.prepare(bundle, { sceneAssets })) ?? undefined;
    return {
      texts,
      relayout: owner.relayouter() ?? undefined,
      settle: (scene, state) => settleTexts(owner, ready, scene, state),
      dispose: () => owner.dispose(),
    };
  } catch (error) {
    owner.dispose();
    throw error;
  }
}
