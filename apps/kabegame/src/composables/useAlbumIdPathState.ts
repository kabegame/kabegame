import { computed } from "vue";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { IS_WEB } from "@kabegame/core/env";

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
 * 当前选中画册的祖先 id 链状态。settings 机制（初始化/watch/save）零改动——
 * `albumIdPath`（query backend）与 `albumIdPathLocal`（localStorage backend）
 * 是两个独立设置项，平台差异全部收拢在本 composable 一处：
 * - 桌面/Android：读优先 query（深链可见），否则回退 localStorage 记忆（重启恢复
 *   上次选中）；写两者同步写。
 * - web：只走 query——URL 即完整状态，无 localStorage 记忆（新开页面回默认收藏，
 *   不残留上次会话的选中）。
 */
export function useAlbumIdPathState() {
  const settings = useSettingsStore();

  const albumIdPath = computed(
    () =>
      (settings.values.albumIdPath ||
        (IS_WEB ? "" : settings.values.albumIdPathLocal) ||
        "") as string,
  );

  const set = async (
    chain: string,
    opts?: { history?: "push" | "replace" },
  ): Promise<void> => {
    const saveQuery = settings.save("albumIdPath", chain, {
      history: opts?.history ?? "replace",
    });
    if (IS_WEB) {
      await saveQuery;
      return;
    }
    await Promise.all([saveQuery, settings.save("albumIdPathLocal", chain)]);
  };

  return { albumIdPath, set };
}
