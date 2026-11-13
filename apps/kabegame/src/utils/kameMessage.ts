import type { KameMessageType } from "../stores/kameMessage";
import { useKameMessageStore } from "../stores/kameMessage";
import { useSettingsStore } from "../stores/settings";
import { toast } from "@/components/ui/toast";

type KameMessageOptions = {
  type?: KameMessageType;
  message?: unknown;
  duration?: number;
  [key: string]: unknown;
};

type MessageInput = string | KameMessageOptions;

type KameMessageApi = {
  (opts: MessageInput): void;
  success: (message: unknown) => void;
  info: (message: unknown) => void;
  warning: (message: unknown) => void;
  error: (message: unknown) => void;
  closeAll: () => void;
};

const normalizeText = (message: unknown) => {
  if (message && typeof message === "object" && "message" in message) {
    return normalizeText((message as { message?: unknown }).message);
  }
  if (message == null) return "";
  if (typeof message === "string") return message;
  return String(message);
};

const push = (type: KameMessageType, message: unknown, duration?: number) => {
  const text = normalizeText(message);
  const settingsStore = useSettingsStore();
  const store = useKameMessageStore();

  // kamechan 被遮住（如全屏图片预览隐藏了它）时气泡看不见，降级到提示消息
  if (settingsStore.values.kamechanEnabled !== false && !store.kamechanHidden) {
    store.push(type, text, duration);
    return;
  }

  store.pushToHistory(type, text);
  // 提示消息的层级在推送时向全局计数器取号，自然压在预览、弹窗之上
  toast({ type, message: text, duration });
};

export const kameMessage = ((opts: MessageInput) => {
  if (typeof opts === "string") {
    push("info", opts);
    return;
  }
  push(opts.type ?? "info", opts.message, opts.duration);
}) as KameMessageApi;

kameMessage.success = (message: unknown) => push("success", message);
kameMessage.info = (message: unknown) => push("info", message);
kameMessage.warning = (message: unknown) => push("warning", message);
kameMessage.error = (message: unknown) => push("error", message);
kameMessage.closeAll = () => {
  useKameMessageStore().closeAll();
  toast.closeAll();
};
