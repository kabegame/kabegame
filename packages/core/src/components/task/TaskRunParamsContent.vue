<template>
  <div class="task-run-params">
    <el-descriptions :title="t('tasks.taskRunParamsSectionPlugin')" :column="2" border size="small"
      class="params-desc-block">
      <el-descriptions-item :label="t('tasks.taskRunParamsColSource')" :span="2">
        <div class="plugin-source-cell">
          <div class="plugin-icon-box" aria-hidden="true">
            <el-image v-if="pluginIconDisplayUrl" :src="pluginIconDisplayUrl" fit="contain" class="plugin-icon-img" />
            <el-icon v-else class="plugin-icon-fallback">
              <Grid />
            </el-icon>
          </div>
          <span class="plugin-name-text">{{ getPluginName(task.pluginId) }}</span>
        </div>
      </el-descriptions-item>
    </el-descriptions>

    <el-descriptions v-if="showTimeSection" :title="t('tasks.taskRunParamsSectionTime')" :column="2" border size="small"
      class="params-desc-block">
      <el-descriptions-item v-if="hasStartTime" :label="t('tasks.taskRunParamsColStartTime')">
        <span class="cell-with-icon">
          <el-icon class="cell-icon">
            <Clock />
          </el-icon>
          {{ formatDate(task.startTime!) }}
        </span>
      </el-descriptions-item>
      <el-descriptions-item :label="t('tasks.taskRunParamsColEndTime')">
        <span v-if="task.endTime" class="cell-with-icon">
          <el-icon class="cell-icon">
            <Clock />
          </el-icon>
          {{ formatDate(task.endTime) }}
        </span>
        <span v-else-if="hasStartTime">{{ t("tasks.drawerParamInProgress") }}</span>
        <span v-else class="text-muted">—</span>
      </el-descriptions-item>
      <el-descriptions-item v-if="hasStartTime" :label="t('tasks.taskRunParamsColDuration')" :span="2">
        {{
          formatDuration(task.startTime!, task.endTime != null ? task.endTime : undefined)
        }}
      </el-descriptions-item>
    </el-descriptions>

    <el-descriptions v-if="showStatsSection" :title="t('tasks.taskRunParamsSectionStats')" :column="2" border
      size="small" class="params-desc-block">
      <el-descriptions-item v-if="(task.deletedCount ?? 0) > 0" :label="t('tasks.taskRunParamsColDeleted')">
        {{ t("tasks.drawerDeletedCount", { n: task.deletedCount ?? 0 }) }}
      </el-descriptions-item>
      <el-descriptions-item v-if="(task.dedupCount ?? 0) > 0" :label="t('tasks.taskRunParamsColDedup')">
        {{ t("tasks.drawerDedupCount", { n: task.dedupCount ?? 0 }) }}
      </el-descriptions-item>
    </el-descriptions>

    <el-descriptions v-if="task.outputDir" :title="t('tasks.taskRunParamsSectionOutput')" :column="1" border
      size="small" class="params-desc-block">
      <el-descriptions-item :label="t('tasks.taskRunParamsColOutputDir')" :span="2">
        <span class="break-all">{{ task.outputDir }}</span>
      </el-descriptions-item>
    </el-descriptions>

    <el-descriptions v-if="visibleConfigEntries.length > 0" :title="t('tasks.taskRunParamsSectionConfig')" :column="1"
      border size="small" class="params-desc-block">
      <el-descriptions-item v-for="[key, value] in visibleConfigEntries" :key="key"
        :label="getVarDisplayName(task.pluginId, String(key))" :span="2">
        <span class="break-all">{{ formatConfigValue(task.pluginId, String(key), value) }}</span>
      </el-descriptions-item>
    </el-descriptions>

    <el-descriptions v-if="task.status === 'failed'" :title="t('tasks.taskRunParamsSectionError')" :column="1" border
      size="small" class="params-desc-block params-desc-block--error">
      <el-descriptions-item :label="t('tasks.taskRunParamsColErrorDetail')" :span="2">
        <div class="error-detail-cell">
          <div v-if="(task.progress ?? 0) > 0" class="error-progress">
            <el-progress :percentage="Math.round(Number(task.progress ?? 0))" status="exception" />
          </div>
          <div class="error-message-row">
            <el-icon class="error-icon">
              <WarningFilled />
            </el-icon>
            <span class="error-text">{{ task.error || t("tasks.drawerExecFailed") }}</span>
            <el-button text size="small" class="copy-error-btn" :title="t('tasks.drawerCopyErrorTooltip')"
              @click="handleCopyError(task)">
              <el-icon>
                <CopyDocument />
              </el-icon>
            </el-button>
          </div>
        </div>
      </el-descriptions-item>
    </el-descriptions>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n, resolveConfigText } from "@kabegame/i18n";
import { ElMessage } from "element-plus";
import { Clock, CopyDocument, Grid, WarningFilled } from "@element-plus/icons-vue";
import {
  LOCAL_IMPORT_PLUGIN_ID,
  buildVarMetaMapFromPluginConfig,
  localImportVarMetaMap,
  usePluginStore,
} from "../../stores/plugins";
import type { PluginVarMeta } from "../../stores/plugins";
import { matchesPluginVarWhen } from "../../utils/pluginVarWhen";
import { IS_WEB } from "@kabegame/core/env";

export type TaskRunParamsTask = {
  id: string;
  pluginId: string;
  runConfigId?: string;
  triggerSource?: string;
  status: string;
  progress?: number;
  deletedCount?: number;
  dedupCount?: number;
  successCount?: number;
  failedCount?: number;
  outputDir?: string | null;
  userConfig?: Record<string, any> | null;
  startTime?: number | null;
  endTime?: number | null;
  error?: string | null;
};

const props = defineProps<{
  task: TaskRunParamsTask;
}>();

const { t, locale } = useI18n();
const pluginStore = usePluginStore();

const kbAppPublicIcon = `${(import.meta.env.BASE_URL || "/").replace(/\/$/, "")}/icon.png`;

const pluginIconDisplayUrl = computed(() => {
  const id = props.task.pluginId;
  if (!id) return null;
  if (id === LOCAL_IMPORT_PLUGIN_ID) return kbAppPublicIcon;
  return pluginStore.pluginIconDataUrl(id) ?? null;
});

const varMetaByPluginId = computed(() => {
  void locale.value;
  const out: Record<string, Record<string, PluginVarMeta>> = {
    [LOCAL_IMPORT_PLUGIN_ID]: localImportVarMetaMap((k) => t(k)),
  };
  for (const p of pluginStore.plugins) {
    out[p.id] = buildVarMetaMapFromPluginConfig(p.config);
  }
  return out;
});

const visibleConfigEntries = computed((): [string, any][] =>
  getVisibleUserConfigEntries(props.task),
);

const hasStartTime = computed(() => {
  const st = props.task.startTime;
  return st != null && Number(st) > 0;
});

const showTimeSection = computed(
  () => hasStartTime.value || (props.task.endTime != null && Number(props.task.endTime) > 0),
);

const showStatsSection = computed(
  () => (props.task.deletedCount ?? 0) > 0 || (props.task.dedupCount ?? 0) > 0,
);

const getPluginName = (pluginId: string) => pluginStore.pluginLabel(pluginId);

const toLocaleTag = (loc: string) => {
  if (loc.startsWith("zh")) return loc === "zhtw" ? "zh-TW" : "zh-CN";
  return loc === "en" ? "en-US" : loc;
};

const formatDate = (timestamp: number) => {
  const ms = timestamp > 1e12 ? timestamp : timestamp * 1000;
  const loc = locale.value ?? "zh";
  return new Date(ms).toLocaleString(toLocaleTag(loc));
};

const formatDuration = (startTime: number, endTime?: number) => {
  const startMs = startTime > 1e12 ? startTime : startTime * 1000;
  const endMs = endTime ? (endTime > 1e12 ? endTime : endTime * 1000) : Date.now();
  const totalSec = Math.max(0, Math.floor((endMs - startMs) / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return t("tasks.drawerDurationHours", { h, m, s });
  if (m > 0) return t("tasks.drawerDurationMinutes", { m, s });
  return t("tasks.drawerDurationSeconds", { s });
};

const getVarDisplayName = (pluginId: string, key: string) => {
  const meta = varMetaByPluginId.value[pluginId]?.[key];
  if (!meta?.name) return key;
  const n = meta.name;
  if (typeof n === "string") return n;
  return resolveConfigText(n, locale.value) || key;
};

function getVisibleUserConfigEntries(task: TaskRunParamsTask): [string, any][] {
  const cfg = task.userConfig;
  if (!cfg || typeof cfg !== "object") return [];
  const metaForPlugin = varMetaByPluginId.value[task.pluginId];
  return Object.entries(cfg).filter(([key]) => {
    const meta = metaForPlugin?.[key];
    if (!meta) return true;
    return matchesPluginVarWhen(meta.when, cfg);
  });
}

const formatConfigValue = (pluginId: string, key: string, value: any, raw = false): string => {
  const meta = varMetaByPluginId.value[pluginId]?.[key];
  const map = meta?.optionNameByVariable || {};
  if (value === null || value === undefined) return raw ? "null" : t("tasks.drawerUnset");
  if (typeof value === "boolean") return raw ? String(value) : value ? t("tasks.drawerYes") : t("tasks.drawerNo");
  if (Array.isArray(value)) {
    if (pluginId === LOCAL_IMPORT_PLUGIN_ID && key === "paths" && value.length > 3 && !raw) {
      return t("tasks.drawerPathsCount", { n: value.length });
    }
    return value
      .map((v) =>
        raw ? String(v) : typeof v === "string" ? resolveConfigText(map[v], locale.value) || v : String(v),
      )
      .join(", ");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, any>);
    if (entries.length > 0 && entries.every(([, v]) => typeof v === "boolean")) {
      const selected = entries.filter(([, v]) => v === true).map(([k]) => k);
      const out = raw ? selected : selected.map((v) => resolveConfigText(map[v], locale.value) || v);
      return out.length > 0 ? out.join(", ") : raw ? "" : t("tasks.drawerUnselected");
    }
    return JSON.stringify(value, null, 2);
  }
  const s = String(value);
  return raw ? s : resolveConfigText(map[s], locale.value) || s;
};

async function handleCopyError(task: TaskRunParamsTask) {
  let text = "=== Task Error ===\n";
  text += `Error: ${task.error || "Execution failed"}\n\n`;
  text += "=== Run Params ===\n";
  text += `Source: ${getPluginName(task.pluginId)}\n`;
  if (task.outputDir) text += `Output dir: ${task.outputDir}\n`;
  const visibleCfg = getVisibleUserConfigEntries(task);
  if (visibleCfg.length > 0) {
    text += "Config:\n";
    for (const [key, value] of visibleCfg) {
      text += `  ${key}: ${formatConfigValue(task.pluginId, String(key), value, true)}\n`;
    }
  }
  if (task.startTime) text += `Start time: ${formatDate(task.startTime)}\n`;
  if (task.endTime) text += `End time: ${formatDate(task.endTime)}\n`;
  text += `Progress: ${Math.round(Number(task.progress || 0))}%\n`;
  try {
    if (!IS_WEB) {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(text);
    } else {
      await navigator.clipboard.writeText(text);
    }
    ElMessage.success(t("common.copySuccess"));
  } catch (error) {
    console.error("复制失败:", error);
    ElMessage.error(t("common.copyFailed"));
  }
}
</script>

<style scoped lang="scss">
.task-run-params {
  max-height: min(72vh, 600px);
  overflow-y: auto;
  padding: 2px 0 4px;
}

.params-desc-block {
  margin-bottom: 14px;

  &:last-child {
    margin-bottom: 0;
  }
}

.plugin-source-cell {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.plugin-icon-box {
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  border-radius: 10px;
  overflow: hidden;
  background: var(--el-fill-color-light, var(--anime-bg-secondary, #f5f7fa));
  border: 1px solid var(--el-border-color-lighter, var(--anime-border));
  display: flex;
  align-items: center;
  justify-content: center;
}

.plugin-icon-img {
  width: 100%;
  height: 100%;
}

.plugin-icon-fallback {
  font-size: 22px;
  color: var(--el-text-color-secondary, var(--anime-text-muted));
}

.plugin-name-text {
  font-weight: 600;
  font-size: 14px;
  color: var(--anime-text-primary, var(--el-text-color-primary));
  word-break: break-word;
  min-width: 0;
}

.cell-with-icon {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.cell-icon {
  flex-shrink: 0;
  color: var(--el-text-color-secondary);
}

.text-muted {
  color: var(--el-text-color-placeholder);
}

.break-all {
  word-break: break-word;
  white-space: pre-wrap;
}

.params-desc-block--error {
  :deep(.el-descriptions__header) {
    margin-bottom: 10px;
  }

  :deep(.el-descriptions__title) {
    color: var(--el-color-danger);
    font-weight: 600;
  }
}

.error-detail-cell {
  min-width: 0;
}

.error-progress {
  margin-bottom: 10px;
}

.error-message-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  color: var(--anime-text-primary, var(--el-text-color-primary));
}

.error-icon {
  color: var(--el-color-danger);
  font-size: 18px;
  flex-shrink: 0;
  margin-top: 2px;
}

.error-text {
  flex: 1;
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
  white-space: pre-wrap;
}

.copy-error-btn {
  flex-shrink: 0;
  color: var(--el-text-color-secondary);

  &:hover {
    color: var(--anime-primary, var(--el-color-primary));
  }
}

:deep(.params-desc-block .el-descriptions__label) {
  width: 112px;
  font-weight: 500;
  color: var(--anime-text-secondary, var(--el-text-color-secondary));
}

:deep(.params-desc-block .el-descriptions__content) {
  color: var(--anime-text-primary, var(--el-text-color-primary));
}
</style>
