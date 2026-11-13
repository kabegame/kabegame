<template>
  <div class="flex flex-col gap-4 pb-1">
    <section>
      <h4 :class="SECTION_TITLE">{{ t("autoConfig.detailSectionMeta") }}</h4>
      <div :class="SECTION_BOX">
        <DescriptionList>
          <DescriptionItem :label="t('autoConfig.detailColConfigId')">
            <span class="break-all font-mono text-[12px]">{{ config.id }}</span>
          </DescriptionItem>
          <DescriptionItem :label="t('common.name')">
            <span class="break-all">{{ resolveText(config.name) }}</span>
          </DescriptionItem>
          <DescriptionItem v-if="config.description" :label="t('common.description')">
            <span class="break-all">{{ config.description }}</span>
          </DescriptionItem>
          <DescriptionItem v-if="showCreatedAtRow" :label="t('autoConfig.detailColCreatedAt')">
            {{ formatTs(config.createdAt) }}
          </DescriptionItem>
          <DescriptionItem v-if="config.url" :label="t('autoConfig.detailColUrl')">
            <span class="break-all">{{ config.url }}</span>
          </DescriptionItem>
        </DescriptionList>
      </div>
    </section>

    <section>
      <h4 :class="SECTION_TITLE">{{ t("tasks.taskRunParamsSectionPlugin") }}</h4>
      <!-- 来源只有一行，不套键值列表：标签与图标基线对不齐（同 TaskRunParamsContent） -->
      <div :class="SECTION_BOX" class="flex min-w-0 items-center gap-3">
        <div
          class="grid size-11 shrink-0 place-items-center overflow-hidden rounded-kb-md border border-solid border-kb-line bg-kb-fill-light text-kb-fg-subtle [&_svg]:size-5"
          aria-hidden="true"
        >
          <img v-if="pluginIconDisplayUrl" :src="pluginIconDisplayUrl" alt="" class="size-full object-contain" />
          <Puzzle v-else />
        </div>
        <span class="min-w-0 break-words text-[14px] font-600 text-kb-fg">{{ getPluginName(config.pluginId) }}</span>
      </div>
    </section>

    <section
      v-if="
        config.outputDir ||
        config.outputAlbumId ||
        config.maxConcurrentDownloads != null ||
        config.isDryRun !== undefined
      "
    >
      <h4 :class="SECTION_TITLE">{{ t("tasks.taskRunParamsSectionOutput") }}</h4>
      <div :class="SECTION_BOX">
        <DescriptionList>
          <DescriptionItem v-if="config.outputDir" :label="t('tasks.taskRunParamsColOutputDir')">
            <span class="break-all">{{ config.outputDir }}</span>
          </DescriptionItem>
          <DescriptionItem v-if="config.outputAlbumId" :label="t('albums.outputAlbum')">
            <span class="break-all">{{ outputAlbumName || config.outputAlbumId }}</span>
          </DescriptionItem>
          <DescriptionItem
            v-if="config.maxConcurrentDownloads != null"
            :label="t('tasks.taskRunParamsColMaxConcurrentDownloads')"
          >
            {{ config.maxConcurrentDownloads }}
          </DescriptionItem>
          <DescriptionItem :label="t('tasks.taskRunParamsColDryRun')">
            {{ config.isDryRun ? t("autoConfig.enabled") : t("autoConfig.disabled") }}
          </DescriptionItem>
          <DescriptionItem :label="t('tasks.taskRunParamsColRetry')">
            {{
              (config.retryCount ?? 0) > 0
                ? t("tasks.taskRunParamsRetryTimes", { n: config.retryCount })
                : t("autoConfig.disabled")
            }}
          </DescriptionItem>
        </DescriptionList>
      </div>
    </section>

    <section ref="scheduleSectionRef" class="scroll-mt-2">
      <h4 :class="SECTION_TITLE">{{ t("autoConfig.schedule") }}</h4>
      <div :class="[SECTION_BOX, { 'opacity-70': scheduleOff }]">
        <DescriptionList>
          <DescriptionItem :label="t('autoConfig.scheduleEnabled')">
            {{ config.scheduleEnabled ? t("autoConfig.enabled") : t("autoConfig.disabled") }}
          </DescriptionItem>
          <template v-if="config.scheduleEnabled || hasTimedSpec">
            <DescriptionItem :label="t('autoConfig.mode')">{{ scheduleModeTitle }}</DescriptionItem>
            <DescriptionItem v-if="config.scheduleSpec?.mode === 'hourly'" :label="t('autoConfig.modeHourly')">
              {{ t("autoConfig.hourlyAt", { minute: String(config.scheduleSpec.minute).padStart(2, "0") }) }}
            </DescriptionItem>
            <DescriptionItem v-if="config.scheduleSpec?.mode === 'interval'" :label="t('autoConfig.modeInterval')">
              {{ intervalSummary }}
            </DescriptionItem>
            <DescriptionItem v-if="config.scheduleSpec?.mode === 'daily'" :label="t('autoConfig.modeDaily')">
              {{ dailySummary }}
            </DescriptionItem>
            <DescriptionItem v-if="config.scheduleSpec?.mode === 'weekly'" :label="t('autoConfig.modeWeekly')">
              {{ weeklySummary }}
            </DescriptionItem>
            <DescriptionItem v-if="config.schedulePlannedAt != null" :label="t('autoConfig.detailColPlannedAt')">
              {{ formatTs(config.schedulePlannedAt) }}
            </DescriptionItem>
            <DescriptionItem v-if="showScheduleLastRun" :label="t('autoConfig.lastRunAt')">
              {{ formatTs(config.scheduleLastRunAt) }}
            </DescriptionItem>
          </template>
        </DescriptionList>
        <ScheduleProgressBar v-if="config.scheduleEnabled" :config="config" class="mt-2.5" />
      </div>
    </section>

    <section v-if="visibleConfigEntries.length > 0">
      <h4 :class="SECTION_TITLE">{{ t("tasks.taskRunParamsSectionConfig") }}</h4>
      <div :class="SECTION_BOX">
        <DescriptionList>
          <DescriptionItem
            v-for="[key, value] in visibleConfigEntries"
            :key="key"
            :label="getVarDisplayName(config.pluginId, String(key))"
          >
            <span class="break-all">{{ formatConfigValue(config.pluginId, String(key), value) }}</span>
          </DescriptionItem>
        </DescriptionList>
      </div>
    </section>

    <section v-if="headerEntries.length > 0">
      <h4 :class="SECTION_TITLE">{{ t("autoConfig.detailSectionHeaders") }}</h4>
      <div :class="SECTION_BOX">
        <DescriptionList>
          <DescriptionItem v-for="[k, v] in headerEntries" :key="k" :label="k">
            <span class="break-all">{{ v }}</span>
          </DescriptionItem>
        </DescriptionList>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n, resolveConfigText } from "@kabegame/i18n";
import { Puzzle } from "@lucide/vue";
import { DescriptionItem, DescriptionList } from "@/components/ui";
import ScheduleProgressBar from "./ScheduleProgressBar.vue";
import { buildVarMetaMapFromPluginConfig, usePluginStore } from "../../stores/plugins";
import type { PluginVarMeta } from "../../stores/plugins";
import type { RunConfig } from "../../stores/crawler";
import type { PluginVarDef } from "../../utils/pluginVarForm";
import { visibleVarDefs } from "../../utils/pluginVarWhen";

const props = withDefaults(
  defineProps<{
    config: RunConfig;
    /** 推荐预设预览等尚未导入运行前不展示「上次运行」 */
    showScheduleLastRun?: boolean;
    /** 输出画册展示名（由 app 侧解析后传入；缺省时退回画册 id） */
    outputAlbumName?: string;
  }>(),
  { showScheduleLastRun: true },
);

const { t, locale } = useI18n();
const pluginStore = usePluginStore();

const scheduleSectionRef = ref<HTMLElement | null>(null);

// 分节外观与任务运行参数（TaskRunParamsContent）一致
const SECTION_TITLE = "m-0 mb-1.5 text-[12.5px] font-600 text-kb-fg-muted";
const SECTION_BOX = "box-border rounded-kb-md border border-solid border-kb-line px-3 py-2.5";

const hasTimedSpec = computed(() => {
  const mode = props.config.scheduleSpec?.mode;
  return mode === "interval" || mode === "hourly" || mode === "daily" || mode === "weekly";
});
/** 定时关着但还留着规则：整块淡一点 */
const scheduleOff = computed(() => !props.config.scheduleEnabled && hasTimedSpec.value);

/** 插件推荐预设预览（虚拟 RunConfig，`preset:pluginId:filename`）无创建时间 */
const showCreatedAtRow = computed(() => !props.config.id.startsWith("preset:"));

function scrollScheduleIntoView() {
  scheduleSectionRef.value?.scrollIntoView({ block: "start" });
}

defineExpose({ scrollScheduleIntoView });

const pluginIconDisplayUrl = computed(() => {
  const id = props.config.pluginId;
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

function getVisibleUserConfigEntries(cfg: RunConfig): [string, any][] {
  const uc = cfg.userConfig;
  if (!uc || typeof uc !== "object") return [];
  const metaForPlugin = varMetaByPluginId.value[cfg.pluginId];
  const defs = Object.entries(metaForPlugin ?? {}).map(
    ([key, meta]) => ({ key, type: meta.type ?? "", name: meta.name, when: meta.when }) as PluginVarDef,
  );
  const visibleKeys = new Set(visibleVarDefs(defs, uc).map((def) => def.key));
  const entries = Object.entries(uc).filter(([key]) => !metaForPlugin?.[key] || visibleKeys.has(key));
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

const visibleConfigEntries = computed((): [string, any][] => getVisibleUserConfigEntries(props.config));

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
    case "hourly":
      return t("autoConfig.modeHourly");
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
  const weekdays = s.weekdays.map((wd) => t(`autoConfig.weekday${wd}`)).join(t("autoConfig.weekdaySeparator"));
  const hour = String(Number(s.hour ?? 0)).padStart(2, "0");
  const minute = String(Number(s.minute ?? 0)).padStart(2, "0");
  return t("autoConfig.weeklyAt", {
    weekday: weekdays,
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
