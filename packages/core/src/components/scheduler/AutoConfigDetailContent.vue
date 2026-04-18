<template>
  <div class="auto-config-detail">
    <el-descriptions :title="t('autoConfig.detailSectionMeta')" :column="1" border size="small"
      class="params-desc-block">
      <el-descriptions-item :label="t('autoConfig.detailColConfigId')" :span="2">
        <span class="break-all mono">{{ config.id }}</span>
      </el-descriptions-item>
      <el-descriptions-item :label="t('common.name')" :span="2">
        <span class="break-all">{{ resolveText(config.name) }}</span>
      </el-descriptions-item>
      <el-descriptions-item v-if="config.description" :label="t('common.description')" :span="2">
        <span class="break-all">{{ config.description }}</span>
      </el-descriptions-item>
      <el-descriptions-item v-if="showCreatedAtRow" :label="t('autoConfig.detailColCreatedAt')" :span="2">
        {{ formatTs(config.createdAt) }}
      </el-descriptions-item>
      <el-descriptions-item v-if="config.url" :label="t('autoConfig.detailColUrl')" :span="2">
        <span class="break-all">{{ config.url }}</span>
      </el-descriptions-item>
    </el-descriptions>

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
          <span class="plugin-name-text">{{ getPluginName(config.pluginId) }}</span>
        </div>
      </el-descriptions-item>
    </el-descriptions>

    <el-descriptions v-if="config.outputDir" :title="t('tasks.taskRunParamsSectionOutput')" :column="1" border
      size="small" class="params-desc-block">
      <el-descriptions-item :label="t('tasks.taskRunParamsColOutputDir')" :span="2">
        <span class="break-all">{{ config.outputDir }}</span>
      </el-descriptions-item>
    </el-descriptions>

    <div ref="scheduleSectionRef" :class="{
      'schedule-detail--schedule-off':
        !config.scheduleEnabled &&
        (config.scheduleSpec?.mode === 'interval' ||
          config.scheduleSpec?.mode === 'daily' ||
          config.scheduleSpec?.mode === 'weekly'),
    }">
      <el-descriptions :title="t('autoConfig.schedule')" :column="1" border size="small" class="params-desc-block">
        <el-descriptions-item :label="t('autoConfig.scheduleEnabled')" :span="2">
          {{ config.scheduleEnabled ? t('autoConfig.enabled') : t('autoConfig.disabled') }}
        </el-descriptions-item>
        <template v-if="
          config.scheduleEnabled ||
          config.scheduleSpec?.mode === 'interval' ||
          config.scheduleSpec?.mode === 'daily' ||
          config.scheduleSpec?.mode === 'weekly'
        ">
          <el-descriptions-item :label="t('autoConfig.mode')" :span="2">
            {{ scheduleModeTitle }}
          </el-descriptions-item>
          <el-descriptions-item v-if="config.scheduleSpec?.mode === 'interval'" :label="t('autoConfig.modeInterval')"
            :span="2">
            {{ intervalSummary }}
          </el-descriptions-item>
          <el-descriptions-item v-if="config.scheduleSpec?.mode === 'daily'" :label="t('autoConfig.modeDaily')"
            :span="2">
            {{ dailySummary }}
          </el-descriptions-item>
          <el-descriptions-item v-if="config.scheduleSpec?.mode === 'weekly'" :label="t('autoConfig.modeWeekly')"
            :span="2">
            {{ weeklySummary }}
          </el-descriptions-item>
          <el-descriptions-item v-if="config.schedulePlannedAt != null" :label="t('autoConfig.detailColPlannedAt')"
            :span="2">
            {{ formatTs(config.schedulePlannedAt) }}
          </el-descriptions-item>
          <el-descriptions-item v-if="showScheduleLastRun" :label="t('autoConfig.lastRunAt')" :span="2">
            {{ formatTs(config.scheduleLastRunAt) }}
          </el-descriptions-item>
        </template>
      </el-descriptions>
      <ScheduleProgressBar v-if="config.scheduleEnabled" :config="config" class="acd-detail-schedule-progress" />
    </div>

    <el-descriptions v-if="visibleConfigEntries.length > 0" :title="t('tasks.taskRunParamsSectionConfig')" :column="1"
      border size="small" class="params-desc-block">
      <el-descriptions-item v-for="[key, value] in visibleConfigEntries" :key="key"
        :label="getVarDisplayName(config.pluginId, String(key))" :span="2">
        <span class="break-all">{{ formatConfigValue(config.pluginId, String(key), value) }}</span>
      </el-descriptions-item>
    </el-descriptions>

    <el-descriptions v-if="headerEntries.length > 0" :title="t('autoConfig.detailSectionHeaders')" :column="1" border
      size="small" class="params-desc-block">
      <el-descriptions-item v-for="[k, v] in headerEntries" :key="k" :label="k" :span="2">
        <span class="break-all">{{ v }}</span>
      </el-descriptions-item>
    </el-descriptions>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n, resolveConfigText } from "@kabegame/i18n";
import { Grid } from "@element-plus/icons-vue";
import ScheduleProgressBar from "./ScheduleProgressBar.vue";
import {
  LOCAL_IMPORT_PLUGIN_ID,
  buildVarMetaMapFromPluginConfig,
  localImportVarMetaMap,
  usePluginStore,
} from "../../stores/plugins";
import type { PluginVarMeta } from "../../stores/plugins";
import type { RunConfig } from "../../stores/crawler";
import { matchesPluginVarWhen } from "../../utils/pluginVarWhen";

const props = withDefaults(
  defineProps<{
    config: RunConfig;
    /** 推荐预设预览等尚未导入运行前不展示「上次运行」 */
    showScheduleLastRun?: boolean;
  }>(),
  { showScheduleLastRun: true },
);

const { t, locale } = useI18n();
const pluginStore = usePluginStore();

const scheduleSectionRef = ref<HTMLElement | null>(null);

/** 插件推荐预设预览（虚拟 RunConfig，`preset:pluginId:filename`）无创建时间 */
const showCreatedAtRow = computed(() => !props.config.id.startsWith("preset:"));

function scrollScheduleIntoView() {
  scheduleSectionRef.value?.scrollIntoView({ block: "start", behavior: "smooth" });
}

defineExpose({ scrollScheduleIntoView });

const kbAppPublicIcon = `${(import.meta.env.BASE_URL || "/").replace(/\/$/, "")}/icon.png`;

const pluginIconDisplayUrl = computed(() => {
  const id = props.config.pluginId;
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

function getVisibleUserConfigEntries(cfg: RunConfig): [string, any][] {
  const uc = cfg.userConfig;
  if (!uc || typeof uc !== "object") return [];
  const metaForPlugin = varMetaByPluginId.value[cfg.pluginId];
  const entries = Object.entries(uc).filter(([key]) => {
    const meta = metaForPlugin?.[key];
    if (!meta) return true;
    return matchesPluginVarWhen(meta.when, uc);
  });
  if (!metaForPlugin) return entries;

  // 按插件 config.vars 定义顺序展示，未知字段追加到末尾
  const orderedKeys = Object.keys(metaForPlugin);
  const orderMap = new Map<string, number>(orderedKeys.map((key, idx) => [key, idx]));
  return entries.sort(([a], [b]) => {
    const ai = orderMap.get(a);
    const bi = orderMap.get(b);
    if (ai != null && bi != null) return ai - bi;
    if (ai != null) return -1;
    if (bi != null) return 1;
    return a.localeCompare(b);
  });
}

const visibleConfigEntries = computed((): [string, any][] =>
  getVisibleUserConfigEntries(props.config),
);

const headerEntries = computed((): [string, string][] => {
  const h = props.config.httpHeaders;
  if (!h || typeof h !== "object") return [];
  return Object.entries(h).filter(([, v]) => v != null && String(v).trim() !== "");
});

const resolveText = (value: unknown) => resolveConfigText(value as any, locale.value);

const getPluginName = (pluginId: string) => pluginStore.pluginLabel(pluginId);

const toLocaleTag = (loc: string) => {
  if (loc.startsWith("zh")) return loc === "zhtw" ? "zh-TW" : "zh-CN";
  return loc === "en" ? "en-US" : loc;
};

const formatTs = (ts?: number) => {
  if (ts == null || !Number.isFinite(Number(ts))) return t("autoConfig.never");
  const n = Number(ts);
  const ms = n > 9_999_999_999 ? n : n * 1000;
  return new Date(ms).toLocaleString(toLocaleTag(locale.value ?? "zh"));
};

const formatInterval = (secs?: number) => {
  const n = Number(secs ?? 0);
  if (!Number.isFinite(n) || n <= 0) return t("autoConfig.unset");
  if (n % 86400 === 0) return t("autoConfig.everyDays", { n: n / 86400 });
  if (n % 3600 === 0) return t("autoConfig.everyHours", { n: n / 3600 });
  if (n % 60 === 0) return t("autoConfig.everyMinutes", { n: n / 60 });
  return t("autoConfig.everySeconds", { n });
};

const scheduleModeTitle = computed(() => {
  switch (props.config.scheduleSpec?.mode) {
    case "interval":
      return t("autoConfig.modeInterval");
    case "daily":
      return t("autoConfig.modeDaily");
    case "weekly":
      return t("autoConfig.modeWeekly");
    default:
      return t("autoConfig.scheduleTypeUnset");
  }
});

const intervalSummary = computed(() => {
  const s = props.config.scheduleSpec;
  if (s?.mode !== "interval") return t("autoConfig.unset");
  return formatInterval(s.intervalSecs);
});

const dailySummary = computed(() => {
  const s = props.config.scheduleSpec;
  if (s?.mode !== "daily") return "—";
  const minute = Number(s.minute ?? 0);
  if (s.hour === -1) {
    return t("autoConfig.dailyHourly", { minute: String(minute).padStart(2, "0") });
  }
  const hour = Number(s.hour ?? 0);
  return t("autoConfig.dailyAt", {
    hour: String(hour).padStart(2, "0"),
    minute: String(minute).padStart(2, "0"),
  });
});

const weeklySummary = computed(() => {
  const s = props.config.scheduleSpec;
  if (s?.mode !== "weekly") return "—";
  const wd = Math.min(6, Math.max(0, Number(s.weekday ?? 0)));
  const hour = String(Number(s.hour ?? 0)).padStart(2, "0");
  const minute = String(Number(s.minute ?? 0)).padStart(2, "0");
  return t("autoConfig.weeklyAt", {
    weekday: t(`autoConfig.weekday${wd}`),
    hour,
    minute,
  });
});

const getVarDisplayName = (pluginId: string, key: string) => {
  const meta = varMetaByPluginId.value[pluginId]?.[key];
  if (!meta?.name) return key;
  const n = meta.name;
  if (typeof n === "string") return n;
  return resolveConfigText(n, locale.value) || key;
};

const formatConfigValue = (pluginId: string, key: string, value: any): string => {
  const meta = varMetaByPluginId.value[pluginId]?.[key];
  const map = meta?.optionNameByVariable || {};
  if (value === null || value === undefined) return t("tasks.drawerUnset");
  if (typeof value === "boolean") return value ? t("tasks.drawerYes") : t("tasks.drawerNo");
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? resolveConfigText(map[v], locale.value) || v : String(v)))
      .join(", ");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, any>);
    if (entries.length > 0 && entries.every(([, v]) => typeof v === "boolean")) {
      const selected = entries.filter(([, v]) => v === true).map(([k]) => k);
      const out = selected.map((v) => resolveConfigText(map[v], locale.value) || v);
      return out.length > 0 ? out.join(", ") : t("tasks.drawerUnselected");
    }
    return JSON.stringify(value, null, 2);
  }
  const s = String(value);
  return resolveConfigText(map[s], locale.value) || s;
};
</script>

<style scoped lang="scss">
.auto-config-detail {
  padding: 2px 0 4px;
}

.acd-detail-schedule-progress {
  margin-top: 10px;
}

.schedule-detail--schedule-off {
  opacity: 0.72;
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

.break-all {
  word-break: break-word;
  white-space: pre-wrap;
}

.mono {
  font-family: ui-monospace, monospace;
  font-size: 12px;
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
