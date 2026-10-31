/**
 * 释放 `<video>` 的播放器：暂停、去掉 src、`load()`。
 *
 * 只从 DOM 移除的元素会以暂停状态保留解码器与播放器，直到被 GC：期间占着渲染进程的媒体播放位，
 * 也作为暂停的播放器留在 Chromium 的系统媒体会话里（系统媒体浮窗停在已经切走的视频）。
 */
export function resetVideoElement(el: HTMLVideoElement | null) {
  if (!el) return;
  try {
    el.pause();
    el.removeAttribute("src");
    el.load();
  } catch {
    // ignore
  }
}
