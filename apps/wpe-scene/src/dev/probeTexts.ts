/**
 * dev 探针建场景前排好文本层（P6b 1d）：探针不走宿主的 `reload`，直接调 `GpuScene.build`，文本层要的排版结果在这里按宿主同一套做法
 * 准备（`text/host.ts` 的 `SceneTexts`：每次新建图集、按对象顺序排、缺字体就读完重排）。没有文本层时不碰 wasm。
 */
import type { SceneBundle } from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import { SceneTexts, type TextRelayouter } from "../text/host";
import type { TextLayout } from "../text/layout";

export interface ProbeTexts {
  /** 交给 `GpuScene.build` 的 `texts`；没有文本层时为 undefined。 */
  texts: Map<number, TextLayout> | undefined;
  /**
   * 交给 `GpuScene.build` 的 `relayout`（P6b 1e）：探针写进状态的文本字段（`scriptValues`，1e-3）在 `sync` 里按它重排。探针没有帧外的
   * 补画，缺字体时这一帧照画旧排版。没有文本层时为 undefined。
   */
  relayout: TextRelayouter | undefined;
  /** 场景用完之后释放字体（图集像素在 JS 里，建场景时已整张上传）；之后重排器不再工作。 */
  dispose: () => void;
}

export async function prepareProbeTexts(
  bundle: Pick<SceneBundle, "layers">,
  reader: SceneReader,
  sceneAssets: readonly string[],
): Promise<ProbeTexts> {
  if (!bundle.layers.some((layer) => layer.text)) return { texts: undefined, relayout: undefined, dispose: () => {} };
  const owner = new SceneTexts({ reader });
  try {
    const texts = (await owner.prepare(bundle, { sceneAssets })) ?? undefined;
    return { texts, relayout: owner.relayouter() ?? undefined, dispose: () => owner.dispose() };
  } catch (error) {
    owner.dispose();
    throw error;
  }
}
