<template>
  <el-dialog
    v-model="taskLogVisible"
    :title="t('tasks.drawerTaskLogTitle')"
    width="640px"
    :append-to-body="true"
    class="task-log-dialog"
  >
    <div class="task-log-list">
      <div v-if="currentTaskLogs.length === 0" class="task-log-empty">{{ t('tasks.drawerNoLogs') }}</div>
      <div
        v-for="log in currentTaskLogs"
        :key="log.id"
        class="task-log-entry"
        :class="`log-level-${log.level}`"
      >
        <div class="task-log-main">
          <el-tag :type="logLevelTagType(log.level)" size="small">{{ log.level }}</el-tag>
          <span class="log-content">{{ formatTaskLogLine(log.content) }}</span>
        </div>
        <div class="task-log-time-row">
          <span class="log-time">{{ formatLogTime(log.time) }}</span>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "@kabegame/i18n";
import { ElMessage } from "element-plus";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useModalBack } from "../../composables/useModalBack";

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

const taskLogVisible = ref(false);
const currentTaskId = ref("");
const currentTaskLogs = ref<TaskLogEntry[]>([]);
const taskLogSeed = ref(0);

useModalBack(taskLogVisible);

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

const logLevelTagType = (level: string): "info" | "warning" | "danger" | "success" => {
  const val = String(level || "").toLowerCase();
  if (val === "error") return "danger";
  if (val === "warn" || val === "warning") return "warning";
  if (val === "debug" || val === "trace") return "info";
  return "success";
};

const openTaskLog = async (taskId: string) => {
  const id = String(taskId || "").trim();
  if (!id) return;
  currentTaskId.value = id;
  taskLogVisible.value = true;
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
    ElMessage.error(t("tasks.drawerLoadLogFailed"));
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

<style scoped lang="scss">
.task-log-list {
  max-height: 420px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  user-select: text;
  -webkit-user-select: text;
}

.task-log-empty {
  text-align: center;
  color: var(--anime-text-secondary);
  padding: 24px 0;
}

.task-log-entry {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid var(--anime-border);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12px;
  user-select: text;
  -webkit-user-select: text;
}

.task-log-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.log-content {
  flex: 1;
  min-width: 0;
  word-break: break-word;
  line-height: 1.5;
}

.task-log-time-row {
  display: flex;
  justify-content: flex-end;
}

.log-time {
  color: var(--anime-text-secondary);
  font-size: 11px;
}

.log-level-warn,
.log-level-warning {
  background: rgba(245, 158, 11, 0.08);
}

.log-level-error {
  background: rgba(239, 68, 68, 0.08);
}
</style>
