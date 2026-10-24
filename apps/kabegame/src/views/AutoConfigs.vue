<template>
  <div class="flex h-full min-h-0 flex-col" :class="{ 'p-5': !uiStore.isCompact }">
    <PageHeader :title="t('autoConfig.tabTitle')" :show="headerShowFeatures" :fold="[]" sticky>
      <template #subtitle>
        <span>{{ subtitle }}</span>
        <button
          v-if="failedTotal > 0"
          type="button"
          class="ml-2 border-0 bg-transparent p-0 text-[var(--el-color-danger)] hover:underline"
          @click="showFailed"
        >
          {{ t("autoConfig.failedCount", { n: failedTotal }) }}
        </button>
      </template>
      <template #extra>
        <el-button type="primary" @click="autoConfigDialog.openCreate()">{{ t("autoConfig.create") }}</el-button>
      </template>
    </PageHeader>

    <div class="flex min-h-0 flex-1 flex-col" :class="{ 'px-5 pb-5': uiStore.isCompact }">
      <KbTab v-model="tab" :items="tabItems" class="mb-3 flex-none" />
      <div class="mb-4 flex flex-none flex-wrap items-center gap-2">
        <KbFilterDropdown
          :model-value="activeQuery.sort"
          :options="sortOptions"
          :chip-label="t('gallery.sort')"
          :title="`${t('gallery.sort')} · ${sortOptions.find((item) => item.value === activeQuery.sort)?.label ?? ''}`"
          chip-display="icon"
          :clearable="false"
          @update:model-value="setSort"
        >
          <template #icon><Sort /></template>
        </KbFilterDropdown>
        <KbFilterDropdown
          :model-value="activeQuery.dir"
          :chip-label="t('gallery.sortOrder')"
          :title="`${t('gallery.sortOrder')} · ${activeQuery.dir === 'desc' ? t('gallery.sortDescending') : t('gallery.sortAscending')}`"
          chip-action="toggle"
          chip-display="icon"
          :clearable="false"
          @toggle="toggleDirection"
        >
          <template #icon>
            <SortDesc v-if="activeQuery.dir === 'desc'" />
            <SortAsc v-else />
          </template>
        </KbFilterDropdown>
        <span class="h-6 w-px bg-[var(--anime-border)]" />
        <KbFilterDropdown
          :model-value="activeQuery.search || null"
          :chip-label="t('gallery.advancedChipSearch')"
          :selected-label="activeQuery.search"
          :chip-display="activeQuery.search ? 'value' : 'icon'"
          @update:model-value="(value) => !value && setSearch('')"
        >
          <template #icon><Search /></template>
          <template #panel>
            <div class="w-64 p-2">
              <el-input
                v-model="searchDraft"
                clearable
                :placeholder="t('autoConfig.searchPlaceholder')"
                @input="scheduleSearch"
              />
            </div>
          </template>
        </KbFilterDropdown>

        <template v-if="tab === 'mine'">
          <FilterChip
            v-model="mine.state"
            :label="t('autoConfig.filterState')"
            :options="stateOptions"
            @open="loadFacet('state')"
          >
            <Timer />
          </FilterChip>
          <FilterChip
            v-model="mine.last"
            :label="t('autoConfig.lastResult')"
            :options="lastOptions"
            @open="loadFacet('last')"
          >
            <CircleCheck />
          </FilterChip>
          <FilterChip
            v-model="mine.plugin"
            :label="t('autoConfig.filterPlugin')"
            :options="minePluginOptions"
            @open="loadFacet('plugin')"
          >
            <Grid />
          </FilterChip>
          <FilterChip
            v-model="mine.mode"
            :label="t('autoConfig.mode')"
            :options="modeOptions"
            @open="loadFacet('mode')"
          >
            <Clock />
          </FilterChip>
        </template>
        <template v-else>
          <FilterChip
            v-model="recommended.plugin"
            :label="t('autoConfig.filterPlugin')"
            :options="recommendedPluginOptions"
          >
            <Grid />
          </FilterChip>
          <FilterChip v-model="recommended.mode" :label="t('autoConfig.mode')" :options="recommendedModeOptions">
            <Clock />
          </FilterChip>
          <FilterChip v-model="recommended.imported" :label="t('autoConfig.importState')" :options="importedOptions">
            <CircleCheck />
          </FilterChip>
        </template>
      </div>

      <div v-if="tab === 'mine'" class="min-h-0 flex-1 overflow-auto">
        <div v-if="configs.length" class="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
          <RunConfigGridCard
            v-for="config in configs"
            :key="config.id"
            :config="config"
            :schedule-toggling-id="scheduleTogglingId"
            @card-click="autoConfigDialog.openExisting(config.id, 'view')"
            @schedule-enabled="(enabled) => toggleSchedule(config, enabled)"
            @run="runNow(config)"
          />
        </div>
        <div v-else-if="loading" v-loading="showLoading" class="min-h-64" />
        <el-empty v-else :description="t('autoConfig.noMatchingConfigs')">
          <el-button type="primary" @click="autoConfigDialog.openCreate()">{{ t("autoConfig.create") }}</el-button>
        </el-empty>
        <LoadMoreButton v-if="configs.length" :has-more="hasMore" :loading="loading" @load-more="loadMore" />
      </div>

      <div v-else class="min-h-0 flex-1 overflow-auto">
        <div v-if="recommendedDisplayEntries.length" class="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
          <template v-for="entry in recommendedDisplayEntries" :key="entry.key">
            <el-skeleton
              v-if="!entry.preset"
              animated
              :rows="4"
              class="rounded-lg border border-solid border-[var(--anime-border)] p-4"
            />
            <RecommendedPresetGridCard
              v-else
              :preset="entry.preset"
              :title="presetTitle(entry.preset)"
              :description="presetDescription(entry.preset)"
              :imported="!!entry.preset.isImported"
              @card-click="openPresetPreview(entry.preset)"
              @import="importPreset(entry.preset)"
            />
          </template>
        </div>
        <el-empty v-else :description="t('autoConfig.noRecommendedConfigs')" />
      </div>
    </div>

    <el-dialog
      :model-value="presetPreview.isOpen.value"
      :z-index="presetPreview.zIndex.value"
      :title="t('autoConfig.recommendedPreviewTitle')"
      width="min(600px, 92vw)"
      append-to-body
      destroy-on-close
      @update:model-value="presetPreview.close"
    >
      <AutoConfigDetailContent
        v-if="presetPreviewConfig"
        :config="presetPreviewConfig"
        :show-schedule-last-run="false"
      />
      <template #footer>
        <el-button @click="presetPreview.close()">{{ t("common.cancel") }}</el-button>
        <el-button v-if="previewTarget" type="primary" @click="importPreset(previewTarget)">
          {{ t("autoConfig.importRecommended") }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, onMounted, reactive, ref, watch, type PropType } from "vue";
import {
  ElMessageBox,
  KbFilterDropdown,
  KbTab,
  type KbFilterDropdownOption,
  type KbTabItem,
} from "@kabegame/element-plus";
import { CircleCheck, Clock, Grid, Search, Sort, SortAsc, SortDesc, Timer } from "@kabegame/element-plus-icons";
import { resolveConfigText, useI18n } from "@kabegame/i18n";
import { kameMessage as ElMessage } from "@/utils/kameMessage";
import PageHeader from "@/components/common/PageHeader.vue";
import LoadMoreButton from "@/components/LoadMoreButton.vue";
import AutoConfigDetailContent from "@/components/scheduler/AutoConfigDetailContent.vue";
import RecommendedPresetGridCard from "@/components/scheduler/RecommendedPresetGridCard.vue";
import RunConfigGridCard from "@/components/scheduler/RunConfigGridCard.vue";
import { useModal } from "@/composables/useModal";
import { usePagedRunConfigs } from "@/composables/usePagedRunConfigs";
import { checkRecommendedPresetCompatibility } from "@/composables/useConfigCompatibility";
import { useCrawlerStore, type PluginRecommendedPreset, type RunConfig } from "@/stores/crawler";
import { usePluginStore } from "@/stores/plugins";
import { useAutoConfigDialogStore } from "@/stores/autoConfigDialog";
import { HeaderFeatureId } from "@/stores/header";
import { useUiStore } from "@/stores/ui";
import {
  fetchRunConfigFacet,
  runConfigFilterPath,
  runConfigViewPath,
  isRunConfigTaskSignal,
  type RunConfigFacet,
  type RunConfigQuery,
} from "@/services/runConfigs";
import { on, pathqlRequest$, usePathqlLookAll } from "@/services/kbEvents";
import { recommendedConfigPaths } from "@/services/pluginFiles";
import {
  filterRecommendedPresets,
  presetKey,
  recommendedFacetCounts,
  useRecommendedPresets,
  type RecommendedPresetQuery,
} from "@/services/recommendedPresets";

const { t, locale } = useI18n();
const uiStore = useUiStore();
const crawlerStore = useCrawlerStore();
const pluginStore = usePluginStore();
const autoConfigDialog = useAutoConfigDialogStore();
const headerShowFeatures = [HeaderFeatureId.TaskDrawer, HeaderFeatureId.Collect];
const tab = ref<"mine" | "recommended">("mine");
const searchDraft = ref("");
const scheduleTogglingId = ref<string | null>(null);
const failedTotal = ref(0);
const facets = reactive<Record<RunConfigFacet, Record<string, number>>>({ state: {}, last: {}, plugin: {}, mode: {} });
const mine = reactive<RunConfigQuery>({
  search: "",
  state: null,
  last: null,
  plugin: null,
  mode: null,
  sort: "next",
  dir: "asc",
});
const recommended = reactive<RecommendedPresetQuery>({
  search: "",
  plugin: null,
  mode: null,
  imported: null,
  sort: "plugin",
  dir: "asc",
});
const activeQuery = computed(() => (tab.value === "mine" ? mine : recommended));
let searchTimer: ReturnType<typeof setTimeout> | null = null;

const FilterChip = defineComponent({
  props: {
    modelValue: { type: String as PropType<string | null>, default: null },
    label: { type: String, required: true },
    options: { type: Array, required: true },
  },
  emits: ["update:modelValue", "open"],
  setup(props, { emit, slots }) {
    return () =>
      h(
        KbFilterDropdown,
        {
          modelValue: props.modelValue,
          options: props.options as KbFilterDropdownOption[],
          chipLabel: props.label,
          selectedLabel: (props.options as KbFilterDropdownOption[]).find((item) => item.value === props.modelValue)
            ?.label,
          chipDisplay: props.modelValue ? "value" : "icon",
          anyLabel: t("gallery.filterAll"),
          title: `${props.label} · ${
            (props.options as KbFilterDropdownOption[]).find((item) => item.value === props.modelValue)?.label ??
            t("gallery.filterAll")
          }`,
          onOpen: () => emit("open"),
          "onUpdate:modelValue": (value: string | null) => emit("update:modelValue", value),
        },
        { icon: slots.default },
      );
  },
});

const list = usePagedRunConfigs({
  basePath: () => runConfigViewPath(mine),
  countPath: () => runConfigFilterPath(mine),
  onError: () => ElMessage.error(t("common.refreshFailed")),
});
const { items: configs, total, loading, showLoading, hasMore, start, loadMore } = list;
watch(
  () => runConfigViewPath(mine),
  () => void start(),
);
watch(tab, (value) => {
  searchDraft.value = value === "mine" ? mine.search : recommended.search;
});
const emptyQuery: RunConfigQuery = {
  search: "",
  state: null,
  last: null,
  plugin: null,
  mode: null,
  sort: "next",
  dir: "asc",
};
const failedLooker = usePathqlLookAll({
  queries: () =>
    [{ kind: "list", path: `run_configs://${runConfigFilterPath(emptyQuery, "last")}last`, withCount: false }] as const,
  refreshOn: [on("auto-config-change"), on("tasks-change", isRunConfigTaskSignal)],
  onResult: ([entries]) => {
    failedTotal.value = Number(
      (entries.find((entry) => entry.name === "failed")?.meta as { count?: number } | null)?.count ?? 0,
    );
  },
});
onMounted(() => {
  start();
  void pluginStore.loadPlugins();
  const key = failedLooker.key();
  if (key) pathqlRequest$.next(["all", key]);
});

// 推荐列表只在推荐 tab 读取；其它 tab 的计数取插件声明的推荐文件数，随插件 store 更新，不发请求
const declaredRecommendedCount = computed(() =>
  pluginStore.visiblePlugins.reduce((sum, plugin) => sum + recommendedConfigPaths(plugin).length, 0),
);
const tabItems = computed<KbTabItem<"mine" | "recommended">[]>(() => [
  { name: "mine", label: t("autoConfig.tabMine") },
  {
    name: "recommended",
    label: t("autoConfig.tabRecommendedWithCount", {
      n: tab.value === "recommended" ? recommendedEntries.value.length : declaredRecommendedCount.value,
    }),
  },
]);
const subtitle = computed(() =>
  tab.value === "mine"
    ? t("autoConfig.listCount", { total: total.value })
    : t("autoConfig.recommendedCount", { total: filteredPresets.value.length }),
);
function option(value: string, label: string, count?: number): KbFilterDropdownOption {
  return { value, label, count } as KbFilterDropdownOption;
}
const sortOptions = computed(() =>
  (tab.value === "mine"
    ? [
        ["next", "sortNext"],
        ["last", "sortLast"],
        ["result", "sortResult"],
        ["name", "sortName"],
        ["plugin", "sortPlugin"],
        ["created", "sortCreated"],
      ]
    : [
        ["plugin", "sortPlugin"],
        ["name", "sortName"],
        ["schedule", "sortSchedule"],
      ]
  ).map(([value, key]) => option(value, t(`autoConfig.${key}`))),
);
const stateOptions = computed(() => [
  option("enabled", t("autoConfig.enabled"), facets.state.enabled),
  option("paused", t("autoConfig.paused"), facets.state.paused),
]);
const lastValues = ["ok", "partial", "failed", "running", "canceled", "never"] as const;
const lastOptions = computed(() =>
  lastValues.map((value) => option(value, t(`autoConfig.lastResult_${value}`), facets.last[value])),
);
const modes = ["interval", "hourly", "daily", "weekly", "none"] as const;
const modeOptions = computed(() =>
  modes.map((value) => option(value, t(`autoConfig.mode_${value}`), facets.mode[value])),
);
const minePluginOptions = computed(() =>
  Object.keys(facets.plugin)
    .sort((a, b) => pluginStore.pluginLabel(a).localeCompare(pluginStore.pluginLabel(b)))
    .map((id) => option(id, pluginStore.pluginLabel(id), facets.plugin[id])),
);
// GROUP BY 只返回有行的取值；固定取值的维度补 0，让下拉里显示灰掉的 (0)，与画廊一致
const facetValues: Partial<Record<RunConfigFacet, readonly string[]>> = {
  state: ["enabled", "paused"],
  last: lastValues,
  mode: modes,
};
async function loadFacet(dimension: RunConfigFacet) {
  const counts = await fetchRunConfigFacet(dimension, mine);
  const zeros = Object.fromEntries((facetValues[dimension] ?? []).map((value) => [value, 0]));
  facets[dimension] = { ...zeros, ...counts };
}
function setSort(value: string | null) {
  if (value) activeQuery.value.sort = value as never;
}
function toggleDirection() {
  activeQuery.value.dir = activeQuery.value.dir === "asc" ? "desc" : "asc";
}
function setSearch(value: string) {
  activeQuery.value.search = value;
  searchDraft.value = value;
}
function scheduleSearch() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => setSearch(searchDraft.value), 300);
}
function showFailed() {
  tab.value = "mine";
  mine.last = "failed";
}

const { entries: recommendedEntries, presets: recommendedPresets } = useRecommendedPresets(
  computed(() => pluginStore.visiblePlugins),
  computed(() => tab.value === "recommended"),
);
const presetTitle = (preset: PluginRecommendedPreset) =>
  resolveConfigText(preset.name as never, locale.value).trim() || preset.filename;
const presetDescription = (preset: PluginRecommendedPreset) =>
  preset.description ? resolveConfigText(preset.description as never, locale.value).trim() : "";
const filteredPresets = computed(() =>
  filterRecommendedPresets(recommendedPresets.value, recommended, presetTitle, presetDescription),
);
const recommendedDisplayEntries = computed(() => {
  const loaded = new Map(
    recommendedEntries.value.filter((entry) => entry.preset).map((entry) => [presetKey(entry.preset!), entry]),
  );
  // 默认顺序保持占位位置；显式排序与过滤对已经到达的配置生效。
  if (
    recommended.sort === "plugin" &&
    recommended.dir === "asc" &&
    !recommended.search &&
    !recommended.plugin &&
    !recommended.mode &&
    !recommended.imported
  )
    return recommendedEntries.value;
  return [
    ...recommendedEntries.value.filter(
      (entry) => !entry.preset && (!recommended.plugin || entry.pluginId === recommended.plugin),
    ),
    ...filteredPresets.value.flatMap((preset) => {
      const entry = loaded.get(presetKey(preset));
      return entry ? [entry] : [];
    }),
  ];
});
const recommendedPluginCounts = computed(() =>
  recommendedFacetCounts(recommendedPresets.value, recommended, "plugin", presetTitle, presetDescription),
);
const recommendedModeCounts = computed(() =>
  recommendedFacetCounts(recommendedPresets.value, recommended, "mode", presetTitle, presetDescription),
);
const importedCounts = computed(() =>
  recommendedFacetCounts(recommendedPresets.value, recommended, "imported", presetTitle, presetDescription),
);
const recommendedPluginOptions = computed(() =>
  Object.keys(recommendedPluginCounts.value).map((id) =>
    option(id, pluginStore.pluginLabel(id), recommendedPluginCounts.value[id]),
  ),
);
const recommendedModeOptions = computed(() =>
  modes.map((value) => option(value, t(`autoConfig.mode_${value}`), recommendedModeCounts.value[value])),
);
const importedOptions = computed(() => [
  option("yes", t("autoConfig.imported"), importedCounts.value.yes),
  option("no", t("autoConfig.notImported"), importedCounts.value.no),
]);

async function toggleSchedule(config: RunConfig, enabled: boolean) {
  scheduleTogglingId.value = config.id;
  try {
    await crawlerStore.updateRunConfig({ ...config, scheduleEnabled: enabled });
  } finally {
    scheduleTogglingId.value = null;
  }
}
async function runNow(config: RunConfig) {
  const created = await crawlerStore.addTask(
    config.pluginId,
    config.outputDir,
    config.userConfig,
    config.outputAlbumId,
    config.httpHeaders,
    config.id,
    "manual",
    config.maxConcurrentDownloads,
    config.isDryRun,
  );
  ElMessage[created ? "success" : "error"](t(created ? "autoConfig.runStarted" : "common.operationFailed"));
}

const presetPreview = useModal();
const previewTarget = ref<PluginRecommendedPreset | null>(null);
const presetPreviewConfig = computed<RunConfig | null>(() =>
  previewTarget.value
    ? {
        id: `preset:${presetKey(previewTarget.value)}`,
        name: presetTitle(previewTarget.value),
        description: presetDescription(previewTarget.value) || undefined,
        pluginId: previewTarget.value.pluginId,
        url: previewTarget.value.baseUrl,
        userConfig: previewTarget.value.userConfig,
        httpHeaders: previewTarget.value.httpHeaders,
        isDryRun: previewTarget.value.isDryRun,
        createdAt: 0,
        scheduleEnabled: !!previewTarget.value.scheduleSpec,
        scheduleSpec: previewTarget.value.scheduleSpec,
        lastResult: "never",
      }
    : null,
);
function openPresetPreview(preset: PluginRecommendedPreset) {
  previewTarget.value = preset;
  presetPreview.open();
}
async function importPreset(preset: PluginRecommendedPreset) {
  const compatibility = await checkRecommendedPresetCompatibility(preset.pluginId, preset.userConfig);
  if (!compatibility.versionCompatible) {
    ElMessage.error(compatibility.versionReason ?? t("common.pluginNotExist"));
    return;
  }
  if (!compatibility.contentCompatible) {
    try {
      await ElMessageBox.confirm(
        [...compatibility.contentErrors, ...compatibility.warnings].join("\n"),
        t("autoConfig.importCompatibilityWarningTitle"),
        {
          type: "warning",
          confirmButtonText: t("autoConfig.importContinue"),
          cancelButtonText: t("common.cancel"),
        },
      );
    } catch {
      return;
    }
  }
  await crawlerStore.importRecommendedPreset(preset);
  ElMessage.success(t("autoConfig.importRecommendedSuccess"));
}
</script>
