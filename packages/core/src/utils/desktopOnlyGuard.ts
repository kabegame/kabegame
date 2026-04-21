import { ElMessageBox } from "element-plus";
import { i18n } from "@kabegame/i18n";
import { IS_WEB } from "../env";
import { getIsSuper } from "../state/superState";

const HOMEPAGE = "https://github.com/kabegame/kabegame";

export interface GuardDesktopOnlyOptions {
  /**
   * `true`：仅"非桌面 + 非 super"时拦截；super 用户在 web 端可继续执行。
   * `false` / 省略：web 端一律拦截（即使是 super），用于纯原生能力（picker/share/wallpaper 等）。
   */
  needSuper?: boolean;
}

/**
 * 拦截 web mode 下不支持的原生能力，弹窗引导用户前往桌面版。
 * 返回 true 表示已拦截（调用方应直接 return），false 表示正常继续。
 */
export async function guardDesktopOnly(
  featureKey: string,
  options: GuardDesktopOnlyOptions = {},
): Promise<boolean> {
  if (!IS_WEB) return false;
  if (options.needSuper && getIsSuper()) return false;
  const t = i18n.global.t;
  try {
    await ElMessageBox.confirm(
      t("web.desktopOnlyDesc", { feature: t(`web.feature.${featureKey}`) }),
      t("web.desktopOnlyTitle"),
      {
        confirmButtonText: t("web.goHomepage"),
        cancelButtonText: t("common.cancel"),
        type: "info",
        center: true,
      },
    );
    window.open(HOMEPAGE, "_blank", "noopener,noreferrer");
  } catch {
    // 用户取消
  }
  return true;
}
