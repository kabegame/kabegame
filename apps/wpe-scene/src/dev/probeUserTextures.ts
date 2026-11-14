/**
 * dev 探针的用户纹理（P11b 步骤 2）：确定性回放（`renderFrame`）没有宿主，自己建一份来源表、对 bundle 的属性来源按 `userProperties` 的值
 * 预先解码并等完，再交给 `GpuScene.build`，同宿主的 `primeUserTextures`：读回那一帧就是用户图，不会赶在解码前画出缺省纹理。
 * 没有属性来源的 bundle 不建（返回 undefined），逐字节同以前。GIF / 视频（P11b 步骤 4）：来源表建好就 `setPaused(true)`，GIF 的帧由
 * `renderFrame` 的 `gifDts` 推进，视频的帧由 `videoTime` 经 `seekVideos` 定。
 */
import type { SceneBundle } from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import { mediaKind, UserTextureSources } from "../usertex/sources";

export async function prepareProbeUserTextures(
  bundle: Pick<SceneBundle, "userTextures">,
  userProperties: Record<string, unknown> | undefined,
  reader: Pick<SceneReader, "readWhole">,
): Promise<UserTextureSources | undefined> {
  const names = (bundle.userTextures ?? []).filter((source) => source.kind === "property").map((source) => source.name);
  if (!names.length) return undefined;
  const sources = new UserTextureSources((path) => reader.readWhole(path));
  // 屏外渲染没有实时帧：视频不按真实时间放（帧来自 `seekVideos`），建好立即按暂停处理（P11b 步骤 4）
  sources.setPaused(true);
  await sources.prime(
    names.map((name) => {
      const value = userProperties?.[name];
      return [name, typeof value === "string" ? value : ""] as const;
    }),
  );
  return sources;
}

/** bundle 的属性来源按 `userProperties` 选了视频的那些值（`mediaKind`）：探针据此判断要不要加载视频（`checkVideoVisibility`）。 */
export function userVideoValues(
  bundle: Pick<SceneBundle, "userTextures">,
  userProperties: Record<string, unknown> | undefined,
): string[] {
  return (bundle.userTextures ?? []).flatMap((source) => {
    const value = source.kind === "property" ? userProperties?.[source.name] : undefined;
    return typeof value === "string" && value !== "" && mediaKind(value) === "video" ? [value] : [];
  });
}

/** 校验 `gifDts`：数组，每项有限非负；不合法抛 RangeError（编译之前查）。缺省原样返回 undefined。 */
export function checkGifDts(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new RangeError(`gifDts 要是数组（每项是一帧的 g_Frametime，秒），收到 ${JSON.stringify(value)}`);
  value.forEach((dt, index) => {
    if (typeof dt !== "number" || !Number.isFinite(dt) || dt < 0)
      throw new RangeError(`gifDts[${index}] 要是非负有限数（秒），收到 ${JSON.stringify(dt)}`);
  });
  return value as number[];
}
