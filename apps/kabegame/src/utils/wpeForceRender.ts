import { i18n } from "@kabegame/i18n";
import { messageBox } from "@/components/ui/messageBox";

/**
 * 打开场景壁纸「强制渲染」之前的确认（用户定：从哪里打开都弹同一个）：设置页与预览侧栏经字段组 `WpeSettingsFields`，
 * 预览缩略图底部的「我就要看」经预览弹窗。确认返回 true；取消、关掉对话框返回 false。关掉强制渲染不确认。
 */
export async function confirmWpeForceRender(): Promise<boolean> {
  const t = i18n.global.t;
  try {
    await messageBox.confirm(t("settings.wpeSceneForceRenderConfirm"), t("settings.wpeSceneForceRenderConfirmTitle"), {
      confirmButtonText: t("settings.wpeSceneForceRenderConfirmOk"),
      cancelButtonText: t("common.cancel"),
      type: "warning",
      danger: true,
    });
    return true;
  } catch {
    return false;
  }
}
