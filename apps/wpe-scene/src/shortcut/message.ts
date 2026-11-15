/**
 * 场景宿主 → 父页面（`WpeSceneView`）的快捷方式启动请求（P11d，`postMessage`）。
 *
 * 脚本跑在宿主页里一个同源、没加沙箱的 `about:blank` iframe 里，能拿到 `parent`，所以宿主里的门禁（回调类别、点击令牌、属性已配好）只保证守规矩的
 * 脚本行为同 WPE，挡不住故意绕过的脚本。安全边界在应用页：`WpeSceneView` 收到请求后核对来源是自己的 iframe、自己可交互、`navigator.userActivation`
 * 仍有效、同一属性 1 秒内至多一次，再以**自己持有的图片 id** 调 `wpe_open_user_shortcut`（只开给应用页，宿主调不到）。消息里只有属性名。
 *
 * 宿主不能 import 应用的代码，字面量另写一份在 `apps/kabegame/src/components/wallpaper/wpeSceneShortcut.ts`，那边的测试读这个文件比对。
 */
export const SCENE_SHORTCUT_MESSAGE = "kabegame:wpe-scene-shortcut";

/** 属性名的长度上限（应用页同样只认 1–256）。 */
export const SHORTCUT_NAME_MAX = 256;

export interface SceneShortcutRequest {
  type: typeof SCENE_SHORTCUT_MESSAGE;
  name: string;
}

/** 发给父页面的请求（`postMessage` 的数据）。 */
export function shortcutRequest(name: string): SceneShortcutRequest {
  return { type: SCENE_SHORTCUT_MESSAGE, name };
}
