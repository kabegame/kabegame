<template>
  <Dialog v-model:open="open" :title="t('header.logs.title')" :width="960" :fullscreen="uiStore.isCompact">
    <div class="flex min-w-0 flex-col gap-2">
      <div class="flex flex-wrap items-center gap-2">
        <!-- 级别多选：同分段控件的外观，可同时按下多个 -->
        <ToggleGroupRoot
          v-model="levels"
          type="multiple"
          class="inline-flex max-w-full items-center gap-0.5 rounded-kb-md bg-kb-fill p-0.5"
        >
          <ToggleGroupItem
            v-for="level in LOG_LEVELS"
            :key="level"
            :value="level"
            class="box-border inline-flex h-7 cursor-pointer items-center justify-center whitespace-nowrap rounded-[6px] border-0 px-2.5 py-0 font-mono text-[12px] font-500 leading-none outline-none transition-[background-color,color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-kb-ring data-[state=on]:bg-kb-surface-raised data-[state=on]:text-kb-fg data-[state=on]:shadow-kb-sm data-[state=off]:bg-transparent data-[state=off]:text-kb-fg-subtle data-[state=off]:hover:text-kb-fg-muted"
          >
            {{ level }}
          </ToggleGroupItem>
        </ToggleGroupRoot>
        <SegmentedControl v-model="source" :options="sourceOptions" />
        <div class="w-56">
          <Autocomplete
            v-model="targetDraft"
            :items="targetCandidates"
            clearable
            :placeholder="t('header.logs.targetPlaceholder')"
            @select="applyTarget"
            @submit="applyTarget"
            @blur="applyTarget(targetDraft)"
          >
            <template #item="{ item }">
              <span class="truncate font-mono text-[12px]">{{ item }}</span>
            </template>
          </Autocomplete>
        </div>
        <div class="w-48">
          <Input v-model="keyword" clearable :placeholder="t('header.logs.searchPlaceholder')">
            <template #prefix><Search /></template>
          </Input>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-3 text-[12px] text-kb-fg-muted">
        <span class="tabular-nums">
          {{ t("header.logs.count", { shown: filtered.length, total: store.records.length }) }}
        </span>
        <label class="flex cursor-pointer items-center gap-1.5">
          <Switch v-model="follow" size="sm" />
          {{ t("header.logs.follow") }}
        </label>
        <span class="flex-1" />
        <Button variant="ghost" size="sm" @click="copyFiltered">
          <Copy />
          {{ t("header.logs.copy") }}
        </Button>
        <Button variant="ghost" size="sm" @click="store.clear()">
          <Trash2 />
          {{ t("header.logs.clear") }}
        </Button>
        <Button v-if="canOpenDir" variant="ghost" size="sm" @click="openDir">
          <FolderOpen />
          {{ t("header.logs.openDir") }}
        </Button>
      </div>

      <div v-if="store.error" class="text-[12px] text-kb-danger">
        {{ t("header.logs.loadFailed", { detail: store.error }) }}
      </div>

      <div
        v-loading="store.loading && store.records.length === 0"
        class="kb-selectable box-border overflow-auto rounded-kb-md border border-solid border-kb-line font-mono text-[12px]"
        :class="uiStore.isCompact ? 'h-[calc(100vh-320px)]' : 'h-[420px]'"
        v-bind="containerProps"
        @scroll="handleScroll"
      >
        <div v-if="filtered.length === 0" class="py-8 text-center font-sans text-kb-fg-muted">
          {{ t("header.logs.empty") }}
        </div>
        <div v-bind="wrapperProps">
          <div
            v-for="item in virtualList"
            :key="item.data.seq"
            class="flex cursor-pointer items-center gap-2 whitespace-nowrap px-2"
            :class="selected?.seq === item.data.seq ? 'bg-kb-pressed' : rowClass(item.data)"
            :style="{ height: `${ROW_HEIGHT}px` }"
            @click="selected = item.data"
          >
            <span class="shrink-0 text-kb-fg-subtle">{{ formatTime(item.data.ts) }}</span>
            <span class="w-11 shrink-0 font-700" :class="levelClass(item.data.level)">{{ item.data.level }}</span>
            <span class="max-w-56 shrink-0 overflow-hidden text-ellipsis text-kb-fg-muted">
              {{ item.data.target }}
            </span>
            <span class="min-w-0 overflow-hidden text-ellipsis text-kb-fg">{{ item.data.message }}</span>
          </div>
        </div>
      </div>

      <div
        v-if="selected"
        class="kb-selectable box-border max-h-40 overflow-auto rounded-kb-md border border-solid border-kb-line p-2 font-mono text-[12px] text-kb-fg"
      >
        <div class="mb-1 flex items-center gap-2 text-kb-fg-muted">
          <span>{{ formatFullTime(selected.ts) }}</span>
          <span class="font-700" :class="levelClass(selected.level)">{{ selected.level }}</span>
          <span class="min-w-0 truncate">{{ selected.target }}</span>
          <span class="flex-1" />
          <Button variant="ghost" size="sm" @click="copyRecords([selected])">
            <Copy />
            {{ t("header.logs.copyLine") }}
          </Button>
          <Button variant="ghost" size="icon-sm" :aria-label="t('common.close')" @click="selected = null">
            <X />
          </Button>
        </div>
        <div class="whitespace-pre-wrap break-all">{{ selected.message }}</div>
        <div v-if="selected.fields && Object.keys(selected.fields).length > 0" class="mt-1 text-kb-fg-muted">
          <div v-for="(value, key) in selected.fields" :key="key" class="break-all">
            {{ key }} = {{ formatValue(value) }}
          </div>
        </div>
      </div>
    </div>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useVirtualList } from "@vueuse/core";
import dayjs from "dayjs";
import { ToggleGroupItem, ToggleGroupRoot } from "reka-ui";
import { Copy, FolderOpen, Search, Trash2, X } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import { IS_ANDROID, IS_WEB } from "@/env";
import { useAppLogsStore } from "@/stores/appLogs";
import { useUiStore } from "@/stores/ui";
import { LOG_LEVELS, openLogsDir, type LogLevel, type LogRecord } from "@/services/appLogs";
import { writeClipboardText } from "@/utils/imageLabels";
import { kameMessage } from "@/utils/kameMessage";
import { Autocomplete, Button, Dialog, Input, SegmentedControl, Switch } from "@/components/ui";
import { vLoading } from "@/components/ui/loading";

const ROW_HEIGHT = 22;
const FRONTEND_TARGET = "webview";

const { t } = useI18n();
const store = useAppLogsStore();
const uiStore = useUiStore();
// 开合以 store 为准（工具箱打开），对话框里关闭写回 store；打开期间订阅实时日志
const open = computed({
  get: () => store.visible,
  set: (value: boolean) => (value ? store.open() : store.close()),
});
watch(open, (value) => (value ? void store.start() : store.stop()), { immediate: true });

const canOpenDir = !IS_WEB && !IS_ANDROID;

const levels = ref<LogLevel[]>(["ERROR", "WARN", "INFO"]);
const source = ref<"all" | "backend" | "frontend">("all");
/** 生效的模块前缀；输入框里的草稿在回车、选候选、失焦或清空时才生效，免得打字途中列表被半截前缀筛空 */
const targetPrefix = ref("");
const targetDraft = ref("");
const keyword = ref("");
const sourceOptions = computed(() => [
  { value: "all" as const, label: t("header.logs.sourceAll") },
  { value: "backend" as const, label: t("header.logs.sourceBackend") },
  { value: "frontend" as const, label: t("header.logs.sourceFrontend") },
]);
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

/** 候选：按草稿子串匹配，草稿本身就是某个 target 时不再列它 */
const targetCandidates = computed(() => {
  const draft = targetDraft.value.trim().toLowerCase();
  if (!draft) return knownTargets.value;
  return knownTargets.value.filter((target) => target.toLowerCase().includes(draft) && target.toLowerCase() !== draft);
});

const applyTarget = (value: string) => {
  targetDraft.value = value;
  targetPrefix.value = value;
};
// 点 × 清空时立即取消筛选
watch(targetDraft, (value) => {
  if (!value) targetPrefix.value = "";
});

const filtered = computed(() => {
  const levelSet = new Set(levels.value);
  const prefix = targetPrefix.value.trim().replace(/:+$/, "");
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
      return "text-kb-danger";
    case "WARN":
      return "text-kb-warning";
    case "INFO":
      return "text-kb-success";
    default:
      return "text-kb-fg-subtle";
  }
};

/** 未选中行的底色：警告 / 错误铺一层淡底，其余只有悬停底（选中行是 bg-kb-pressed，两者互斥免得叠类） */
const rowClass = (record: LogRecord) => {
  if (record.level === "ERROR") return "bg-[color-mix(in_srgb,var(--kb-danger)_8%,transparent)]";
  if (record.level === "WARN") return "bg-[color-mix(in_srgb,var(--kb-warning)_10%,transparent)]";
  return "hover:bg-kb-hover";
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
    kameMessage.success(t("header.logs.copied"));
  } catch {
    kameMessage.error(t("header.logs.copyFailed"));
  }
};

const copyFiltered = () => copyRecords(filtered.value);

const openDir = async () => {
  try {
    await openLogsDir();
  } catch (error) {
    kameMessage.error(t("header.logs.openDirFailed", { detail: String(error) }));
  }
};
</script>
