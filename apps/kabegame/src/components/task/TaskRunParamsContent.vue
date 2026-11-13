<template>
  <div class="flex flex-col gap-4 pb-1">
    <section>
      <h4 :class="SECTION_TITLE">{{ t("tasks.taskRunParamsSectionPlugin") }}</h4>
      <!-- 来源只有一行，不套键值列表：标签与图标基线对不齐 -->
      <div :class="SECTION_BOX" class="flex min-w-0 items-center gap-3">
        <div
          class="grid size-11 shrink-0 place-items-center overflow-hidden rounded-kb-md border border-solid border-kb-line bg-kb-fill-light text-kb-fg-subtle [&_svg]:size-5"
          aria-hidden="true"
        >
          <img v-if="pluginIconDisplayUrl" :src="pluginIconDisplayUrl" alt="" class="size-full object-contain" />
          <LayoutGrid v-else />
        </div>
        <span class="min-w-0 break-words text-[14px] font-600 text-kb-fg">{{ getPluginName(task.pluginId) }}</span>
      </div>
    </section>

    <section v-if="showTimeSection">
      <h4 :class="SECTION_TITLE">{{ t("tasks.taskRunParamsSectionTime") }}</h4>
      <div :class="SECTION_BOX">
        <DescriptionList>
          <DescriptionItem v-if="hasStartTime" :label="t('tasks.taskRunParamsColStartTime')">
            <span :class="WITH_ICON">
              <Clock />
              {{ formatDate(task.startTime!) }}
            </span>
          </DescriptionItem>
          <DescriptionItem :label="t('tasks.taskRunParamsColEndTime')">
            <span v-if="task.endTime" :class="WITH_ICON">
              <Clock />
              {{ formatDate(task.endTime) }}
            </span>
            <span v-else-if="hasStartTime">{{ t("tasks.drawerParamInProgress") }}</span>
            <span v-else class="text-kb-fg-subtle">—</span>
          </DescriptionItem>
          <DescriptionItem v-if="hasStartTime" :label="t('tasks.taskRunParamsColDuration')">
            {{ formatDuration(task.startTime!, task.endTime != null ? task.endTime : undefined) }}
          </DescriptionItem>
        </DescriptionList>
      </div>
    </section>

    <section v-if="showStatsSection">
      <h4 :class="SECTION_TITLE">{{ t("tasks.taskRunParamsSectionStats") }}</h4>
      <div :class="SECTION_BOX">
        <DescriptionList :columns="2" label-width="88px">
          <DescriptionItem v-if="(task.deletedCount ?? 0) > 0" :label="t('tasks.taskRunParamsColDeleted')">
            {{ t("tasks.drawerDeletedCount", { n: task.deletedCount ?? 0 }) }}
          </DescriptionItem>
          <DescriptionItem v-if="task.isDryRun" :label="t('tasks.taskRunParamsColDryRunSkipped')">
            {{ t("tasks.drawerDryRunSkippedCount", { n: task.dedupCount ?? 0 }) }}
          </DescriptionItem>
          <DescriptionItem v-else-if="(task.dedupCount ?? 0) > 0" :label="t('tasks.taskRunParamsColDedup')">
            {{ t("tasks.drawerDedupCount", { n: task.dedupCount ?? 0 }) }}
          </DescriptionItem>
        </DescriptionList>
      </div>
    </section>

    <section v-if="task.outputDir || task.maxConcurrentDownloads !== undefined || task.isDryRun !== undefined">
      <h4 :class="SECTION_TITLE">{{ t("tasks.taskRunParamsSectionOutput") }}</h4>
      <div :class="SECTION_BOX">
        <DescriptionList>
          <DescriptionItem v-if="task.outputDir" :label="t('tasks.taskRunParamsColOutputDir')">
            <span class="kb-selectable whitespace-pre-wrap break-words">{{ task.outputDir }}</span>
          </DescriptionItem>
          <DescriptionItem :label="t('tasks.taskRunParamsColMaxConcurrentDownloads')">
            {{
              task.maxConcurrentDownloads == null ? t("tasks.taskRunParamsFollowGlobal") : task.maxConcurrentDownloads
            }}
          </DescriptionItem>
          <DescriptionItem :label="t('tasks.taskRunParamsColDryRun')">
            {{ task.isDryRun ? t("autoConfig.enabled") : t("autoConfig.disabled") }}
          </DescriptionItem>
          <DescriptionItem :label="t('tasks.taskRunParamsColRetry')">
            {{ retryCountN > 0 ? t("tasks.taskRunParamsRetryTimes", { n: retryCountN }) : t("autoConfig.disabled") }}
            <template v-if="retryAttemptN > 0">
              · {{ t("tasks.taskRunParamsRetryAttempt", { k: retryAttemptN, n: retryCountN }) }}
            </template>
          </DescriptionItem>
          <DescriptionItem v-if="retryAttemptN > 0 && task.retryRootId" :label="t('tasks.taskRunParamsColRetryRoot')">
            <button
              type="button"
              class="cursor-pointer break-all rounded-kb-sm border-0 bg-transparent p-0 text-left text-kb-accent outline-none [font:inherit] hover:underline focus-visible:ring-2 focus-visible:ring-kb-ring"
              @click="emit('open-task', task.retryRootId)"
            >
              {{ task.retryRootId }}
            </button>
          </DescriptionItem>
        </DescriptionList>
      </div>
    </section>

    <section v-if="visibleConfigEntries.length > 0">
      <h4 :class="SECTION_TITLE">{{ t("tasks.taskRunParamsSectionConfig") }}</h4>
      <div :class="SECTION_BOX">
        <DescriptionList>
          <DescriptionItem
            v-for="[key, value] in visibleConfigEntries"
            :key="key"
            :label="getVarDisplayName(task.pluginId, String(key))"
          >
            <span class="kb-selectable whitespace-pre-wrap break-words">
              {{ formatConfigValue(task.pluginId, String(key), value) }}
            </span>
          </DescriptionItem>
        </DescriptionList>
      </div>
    </section>

    <section v-if="task.status === 'failed'">
      <h4 :class="ERROR_TITLE">{{ t("tasks.taskRunParamsSectionError") }}</h4>
      <div
        class="box-border rounded-kb-md border border-solid border-[color-mix(in_srgb,var(--kb-danger)_24%,transparent)] bg-[color-mix(in_srgb,var(--kb-danger)_5%,transparent)] px-3 py-2.5"
      >
        <div v-if="(task.progress ?? 0) > 0" class="mb-2.5 flex items-center gap-2">
          <Progress :value="Math.round(Number(task.progress ?? 0))" tone="danger" :height="6" />
          <span class="shrink-0 text-[12px] tabular-nums text-kb-fg-muted">
            {{ Math.round(Number(task.progress ?? 0)) }}%
          </span>
        </div>
        <div class="flex items-start gap-2 text-kb-fg">
          <CircleAlert class="mt-0.5 size-4 shrink-0 text-kb-danger" />
          <span class="kb-selectable min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] leading-[1.5]">
            {{ task.error || t("tasks.drawerExecFailed") }}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            :title="t('tasks.drawerCopyErrorTooltip')"
            :aria-label="t('tasks.drawerCopyErrorTooltip')"
            @click="handleCopyError(task)"
          >
            <Copy />
          </Button>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n, resolveConfigText } from "@kabegame/i18n";
import { kameMessage } from "@/utils/kameMessage";
import { CircleAlert, Clock, Copy, LayoutGrid } from "@lucide/vue";
import Button from "@/components/ui/Button.vue";
import DescriptionItem from "@/components/ui/DescriptionItem.vue";
import DescriptionList from "@/components/ui/DescriptionList.vue";
import Progress from "@/components/ui/Progress.vue";
import { buildVarMetaMapFromPluginConfig, usePluginStore } from "../../stores/plugins";
import type { PluginVarMeta } from "../../stores/plugins";
import type { PluginVarDef } from "../../utils/pluginVarForm";
import { visibleVarDefs } from "../../utils/pluginVarWhen";
import { IS_WEB } from "@/env";

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
  maxConcurrentDownloads?: number | null;
  isDryRun: boolean;
  retryCount?: number;
  retryAttempt?: number;
  retryRootId?: string;
  userConfig?: Record<string, any> | null;
  startTime?: number | null;
  endTime?: number | null;
  error?: string | null;
};

const props = defineProps<{
  task: TaskRunParamsTask;
}>();

const emit = defineEmits<{
  /** 点「原始任务」：由承载它的弹窗关闭自己并跳转到该任务 */
  (e: "open-task", taskId: string): void;
}>();

const { t, locale } = useI18n();

const SECTION_TITLE = "m-0 mb-1.5 text-[12.5px] font-600 text-kb-fg-muted";
const ERROR_TITLE = "m-0 mb-1.5 text-[12.5px] font-600 text-kb-danger";
const SECTION_BOX = "box-border rounded-kb-md border border-solid border-kb-line px-3 py-2.5";
const WITH_ICON = "inline-flex items-center gap-1.5 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-kb-fg-subtle";

const retryCountN = computed(() => Number(props.task.retryCount ?? 0));
const retryAttemptN = computed(() => Number(props.task.retryAttempt ?? 0));
const pluginStore = usePluginStore();

const pluginIconDisplayUrl = computed(() => {
  const id = props.task.pluginId;
  if (!id) return null;
  return pluginStore.pluginIconSrc(id) ?? null;
});

const varMetaByPluginId = computed(() => {
  void locale.value;
  const out: Record<string, Record<string, PluginVarMeta>> = {};
  for (const p of pluginStore.plugins) {
    out[p.id] = buildVarMetaMapFromPluginConfig(p.config);
  }
  return out;
});

const visibleConfigEntries = computed((): [string, any][] => getVisibleUserConfigEntries(props.task));

const hasStartTime = computed(() => {
  const st = props.task.startTime;
  return st != null && Number(st) > 0;
});

const showTimeSection = computed(
  () => hasStartTime.value || (props.task.endTime != null && Number(props.task.endTime) > 0),
);

const showStatsSection = computed(
  () => !!props.task.isDryRun || (props.task.deletedCount ?? 0) > 0 || (props.task.dedupCount ?? 0) > 0,
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
  const defs = Object.entries(metaForPlugin ?? {}).map(
    ([key, meta]) => ({ key, type: meta.type ?? "", name: meta.name, when: meta.when }) as PluginVarDef,
  );
  const visibleKeys = new Set(visibleVarDefs(defs, cfg).map((def) => def.key));
  return Object.entries(cfg).filter(([key]) => !metaForPlugin?.[key] || visibleKeys.has(key));
}

const formatConfigValue = (pluginId: string, key: string, value: any, raw = false): string => {
  const meta = varMetaByPluginId.value[pluginId]?.[key];
  const map = meta?.optionNameByVariable || {};
  if (value === null || value === undefined) return raw ? "null" : t("tasks.drawerUnset");
  if (typeof value === "boolean") return raw ? String(value) : value ? t("tasks.drawerYes") : t("tasks.drawerNo");
  if (Array.isArray(value)) {
    if (value.length > 3 && !raw) {
      return t("tasks.drawerListCount", { n: value.length });
    }
    return value
      .map((v) => (raw ? String(v) : typeof v === "string" ? resolveConfigText(map[v], locale.value) || v : String(v)))
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
    kameMessage.success(t("common.copySuccess"));
  } catch (error) {
    console.error("复制失败:", error);
    kameMessage.error(t("common.copyFailed"));
  }
}
</script>
