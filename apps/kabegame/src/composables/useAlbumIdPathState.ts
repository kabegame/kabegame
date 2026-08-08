import { computed } from "vue";
import { useSettingsStore } from "@kabegame/core/stores/settings";

/** 祖先 id 链（`/root/.../self/`）→ 各段 id（从根到自身，均非空）。 */
export function segmentsOfAlbumIdPath(chain: string): string[] {
  return (chain || "").split("/").filter(Boolean);
}

/** 祖先 id 链 → 链末段（= 当前选中画册 id）；空链回退空串。 */
export function lastAlbumIdOf(chain: string): string {
  const segs = segmentsOfAlbumIdPath(chain);
  return segs[segs.length - 1] ?? "";
}

/**
 * 当前选中画册的祖先 id 链状态：读优先 query（深链可见），否则回退 localStorage
 * 记忆；写两者同步写。settings 机制（初始化/watch/save）零改动——`albumIdPath`
 * （query backend）与 `albumIdPathLocal`（localStorage backend）是两个独立设置项，
 * 「优先 query 读、双写」的语义全部收拢在本 composable 一处。
 */
export function useAlbumIdPathState() {
  const settings = useSettingsStore();

  const albumIdPath = computed(
    () => (settings.values.albumIdPath || settings.values.albumIdPathLocal || "") as string,
  );

  const set = async (chain: string): Promise<void> => {
    await Promise.all([
      settings.save("albumIdPath", chain),
      settings.save("albumIdPathLocal", chain),
    ]);
  };

  return { albumIdPath, set };
}
