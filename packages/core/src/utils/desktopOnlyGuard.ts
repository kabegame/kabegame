import { ElMessageBox } from "element-plus";
import { i18n } from "@kabegame/i18n";
import { IS_WEB } from "../env";

const HOMEPAGE = "https://github.com/kabegame/kabegame";

/**
 * 拦截 web mode 下不支持的原生能力，弹窗引导用户前往桌面版。
 * 返回 true 表示已拦截（调用方应直接 return），false 表示正常继续。
 */
export async function guardDesktopOnly(featureKey: string): Promise<boolean> {
  if (!IS_WEB) return false;
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
