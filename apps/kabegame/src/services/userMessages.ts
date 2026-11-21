//! 后端给用户的提示（`user-message` 事件）：后端往前端发提示的统一通道，主窗口在这里收、用看板娘显示。
//!
//! 后端 `GlobalEmitter::emit_user_message(级别, 键, 参数)` 广播，Tauri 的各窗口与 Web 版的 SSE 都收得到；只有主窗口
//! （`App.vue`）初始化本服务，壁纸窗口等没有看板娘的地方发生的事也在这里显示一次。`key` 是前端 i18n 的完整键，按当前语言
//! 翻译、填入 `params`；`kameMessage` 在看板娘被挡住（全屏预览等）时自己降级成提示消息。

import { listen, type UnlistenFn } from "@/api/rpc";
import { i18n } from "@kabegame/i18n";
import { kameMessage } from "@/utils/kameMessage";
import { logger } from "@/utils/logger";

export type UserMessageLevel = "info" | "success" | "warning" | "error";

/** 与后端 `AppEvent::UserMessage` 的字段一致 */
export interface UserMessagePayload {
  level: UserMessageLevel;
  key: string;
  params?: unknown;
}

const LEVELS: readonly UserMessageLevel[] = ["info", "success", "warning", "error"];

/** 按当前语言翻译并交给看板娘；级别不认识时按 `info`，参数不是对象时按没有参数。 */
export function showUserMessage({ level, key, params }: UserMessagePayload): void {
  const named =
    params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};
  const text = i18n.global.t(key, named);
  kameMessage[LEVELS.includes(level) ? level : "info"](text);
}

let unlisten: UnlistenFn | null = null;

export async function init(): Promise<void> {
  if (unlisten) return;
  try {
    unlisten = await listen<UserMessagePayload>("user-message", (event) => showUserMessage(event.payload));
  } catch (error) {
    logger.warn(`监听后端的用户提示失败: ${error}`);
  }
}

export function dispose(): void {
  unlisten?.();
  unlisten = null;
}
