import { i18n } from "@kabegame/i18n";
import { compareVersions } from "@kabegame/core/utils/version";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ElMessageBox } from "element-plus";
import { useApp } from "@/stores/app";

const KABEGAME_RELEASES_LATEST = "https://github.com/kabegame/kabegame/releases/latest";

/** 插件声明了 minAppVersion 且能读到当前应用版本时，判断当前是否低于要求 */
export function isPluginMinAppNotSatisfied(
  plugin: { minAppVersion?: string | null } | null | undefined,
  appVersion: string | null | undefined,
): boolean {
  const minV = (plugin?.minAppVersion ?? "").trim();
  if (!minV) return false;
  const cur = (appVersion ?? "").trim();
  if (!cur) return false;
  return compareVersions(cur, minV) < 0;
}

type PluginStoreLike = {
  plugins: ReadonlyArray<{ id: string; minAppVersion?: string | null }>;
};

/**
 * 创建爬虫 `addTask` 前置守卫：当前应用版本低于插件 `minAppVersion` 时弹窗并可选打开 Release 页。
 * @returns `true` 允许创建任务；`false` 用户取消或版本不满足已处理。
 */
export function createMinAppVersionBeforeAddTaskGuard(pluginStore: PluginStoreLike) {
  return async function minAppVersionBeforeAddTaskGuard(pluginId: string): Promise<boolean> {
    const p = pluginStore.plugins.find((x) => x.id === pluginId);
    const minV = (p?.minAppVersion ?? "").trim();
    if (!minV) return true;

    const appV = useApp().version;
    const cur = (appV ?? "").trim();
    if (!cur) return true;

    if (!isPluginMinAppNotSatisfied(p, appV)) return true;

    const t = i18n.global.t;
    try {
      await ElMessageBox.confirm(
        t("plugins.minAppVersionBlockedMessage", { required: minV, current: cur }),
        t("plugins.minAppVersionBlockedTitle"),
        {
          type: "warning",
          confirmButtonText: t("plugins.docReleaseLinkText"),
          cancelButtonText: t("common.cancel"),
          distinguishCancelAndClose: true,
        },
      );
      await openUrl(KABEGAME_RELEASES_LATEST);
    } catch {
      /* 取消或关闭 */
    }
    return false;
  };
}
