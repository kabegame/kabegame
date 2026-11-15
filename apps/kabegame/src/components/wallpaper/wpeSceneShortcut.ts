/**
 * 场景宿主 → 应用页的快捷方式启动请求（P11d，`postMessage`）。
 *
 * 场景脚本跑在宿主页里一个同源、没加沙箱的 iframe 里，能拿到 `parent` 乃至宿主的 IPC 桥，宿主里的门禁（回调类别、点击令牌、
 * 属性已配好）只保证守规矩的脚本行为同 WPE。安全边界在这里：`WpeSceneView` 收到请求后核对来源是自己的 iframe、
 * 自己是可交互的实例、`navigator.userActivation` 仍有效（真实用户输入的标记，页面伪造不了）、同一属性 1 秒内至多一次，
 * 再以**自己持有的图片 id** 调 `wpe_open_user_shortcut`（只开给主窗口与壁纸窗口的应用页，宿主与网页壁纸调不到）。
 * 消息里只有属性名，图片 id 与启动目标都不取自消息。
 *
 * 宿主不能 import 应用的代码，字面量在 `apps/wpe-scene/src/shortcut/message.ts` 另写一份，`wpeSceneShortcut.test.ts` 读那个文件比对。
 */

export const WPE_SCENE_SHORTCUT = "kabegame:wpe-scene-shortcut";

/** 属性名的长度范围（字符数）。 */
export const WPE_SHORTCUT_NAME_MAX = 256;

/** 同一属性两次启动请求的最短间隔：用户激活有效期内（约 5 秒）恶意脚本最多每秒重复一次。 */
export const WPE_SHORTCUT_THROTTLE_MS = 1000;

/** 认出宿主的快捷方式请求，返回属性名；不是这条消息、名字不是 1–256 长度的字符串时 null。 */
export function wpeShortcutName(data: unknown): string | null {
  if (!data || typeof data !== "object" || (data as { type?: unknown }).type !== WPE_SCENE_SHORTCUT) return null;
  const { name } = data as { name?: unknown };
  if (typeof name !== "string" || name.length < 1 || name.length > WPE_SHORTCUT_NAME_MAX) return null;
  return name;
}

/** 按属性名节流：`take(name)` 距这个名字上次放行不足间隔时返回 false（不更新时间），否则记下并放行。 */
export function createShortcutThrottle(
  intervalMs: number = WPE_SHORTCUT_THROTTLE_MS,
  now: () => number = () => Date.now(),
): { take(name: string): boolean } {
  const last = new Map<string, number>();
  return {
    take(name) {
      const at = now();
      const previous = last.get(name);
      if (previous !== undefined && at - previous < intervalMs) return false;
      last.set(name, at);
      return true;
    },
  };
}
