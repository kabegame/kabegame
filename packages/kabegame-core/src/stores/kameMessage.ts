import { defineStore } from "pinia";
import { ref } from "vue";

export type KameMessageType = "success" | "info" | "warning" | "error";

export interface KameMessage {
  id: string;
  type: KameMessageType;
  text: string;
  time: number;
}

const HISTORY_LIMIT = 100;
const DURATION_BY_TYPE: Record<KameMessageType, number> = {
  success: 3000,
  info: 3000,
  warning: 4500,
  error: 6000,
};

let messageSeed = 0;

const createMessageId = () => {
  messageSeed = (messageSeed + 1) % 100000;
  return `kame-${Date.now()}-${messageSeed}`;
};

export const useKameMessageStore = defineStore("kameMessage", () => {
  const queue = ref<KameMessage[]>([]);
  const history = ref<KameMessage[]>([]);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const dismiss = (id: string) => {
    queue.value = queue.value.filter((message) => message.id !== id);
    const timer = timers.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(id);
    }
  };

  const push = (type: KameMessageType, text: string, duration?: number) => {
    const message: KameMessage = {
      id: createMessageId(),
      type,
      text,
      time: Date.now(),
    };

    queue.value = [...queue.value, message];
    history.value = [...history.value, message].slice(-HISTORY_LIMIT);

    const resolvedDuration = Number.isFinite(duration) ? Number(duration) : DURATION_BY_TYPE[type];
    if (resolvedDuration > 0) {
      const timer = setTimeout(() => {
        dismiss(message.id);
      }, resolvedDuration);
      timers.set(message.id, timer);
    }

    return message;
  };

  const pushToHistory = (type: KameMessageType, text: string) => {
    const message: KameMessage = {
      id: createMessageId(),
      type,
      text,
      time: Date.now(),
    };

    history.value = [...history.value, message].slice(-HISTORY_LIMIT);
    return message;
  };

  const clearHistory = () => {
    history.value = [];
  };

  const closeKamechanQueue = () => {
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
    queue.value = [];
  };

  const closeAll = closeKamechanQueue;

  return {
    queue,
    history,
    push,
    pushToHistory,
    dismiss,
    clearHistory,
    closeKamechanQueue,
    closeAll,
  };
});
