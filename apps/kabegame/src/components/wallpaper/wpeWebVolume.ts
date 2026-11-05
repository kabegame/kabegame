/**
 * 网页壁纸（`x-wpe/web`）音量的父页面 ↔ 垫片消息协议（`postMessage`），父页面一侧是 `WallpaperStage` 的 web 层。
 *
 * - 垫片启动时向父页面发 `{ type: WPE_VOLUME_REQUEST }`；父页面只理会来自自己当前 iframe 的请求，回
 *   `{ type: WPE_VOLUME_MESSAGE, volume }`；`volume` / `paused` 变化时父页面再主动推同一条消息。
 * - 垫片收到第一条之前按 0（静音）处理；只认 `isTrusted` 且 `source` 是父窗口的消息。
 *
 * 垫片 `src-tauri/kabegame/src/webview_js/wpe_shim.js` 是不经打包的纯脚本，不能 import 这里，按同样的字面量
 * 另写一份；`wpeWebVolume.test.ts` 读垫片源码按这里的常量跑一遍，两边不一致就失败。
 * 协议见 cocs/wpe/WPE_IMPORT.md「运行时垫片与宿主协议」的「音量」。
 */

/** 垫片 → 父页面：请求当前宿主音量（垫片启动时发一次）。 */
export const WPE_VOLUME_REQUEST = "kabegame:wpe-volume-request";
/** 父页面 → 垫片：当前宿主音量（回复请求，或音量变化时主动推）。 */
export const WPE_VOLUME_MESSAGE = "kabegame:wpe-volume";

export interface WpeVolumeRequest {
  type: typeof WPE_VOLUME_REQUEST;
}

export interface WpeVolumeMessage {
  type: typeof WPE_VOLUME_MESSAGE;
  /** 0…1：页面的生效音量 = 页面自己设的音量 × 这个值。 */
  volume: number;
  /** 垫片转交给 wallpaperPropertyListener.setPaused。 */
  paused: boolean;
}

export function isWpeVolumeRequest(data: unknown): data is WpeVolumeRequest {
  return !!data && typeof data === "object" && (data as { type?: unknown }).type === WPE_VOLUME_REQUEST;
}

/** 壁纸音量钳到 0…1；非有限值按 1（与视频层一致）。 */
export function clampWallpaperVolume(volume: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 1));
}

/**
 * 回给网页壁纸的宿主音量：`paused`（页面已被垫片冻结）时为 0，其余就是 Stage 的 `volume` prop
 * ——桌面与预览传设置里的壁纸音量，应用背景传 0。
 */
export function webHostVolume(volume: number, paused: boolean): number {
  return paused ? 0 : clampWallpaperVolume(volume);
}

export function wpeVolumeMessage(volume: number, paused: boolean): WpeVolumeMessage {
  return { type: WPE_VOLUME_MESSAGE, volume, paused };
}
