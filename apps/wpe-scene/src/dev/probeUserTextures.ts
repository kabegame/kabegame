/**
 * dev 探针的用户纹理（P11b 步骤 2）：确定性回放（`renderFrame`）没有宿主，自己建一份来源表、对 bundle 的属性来源按 `userProperties` 的值
 * 预先解码并等完，再交给 `GpuScene.build`，同宿主的 `primeUserTextures`：读回那一帧就是用户图，不会赶在解码前画出缺省纹理。
 * 没有属性来源的 bundle 不建（返回 undefined），逐字节同以前。
 */
import type { SceneBundle } from "../compile/bundle";
import type { SceneReader } from "../compile/fs";
import { UserTextureSources } from "../usertex/sources";

export async function prepareProbeUserTextures(
  bundle: Pick<SceneBundle, "userTextures">,
  userProperties: Record<string, unknown> | undefined,
  reader: Pick<SceneReader, "readWhole">,
): Promise<UserTextureSources | undefined> {
  const names = (bundle.userTextures ?? []).filter((source) => source.kind === "property").map((source) => source.name);
  if (!names.length) return undefined;
  const sources = new UserTextureSources((path) => reader.readWhole(path));
  await sources.prime(
    names.map((name) => {
      const value = userProperties?.[name];
      return [name, typeof value === "string" ? value : ""] as const;
    }),
  );
  return sources;
}
