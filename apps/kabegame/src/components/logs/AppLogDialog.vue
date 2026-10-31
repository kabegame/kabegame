<template>
  <el-dialog
    :model-value="isOpen"
    :z-index="zIndex"
    :title="t('header.logs.title')"
    :width="uiStore.isCompact ? undefined : '960px'"
    :fullscreen="uiStore.isCompact"
    :append-to-body="true"
    class="app-log-dialog"
    @update:model-value="
      (v: boolean) => {
        if (!v) close();
      }
    "
  >
    <div class="flex flex-col gap-2 min-w-0">
      <div class="flex flex-wrap items-center gap-2">
        <el-checkbox-group v-model="levels" size="small">
          <el-checkbox-button v-for="level in LOG_LEVELS" :key="level" :value="level">
            {{ level }}
          </el-checkbox-button>
        </el-checkbox-group>
        <el-radio-group v-model="source" size="small">
          <el-radio-button value="all">{{ t("header.logs.sourceAll") }}</el-radio-button>
          <el-radio-button value="backend">{{ t("header.logs.sourceBackend") }}</el-radio-button>
          <el-radio-button value="frontend">{{ t("header.logs.sourceFrontend") }}</el-radio-button>
        </el-radio-group>
        <el-select
          v-model="targetPrefix"
          size="small"
          filterable
          allow-create
          clearable
          :placeholder="t('header.logs.targetPlaceholder')"
          class="w-56"
        >
          <el-option v-for="target in knownTargets" :key="target" :label="target" :value="target" />
        </el-select>
        <el-input
          v-model="keyword"
          size="small"
          clearable
          :prefix-icon="Search"
          :placeholder="t('header.logs.searchPlaceholder')"
          class="w-48"
        />
      </div>

      <div class="flex flex-wrap items-center gap-3 text-12px text-[var(--anime-text-secondary)]">
        <span>{{ t("header.logs.count", { shown: filtered.length, total: store.records.length }) }}</span>
        <span class="flex items-center gap-1">
          <el-switch v-model="follow" size="small" />
          {{ t("header.logs.follow") }}
        </span>
        <span class="flex-1" />
        <el-button size="small" text @click="copyFiltered">{{ t("header.logs.copy") }}</el-button>
        <el-button size="small" text @click="store.clear()">{{ t("header.logs.clear") }}</el-button>
        <el-button v-if="canOpenDir" size="small" text @click="openDir">{{ t("header.logs.openDir") }}</el-button>
      </div>

      <div v-if="store.error" class="text-12px text-[var(--el-color-danger)]">
        {{ t("header.logs.loadFailed", { detail: store.error }) }}
      </div>

      <div
        v-loading="store.loading && store.records.length === 0"
        class="kb-selectable font-mono text-12px border border-solid border-[var(--anime-border)] rounded-2 overflow-auto"
        :class="uiStore.isCompact ? 'h-[calc(100vh-320px)]' : 'h-[420px]'"
        v-bind="containerProps"
        @scroll="handleScroll"
      >
        <div v-if="filtered.length === 0" class="py-8 text-center text-[var(--anime-text-secondary)] font-sans">
          {{ t("header.logs.empty") }}
        </div>
        <div v-bind="wrapperProps">
          <div
            v-for="item in virtualList"
            :key="item.data.seq"
            class="flex items-center gap-2 px-2 whitespace-nowrap cursor-pointer hover:bg-[var(--anime-bg-hover,rgba(127,127,127,0.08))]"
            :class="[rowClass(item.data), { 'bg-[rgba(127,127,127,0.16)]': selected?.seq === item.data.seq }]"
            :style="{ height: `${ROW_HEIGHT}px` }"
            @click="selected = item.data"
          >
            <span class="shrink-0 text-[var(--anime-text-secondary)]">{{ formatTime(item.data.ts) }}</span>
            <span class="shrink-0 w-11 font-bold" :class="levelClass(item.data.level)">{{ item.data.level }}</span>
            <span class="shrink-0 max-w-56 overflow-hidden text-ellipsis text-[var(--anime-text-secondary)]">
              {{ item.data.target }}
            </span>
            <span class="min-w-0 overflow-hidden text-ellipsis">{{ item.data.message }}</span>
          </div>
        </div>
      </div>

      <div
        v-if="selected"
        class="kb-selectable font-mono text-12px border border-solid border-[var(--anime-border)] rounded-2 p-2 max-h-40 overflow-auto"
      >
        <div class="flex items-center gap-2 mb-1 text-[var(--anime-text-secondary)]">
          <span>{{ formatFullTime(selected.ts) }}</span>
          <span class="font-bold" :class="levelClass(selected.level)">{{ selected.level }}</span>
          <span>{{ selected.target }}</span>
          <span class="flex-1" />
          <el-button size="small" text @click="copyRecords([selected])">{{ t("header.logs.copyLine") }}</el-button>
          <el-button size="small" text @click="selected = null">{{ t("common.close") }}</el-button>
        </div>
        <div class="whitespace-pre-wrap break-all">{{ selected.message }}</div>
        <div v-if="selected.fields && Object.keys(selected.fields).length > 0" class="mt-1 text-[var(--anime-text-secondary)]">
          <div v-for="(value, key) in selected.fields" :key="key" class="break-all">{{ key }} = {{ formatValue(value) }}</div>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useVirtualList } from "@vueuse/core";
import dayjs from "dayjs";
import { Search } from "@kabegame/element-plus-icons";
import { useI18n } from "@kabegame/i18n";
import { IS_ANDROID, IS_WEB } from "@/env";
import { useModal } from "@/composables/useModal";
import { useAppLogsStore } from "@/stores/appLogs";
import { useUiStore } from "@/stores/ui";
import { LOG_LEVELS, openLogsDir, type LogLevel, type LogRecord } from "@/services/appLogs";
import { writeClipboardText } from "@/utils/imageLabels";
import { kameMessage as ElMessage } from "@/utils/kameMessage";

const ROW_HEIGHT = 22;
const FRONTEND_TARGET = "webview";

const { t } = useI18n();
const store = useAppLogsStore();
const uiStore = useUiStore();
const { isOpen, zIndex, open, close } = useModal({ onClose: () => store.close() });

watch(
  () => store.visible,
  (visible) => (visible ? open() : close()),
  { immediate: true },
);
watch(isOpen, (value) => (value ? void store.start() : store.stop()));

const canOpenDir = !IS_WEB && !IS_ANDROID;

const levels = ref<LogLevel[]>(["ERROR", "WARN", "INFO"]);
const source = ref<"all" | "backend" | "frontend">("all");
/** el-select 清除时会置为 undefined */
const targetPrefix = ref<string | undefined>("");
const keyword = ref("");
const follow = ref(true);
const selected = ref<LogRecord | null>(null);

const isFrontend = (record: LogRecord) =>
  record.target === FRONTEND_TARGET || record.target.startsWith(`${FRONTEND_TARGET}:`);

/** 已出现过的 target，取到第二段模块路径为止（如 `kabegame_core::crawler`），供下拉选择前缀 */
const knownTargets = computed(() => {
  const set = new Set<string>();
  for (const record of store.records) {
    set.add(record.target.split("::").slice(0, 2).join("::"));
  }
  return [...set].sort();
});

const filtered = computed(() => {
  const levelSet = new Set(levels.value);
  const prefix = (targetPrefix.value ?? "").trim().replace(/:+$/, "");
  const needle = keyword.value.trim().toLowerCase();
  return store.records.filter((record) => {
    if (!levelSet.has(record.level)) return false;
    if (source.value === "frontend" && !isFrontend(record)) return false;
    if (source.value === "backend" && isFrontend(record)) return false;
    // 按 `::` 分段匹配：`kabegame` 不命中 `kabegame_core::…`，`webview` 命中 `webview:main`
    if (prefix && record.target !== prefix && !record.target.startsWith(`${prefix}:`)) return false;
    if (needle) {
      const haystack = `${record.message} ${record.target} ${record.fields ? JSON.stringify(record.fields) : ""}`;
      if (!haystack.toLowerCase().includes(needle)) return false;
    }
    return true;
  });
});

const {
  list: virtualList,
  containerProps,
  wrapperProps,
  scrollTo,
} = useVirtualList(filtered, { itemHeight: ROW_HEIGHT, overscan: 12 });

// 跟随模式下新日志到达或过滤变化都滚到底；用户手动上翻即暂停跟随
watch(
  () => filtered.value.length,
  async (length) => {
    if (!follow.value || length === 0) return;
    await nextTick();
    scrollTo(length - 1);
  },
);
watch(follow, async (value) => {
  if (!value || filtered.value.length === 0) return;
  await nextTick();
  scrollTo(filtered.value.length - 1);
});

// 与 containerProps 里的 onScroll 合并调用（Vue 会把两个监听器都挂上）
const handleScroll = (event: Event) => {
  const el = event.target as HTMLElement;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_HEIGHT * 2;
  if (!atBottom && follow.value) follow.value = false;
};

const formatTime = (ts: number) => dayjs(ts).format("HH:mm:ss.SSS");
const formatFullTime = (ts: number) => dayjs(ts).format("YYYY-MM-DD HH:mm:ss.SSS");
const formatValue = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

const levelClass = (level: LogLevel) => {
  switch (level) {
    case "ERROR":
      return "text-[var(--el-color-danger)]";
    case "WARN":
      return "text-[var(--el-color-warning)]";
    case "INFO":
      return "text-[var(--el-color-success)]";
    default:
      return "text-[var(--anime-text-secondary)]";
  }
};

const rowClass = (record: LogRecord) => {
  if (record.level === "ERROR") return "bg-[rgba(239,68,68,0.08)]";
  if (record.level === "WARN") return "bg-[rgba(245,158,11,0.08)]";
  return "";
};

const formatLine = (record: LogRecord) => {
  const fields = record.fields
    ? Object.entries(record.fields)
        .map(([key, value]) => ` ${key}=${formatValue(value)}`)
        .join("")
    : "";
  return `${formatFullTime(record.ts)} ${record.level.padStart(5)} ${record.target}: ${record.message}${fields}`;
};

const copyRecords = async (records: LogRecord[]) => {
  try {
    await writeClipboardText(records.map(formatLine).join("\n"));
    ElMessage.success(t("header.logs.copied"));
  } catch {
    ElMessage.error(t("header.logs.copyFailed"));
  }
};

const copyFiltered = () => copyRecords(filtered.value);

const openDir = async () => {
  try {
    await openLogsDir();
  } catch (error) {
    ElMessage.error(t("header.logs.openDirFailed", { detail: String(error) }));
  }
};
</script>
