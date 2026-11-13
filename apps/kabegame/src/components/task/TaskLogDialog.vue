<template>
  <Dialog v-model:open="isOpen" :title="t('tasks.drawerTaskLogTitle')" :width="640">
    <div class="kb-selectable flex max-h-[420px] flex-col gap-2 overflow-y-auto">
      <div v-if="currentTaskLogs.length === 0" class="py-6 text-center text-[13px] text-kb-fg-muted">
        {{ t("tasks.drawerNoLogs") }}
      </div>
      <div
        v-for="log in currentTaskLogs"
        :key="log.id"
        class="box-border flex flex-col gap-1 rounded-kb-md border border-solid border-kb-line px-2.5 py-2 text-[12px]"
        :class="logEntryClass(log.level)"
      >
        <div class="flex min-w-0 items-baseline gap-2">
          <Tag :tone="logLevelTone(log.level)" size="sm">{{ log.level }}</Tag>
          <span class="min-w-0 flex-1 break-words leading-[1.5] text-kb-fg">{{ formatTaskLogLine(log.content) }}</span>
        </div>
        <div class="flex justify-end">
          <span class="text-[11px] text-kb-fg-subtle">{{ formatLogTime(log.time) }}</span>
        </div>
      </div>
    </div>
  </Dialog>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "@kabegame/i18n";
import { kameMessage } from "@/utils/kameMessage";
import { invoke, listen } from "../../api";
import Dialog from "@/components/ui/Dialog.vue";
import Tag from "@/components/ui/Tag.vue";

type TaskLogEntry = {
  id: number;
  taskId: string;
  level: string;
  content: string;
  time: number;
};

type TaskLogEventPayload = {
  task_id?: string;
  level?: string;
  message?: string;
};

const { t, locale } = useI18n();

const isOpen = ref(false);
const currentTaskId = ref("");
const currentTaskLogs = ref<TaskLogEntry[]>([]);
const taskLogSeed = ref(0);

let unlistenTaskLog: null | (() => void) = null;

const toLocaleTag = (loc: string) => {
  if (loc.startsWith("zh")) return loc === "zhtw" ? "zh-TW" : "zh-CN";
  return loc === "en" ? "en-US" : loc;
};

const formatLogTime = (timestamp: number) => {
  const loc = locale.value ?? "zh";
  return new Date(Number(timestamp || 0)).toLocaleString(toLocaleTag(loc));
};

/** 后端写入的 JSON i18n 载荷或非插件明文日志；插件日志为普通字符串原样显示 */
const formatTaskLogLine = (raw: string) => {
  void locale.value;
  const s = String(raw ?? "").trim();
  if (!s.startsWith("{")) return s;
  try {
    const o = JSON.parse(s) as { _i18n?: { k?: string; p?: Record<string, unknown> } };
    const k = o?._i18n?.k;
    if (!k || typeof k !== "string") return s;
    const p = o._i18n?.p;
    const params: Record<string, string | number> = {};
    if (p && typeof p === "object" && !Array.isArray(p)) {
      for (const [key, val] of Object.entries(p)) {
        if (typeof val === "string" || typeof val === "number") params[key] = val;
        else if (val != null) params[key] = String(val);
      }
    }
    return t(`tasks.${k}`, params);
  } catch {
    return s;
  }
};

const normalizedLevel = (level: string) => String(level || "").toLowerCase();

const logLevelTone = (level: string): "neutral" | "warning" | "danger" => {
  const val = normalizedLevel(level);
  if (val === "error") return "danger";
  if (val === "warn" || val === "warning") return "warning";
  return "neutral";
};

/** 警告 / 错误条目铺一层淡底 */
const logEntryClass = (level: string) => {
  const tone = logLevelTone(level);
  if (tone === "danger") return "bg-[color-mix(in_srgb,var(--kb-danger)_6%,transparent)]";
  if (tone === "warning") return "bg-[color-mix(in_srgb,var(--kb-warning)_8%,transparent)]";
  return "";
};

const openTaskLog = async (taskId: string) => {
  const id = String(taskId || "").trim();
  if (!id) return;
  currentTaskId.value = id;
  isOpen.value = true;
  try {
    const logs = await invoke<any[]>("get_task_logs", { taskId: id });
    currentTaskLogs.value = (Array.isArray(logs) ? logs : []).map((log, idx) => ({
      id: Number(log?.id ?? idx + 1),
      taskId: String(log?.taskId ?? log?.task_id ?? id),
      level: String(log?.level ?? "info"),
      content: String(log?.content ?? log?.message ?? ""),
      time: Number(log?.time ?? Date.now()),
    }));
  } catch (error) {
    console.error("加载任务日志失败:", error);
    currentTaskLogs.value = [];
    kameMessage.error(t("tasks.drawerLoadLogFailed"));
  }
};

onMounted(async () => {
  try {
    unlistenTaskLog = await listen<TaskLogEventPayload>("task-log", (event) => {
      const raw = (event.payload as TaskLogEventPayload) || {};
      const taskId = String(raw.task_id ?? "").trim();
      if (!taskId) return;
      if (taskId !== currentTaskId.value) return;
      const level = String(raw.level ?? "info").trim() || "info";
      const content = String(raw.message ?? "").trim();
      const nextId = Date.now() * 1000 + (taskLogSeed.value++ % 1000);
      currentTaskLogs.value.push({
        id: nextId,
        taskId,
        level,
        content,
        time: Date.now(),
      });
    });
  } catch (error) {
    console.error("监听 task-log 失败:", error);
  }
});

onUnmounted(() => {
  try {
    unlistenTaskLog?.();
  } catch {
    // ignore
  } finally {
    unlistenTaskLog = null;
  }
});

defineExpose({ openTaskLog });
</script>
