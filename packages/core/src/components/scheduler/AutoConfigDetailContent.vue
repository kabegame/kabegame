<template>
  <div class="auto-config-detail">
    <el-descriptions
      :title="t('autoConfig.detailSectionMeta')"
      :column="1"
      border
      size="small"
      class="params-desc-block"
    >
      <el-descriptions-item :label="t('autoConfig.detailColConfigId')" :span="2">
        <span class="break-all mono">{{ config.id }}</span>
      </el-descriptions-item>
      <el-descriptions-item :label="t('common.name')" :span="2">
        <span class="break-all">{{ resolveText(config.name) }}</span>
      </el-descriptions-item>
      <el-descriptions-item
        v-if="config.description"
        :label="t('common.description')"
        :span="2"
      >
        <span class="break-all">{{ config.description }}</span>
      </el-descriptions-item>
      <el-descriptions-item :label="t('autoConfig.detailColCreatedAt')" :span="2">
        {{ formatTs(config.createdAt) }}
      </el-descriptions-item>
      <el-descriptions-item v-if="config.url" :label="t('autoConfig.detailColUrl')" :span="2">
        <span class="break-all">{{ config.url }}</span>
      </el-descriptions-item>
    </el-descriptions>

    <el-descriptions
      :title="t('tasks.taskRunParamsSectionPlugin')"
      :column="2"
      border
      size="small"
      class="params-desc-block"
    >
      <el-descriptions-item :label="t('tasks.taskRunParamsColSource')" :span="2">
        <div class="plugin-source-cell">
          <div class="plugin-icon-box" aria-hidden="true">
            <el-image v-if="pluginIconUrl" :src="pluginIconUrl" fit="contain" class="plugin-icon-img" />
            <el-icon v-else class="plugin-icon-fallback"><Grid /></el-icon>
          </div>
          <span class="plugin-name-text">{{ getPluginName(config.pluginId) }}</span>
        </div>
      </el-descriptions-item>
    </el-descriptions>

    <el-descriptions
      v-if="config.outputDir"
      :title="t('tasks.taskRunParamsSectionOutput')"
      :column="1"
      border
      size="small"
      class="params-desc-block"
    >
      <el-descriptions-item :label="t('tasks.taskRunParamsColOutputDir')" :span="2">
        <span class="break-all">{{ config.outputDir }}</span>
      </el-descriptions-item>
    </el-descriptions>

    <div ref="scheduleSectionRef">
      <el-descriptions
        :title="t('autoConfig.schedule')"
        :column="1"
        border
        size="small"
        class="params-desc-block"
      >
        <el-descriptions-item :label="t('autoConfig.scheduleEnabled')" :span="2">
          {{ config.scheduleEnabled ? t('autoConfig.enabled') : t('autoConfig.disabled') }}
        </el-descriptions-item>
        <template v-if="config.scheduleEnabled">
          <el-descriptions-item :label="t('autoConfig.mode')" :span="2">
            {{ scheduleModeTitle }}
          </el-descriptions-item>
          <el-descriptions-item
            v-if="config.scheduleMode === 'interval'"
            :label="t('autoConfig.modeInterval')"
            :span="2"
          >
            {{ intervalSummary }}
          </el-descriptions-item>
          <el-descriptions-item
            v-if="config.scheduleMode === 'daily'"
            :label="t('autoConfig.modeDaily')"
            :span="2"
          >
            {{ dailySummary }}
          </el-descriptions-item>
          <el-descriptions-item
            v-if="config.schedulePlannedAt != null"
            :label="t('autoConfig.detailColPlannedAt')"
            :span="2"
          >
            {{ formatTs(config.schedulePlannedAt) }}
          </el-descriptions-item>
          <el-descriptions-item
            v-if="config.scheduleDelaySecs != null && config.scheduleDelaySecs > 0"
            :label="t('autoConfig.detailColDelaySecs')"
            :span="2"
          >
            {{ config.scheduleDelaySecs }}s
          </el-descriptions-item>
          <el-descriptions-item :label="t('autoConfig.lastRunAt')" :span="2">
            {{ formatTs(config.scheduleLastRunAt) }}
          </el-descriptions-item>
        </template>
      </el-descriptions>
    </div>

    <el-descriptions
      v-if="visibleConfigEntries.length > 0"
      :title="t('tasks.taskRunParamsSectionConfig')"
      :column="1"
      border
      size="small"
      class="params-desc-block"
    >
      <el-descriptions-item
        v-for="[key, value] in visibleConfigEntries"
        :key="key"
        :label="getVarDisplayName(config.pluginId, String(key))"
        :span="2"
      >
        <span class="break-all">{{ formatConfigValue(config.pluginId, String(key), value) }}</span>
      </el-descriptions-item>
    </el-descriptions>

    <el-descriptions
      v-if="headerEntries.length > 0"
      :title="t('autoConfig.detailSectionHeaders')"
      :column="1"
      border
      size="small"
      class="params-desc-block"
    >
      <el-descriptions-item
        v-for="[k, v] in headerEntries"
        :key="k"
        :label="k"
        :span="2"
      >
        <span class="break-all">{{ v }}</span>
      </el-descriptions-item>
    </el-descriptions>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n, resolveConfigText } from "@kabegame/i18n";
import { Grid } from "@element-plus/icons-vue";
import { invoke } from "@tauri-apps/api/core";
import {
  LOCAL_IMPORT_PLUGIN_ID,
  buildVarMetaMapFromPluginConfig,
  localImportVarMetaMap,
  usePluginStore,
} from "../../stores/plugins";
import type { PluginVarMeta } from "../../stores/plugins";
import type { RunConfig } from "../../stores/crawler";
import { matchesPluginVarWhen } from "../../utils/pluginVarWhen";

const props = defineProps<{
  config: RunConfig;
}>();

const { t, locale } = useI18n();
const pluginStore = usePluginStore();

const scheduleSectionRef = ref<HTMLElement | null>(null);

function scrollScheduleIntoView() {
  scheduleSectionRef.value?.scrollIntoView({ block: "start", behavior: "smooth" });
}

defineExpose({ scrollScheduleIntoView });

function toPngDataUrl(iconData: number[]): string {
  const bytes = new Uint8Array(iconData);
  const binaryString = Array.from(bytes)
    .map((byte) => String.fromCharCode(byte))
    .join("");
  return `data:image/png;base64,${btoa(binaryString)}`;
}

const pluginIconUrl = ref<string | null>(null);

watch(
  () => props.config.pluginId,
  async (pluginId) => {
    pluginIconUrl.value = null;
    if (!pluginId) return;
    try {
      const { isTauri } = await import("@tauri-apps/api/core");
      if (!isTauri()) return;
      const iconData = await invoke<number[] | null>("get_plugin_icon", { pluginId });
      if (iconData && iconData.length > 0) {
        pluginIconUrl.value = toPngDataUrl(iconData);
      }
    } catch {
      /* ignore */
    }
  },
  { immediate: true },
);

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
  return Object.entries(uc).filter(([key]) => {
    const meta = metaForPlugin?.[key];
    if (!meta) return true;
    return matchesPluginVarWhen(meta.when, uc);
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
  switch (props.config.scheduleMode) {
    case "interval":
      return t("autoConfig.modeInterval");
    case "daily":
      return t("autoConfig.modeDaily");
    default:
      return t("autoConfig.scheduleTypeUnset");
  }
});

const intervalSummary = computed(() => formatInterval(props.config.scheduleIntervalSecs));

const dailySummary = computed(() => {
  if (props.config.scheduleMode !== "daily") return "—";
  const minute = Number(props.config.scheduleDailyMinute ?? 0);
  if (props.config.scheduleDailyHour === -1) {
    return t("autoConfig.dailyHourly", { minute: String(minute).padStart(2, "0") });
  }
  const hour = Number(props.config.scheduleDailyHour ?? 0);
  return t("autoConfig.dailyAt", {
    hour: String(hour).padStart(2, "0"),
    minute: String(minute).padStart(2, "0"),
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
  max-height: min(72vh, 620px);
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
