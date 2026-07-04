import { ElMessageBox } from "element-plus";
import { i18n } from "@kabegame/i18n";
import { IS_WEB } from "../env";

/**
 * 拦截 web mode 下非 super 用户修改需要管理员权限的设置项，
 * 弹窗提示开启 super 模式。
 * 返回 true 表示已拦截，false 表示正常继续。
 */
export async function guardSuperRequired(): Promise<boolean> {
  if (!IS_WEB) return false;
  const t = i18n.global.t;
  try {
    await ElMessageBox.alert(
      t("web.superRequiredDesc"),
      t("web.superRequiredTitle"),
      {
        confirmButtonText: t("common.ok"),
        type: "warning",
        center: true,
      },
    );
  } catch {
    // 用户关闭
  }
  return true;
}
