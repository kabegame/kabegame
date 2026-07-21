import { i18n } from "@kabegame/i18n";
import { openExternalLink } from "@kabegame/core/utils/openExternalLink";
import { ElMessageBox } from "element-plus";
import { useApp } from "@/stores/app";

const KABEGAME_RELEASES_LATEST = "https://github.com/kabegame/kabegame/releases/latest";

/** 读取后端在插件加载期计算的最低应用版本兼容状态。 */
export function isPluginMinAppNotSatisfied(
  plugin: { minAppIncompatible?: boolean } | null | undefined,
): boolean {
  return !!plugin?.minAppIncompatible;
}

type PluginStoreLike = {
  plugins: ReadonlyArray<{
    id: string;
    minAppVersion?: string | null;
    minAppIncompatible?: boolean;
  }>;
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

    if (!isPluginMinAppNotSatisfied(p)) return true;

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
      await openExternalLink(KABEGAME_RELEASES_LATEST);
    } catch {
      /* 取消或关闭 */
    }
    return false;
  };
}
