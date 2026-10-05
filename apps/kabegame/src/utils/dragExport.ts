// #region debug-drag
import { sendDebugEvent } from "../debugIngest";
// #endregion debug-drag
/** Rust 侧同名常量见 `src-tauri/tauri-runtime-cef/src/webview.rs`。 */
export const DRAG_IMAGE_ID_MIME = "application/x-kabegame-image-id";

/**
 * 应用内拖拽的起手时刻（0 = 无）。
 *
 * 不能用 `dragend` 判断拖拽结束：Linux CEF 上原生拖拽一交给系统，页面的 `dragend`
 * 就在 ~20ms 内触发，早于 Tauri 的第一个 enter/over（实测见 FILE_DROP_ZONES.md）。
 * 所以只记起手时刻，由 useFileDrop 在拖放会话开始时「认领」：起手后很短时间内开始的
 * 会话就是这次内部拖拽，整段会话静默到 drop/leave。
 */
let internalDragStartedAt = 0;
/** 起手到 Tauri 首个拖放事件的实测间隔约 30ms，1s 足够宽松又不会误认后续外部拖入 */
const INTERNAL_DRAG_CLAIM_WINDOW_MS = 1000;

/** 本应用发起原生拖拽时调用（ImageContent 的 dragstart） */
export function beginInternalDrag(): void {
  internalDragStartedAt = Date.now();
  // #region debug-drag
  void sendDebugEvent("drag_begin", null, { sessionId: "drag-internal" });
  // #endregion debug-drag
}

/** 拖放会话开始时调用一次：若刚刚有应用内起手则认领并返回 true；无论结果都清空起手记录 */
export function claimInternalDrag(): boolean {
  const startedAt = internalDragStartedAt;
  internalDragStartedAt = 0;
  return startedAt > 0 && Date.now() - startedAt <= INTERNAL_DRAG_CLAIM_WINDOW_MS;
}
