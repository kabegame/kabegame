import { onUnmounted, shallowRef, watchEffect, type ShallowRef } from "vue";

const APP_NAME = "Kabegame";
type TitlePart = "preview" | "subject";
type TitleSource = { get: () => string | null | undefined };
const parts: Record<TitlePart, ShallowRef<TitleSource | null>> = {
  preview: shallowRef(null),
  subject: shallowRef(null),
};

/** 视图 / 预览弹窗登记一段；卸载时只撤自己登记的那份。 */
export function useWindowTitlePart(part: TitlePart, get: TitleSource["get"]): void {
  const source = { get };
  parts[part].value = source;
  onUnmounted(() => {
    if (parts[part].value === source) parts[part].value = null;
  });
}

/** App 根组件调用一次，路由、内容或语言变化时同步文档标题。 */
export function useWindowTitleSync(section: () => string): void {
  watchEffect(() => {
    document.title = [parts.preview.value?.get(), parts.subject.value?.get(), section(), APP_NAME]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(" - ");
  });
}

/** 图片标题名：显示名 → 本地路径文件名 → 空段。 */
export function imageTitleName(img: { displayName?: string | null; localPath?: string } | null | undefined): string {
  if (img?.displayName) return img.displayName;
  if (!img?.localPath) return "";
  // 同时支持 Windows 与 Unix 路径分隔符。
  return img.localPath.split(/[/\\]/).pop() || img.localPath;
}
