<template>
  <div class="flex h-full min-h-0">
    <KbResizable
      v-model="menuWidth"
      side="right"
      class="flex-none flex min-h-0"
      :default-size="menuDefaultWidth"
      :handle-title="t('plugins.detail.tabPathql')"
    >
      <KbMenuList v-model:active="selectedName" :groups="menuGroups" class="flex-1 min-w-0 min-h-0">
        <template v-if="namespace" #title>
          {{ t("plugins.detail.providerNamespace") }} <span class="font-mono">{{ namespace }}</span>
        </template>
        <!-- 选中 provider 的 note 摘要卡（设计稿左栏底部） -->
        <template v-if="selectedSummaryNote" #footer>
          <div class="kb-card mt-2.5 py-2.5 px-3 text-13px leading-[1.7] text-[var(--anime-text-muted)]">
            {{ selectedSummaryNote }}
          </div>
        </template>
      </KbMenuList>
    </KbResizable>

    <div class="flex-1 min-w-0 min-h-0 overflow-y-auto [scrollbar-width:none]">
      <el-empty v-if="!canQuery" :description="t('plugins.detail.providerInstallFirst')" :image-size="80" class="mt-10" />
      <el-empty v-else-if="!loading && !summaries.length" :description="t('plugins.detail.noProviders')" :image-size="80" class="mt-10" />
      <div v-else-if="detail" class="flex flex-col h-full min-h-0">
        <div class="flex items-center gap-2.5 py-3 px-5.5">
          <div class="font-800 text-15px">{{ detail.name }}</div>
          <span class="kb-chip bg-[#ecf5ff] text-[#409eff]">json5</span>
          <div class="flex-1" />
          <div class="inline-flex items-center gap-0.5 p-0.75 rounded-14px bg-[var(--anime-bg-sidebar)]">
            <button
              type="button"
              class="w-7.5 h-6.5 border-none rounded-11px flex items-center justify-center cursor-pointer"
              :class="viewMode === 'pretty' ? 'kb-grad text-white' : 'bg-transparent text-[var(--anime-text-primary)]'"
              :title="t('plugins.detail.viewPretty')"
              @click="viewMode = 'pretty'"
            >
              <el-icon :size="14"><Tickets /></el-icon>
            </button>
            <button
              type="button"
              class="w-7.5 h-6.5 border-none rounded-11px flex items-center justify-center cursor-pointer"
              :class="viewMode === 'source' ? 'kb-grad text-white' : 'bg-transparent text-[var(--anime-text-primary)]'"
              :title="t('plugins.detail.viewSource')"
              @click="viewMode = 'source'"
            >
              <el-icon :size="14"><Document /></el-icon>
            </button>
          </div>
        </div>

        <div class="flex-1 min-h-0 overflow-y-auto [scrollbar-width:none] py-4 px-5.5 flex flex-col gap-2.5">
          <template v-if="viewMode === 'pretty'">
            <!-- 概览卡：设计稿是「固定标签列 + 值列」的两列对齐，不是标签值混排 -->
            <div class="kb-card py-3.5 px-4 flex flex-col gap-2.5">
              <div class="text-13px font-600 text-[var(--anime-text-muted)]">{{ t("plugins.detail.providerOverview") }}</div>
              <div class="grid gap-x-3 gap-y-2 items-baseline" style="grid-template-columns: 104px minmax(0, 1fr)">
                <template v-if="noteTitle">
                  <div class="text-14px text-[var(--anime-text-muted)]">note</div>
                  <div class="text-14px leading-[1.6]">
                    <span class="font-700">{{ noteTitle }}</span>
                    <span v-if="noteContent"> · {{ noteContent }}</span>
                  </div>
                </template>
                <template v-if="fields.length">
                  <div class="text-14px text-[var(--anime-text-muted)]">query.fields</div>
                  <div class="flex flex-col gap-1.5 min-w-0">
                    <div v-for="(f, i) in fields" :key="i" class="text-13px font-mono leading-[1.6] break-all">
                      <span class="font-700">{{ f.alias ?? "?" }}</span>
                      <span class="text-[var(--anime-text-muted)]"> ← </span>
                      <span class="text-[var(--anime-text-secondary)]">{{ f.sql }}</span>
                      <span v-if="f.inNeed" class="text-[var(--anime-text-muted)]"> · in_need</span>
                    </div>
                  </div>
                </template>
                <div class="text-14px text-[var(--anime-text-muted)]">{{ t("plugins.detail.providerListLabel") }}</div>
                <div class="text-13.5px">{{ t("plugins.detail.providerListBranches", { n: listEntries.length }) }}</div>
              </div>
              <div v-if="!detail.source" class="text-13px text-[var(--anime-text-muted)] italic">
                {{ t("plugins.detail.providerDefaultInjected") }}
              </div>
            </div>

            <!-- list 分支卡 -->
            <div v-for="entry in listEntries" :key="entry.key" class="kb-card py-3.5 px-4 flex flex-col gap-2.5">
              <div class="font-700 text-15px font-mono break-all">{{ entry.key }}</div>
              <div class="grid gap-x-3 gap-y-2 items-baseline" style="grid-template-columns: 104px minmax(0, 1fr)">
                <template v-if="entry.dataVar">
                  <div class="text-14px text-[var(--anime-text-muted)]">data_var</div>
                  <div class="text-14.5px font-mono font-700 break-all">{{ entry.dataVar }}</div>
                </template>
                <template v-if="entry.provider">
                  <div class="text-14px text-[var(--anime-text-muted)]">provider</div>
                  <div class="text-14.5px font-mono font-700 break-all">{{ entry.provider }}</div>
                </template>
                <template v-if="entry.childVar">
                  <div class="text-14px text-[var(--anime-text-muted)]">child_var</div>
                  <div class="text-14.5px font-mono font-700 break-all">{{ entry.childVar }}</div>
                </template>
                <template v-if="entry.sql">
                  <div class="text-14px text-[var(--anime-text-muted)]">sql</div>
                  <pre class="m-0 py-2 px-2.5 min-w-0 rounded-8px bg-[color-mix(in_srgb,white_55%,transparent)] border border-solid border-[var(--anime-border)] overflow-x-auto text-12.5px font-mono leading-[1.6] max-h-28">{{ entry.sql }}</pre>
                </template>
                <template v-if="entry.properties">
                  <div class="text-14px text-[var(--anime-text-muted)]">properties</div>
                  <div class="text-12.5px font-mono text-[var(--anime-text-secondary)] leading-[1.6] break-all">{{ entry.properties }}</div>
                </template>
                <template v-if="entry.meta">
                  <div class="text-14px text-[var(--anime-text-muted)]">meta</div>
                  <div class="text-12.5px font-mono text-[var(--anime-text-secondary)] leading-[1.6] break-all">{{ entry.meta }}</div>
                </template>
              </div>
            </div>
          </template>
          <pre v-else class="m-0 py-2.5 px-3 rounded-10px bg-[color-mix(in_srgb,white_55%,transparent)] border border-solid border-[var(--anime-border)] overflow-auto text-13px font-mono leading-[1.6]">{{ sourceText }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Document, Tickets } from "@kabegame/element-plus-icons";
import { useI18n } from "@kabegame/i18n";
import KbMenuList, { type KbMenuGroup } from "../common/KbMenuList.vue";
import KbResizable from "../common/KbResizable.vue";
import { invoke } from "../../api";

interface ProviderSummary {
  name: string;
  namespace?: string | null;
  sourcePath?: string | null;
  note?: { title: string; content: string } | null;
}

interface ProviderDetail {
  name: string;
  namespace?: string | null;
  sourcePath?: string | null;
  source?: string | null;
  def?: Record<string, any> | null;
}

const props = defineProps<{
  pluginId: string | null;
  /** 只有已安装且版本与展示对象一致时才发请求；否则 provider 定义可能对不上正在看的版本 */
  canQuery: boolean;
  /** 双击把手复位到的左栏宽度；上下限由 kb-side-pane 的 CSS 变量给 */
  menuDefaultWidth?: number;
}>();

/** 左栏宽度（px），与其它 tab 共用同一个值，由宿主持久化 */
const menuWidth = defineModel<number>("menuWidth");

const emit = defineEmits<{
  /** provider 摘要拉取完成（供外层 tab 计数徽标回填，未拉取前不知道数量） */
  (e: "loaded", count: number): void;
}>();

const { t } = useI18n();

const summaries = ref<ProviderSummary[]>([]);
const detailByName = ref<Record<string, ProviderDetail>>({});
const selectedName = ref<string | null>(null);
const loading = ref(false);
const viewMode = ref<"pretty" | "source">("pretty");

const namespace = computed(() => summaries.value[0]?.namespace ?? "");
// 左栏菜单：单组无标题（标题位给命名空间），provider 名是标识符故走 mono
const menuGroups = computed<KbMenuGroup[]>(() => [
  {
    key: "providers",
    items: summaries.value.map((item) => ({ name: item.name, label: item.name, mono: true })),
  },
]);
const detail = computed(() => (selectedName.value ? detailByName.value[selectedName.value] ?? null : null));
/** 左栏底部摘要卡：选中 provider 的 note（优先正文，退化到标题） */
const selectedSummaryNote = computed(() => {
  const note = summaries.value.find((s) => s.name === selectedName.value)?.note;
  return note?.content || note?.title || "";
});

watch(selectedName, () => {
  viewMode.value = "pretty";
});

async function loadSummaries() {
  summaries.value = [];
  detailByName.value = {};
  selectedName.value = null;
  if (!props.canQuery || !props.pluginId) return;
  loading.value = true;
  try {
    const rows = await invoke<ProviderSummary[]>("pathql_fetch", {
      path: `plugin://${props.pluginId}/provider`,
    });
    summaries.value = Array.isArray(rows) ? rows : [];
    if (summaries.value.length) {
      selectedName.value = summaries.value[0].name;
    }
    emit("loaded", summaries.value.length);
  } catch {
    summaries.value = [];
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.pluginId, props.canQuery] as const,
  () => {
    void loadSummaries();
  },
  { immediate: true }
);

watch(selectedName, async (name) => {
  if (!name || !props.pluginId || detailByName.value[name]) return;
  try {
    const rows = await invoke<ProviderDetail[]>("pathql_fetch", {
      path: `plugin://${props.pluginId}/provider/${encodeURIComponent(name)}`,
    });
    const row = Array.isArray(rows) ? rows[0] : null;
    if (row) detailByName.value = { ...detailByName.value, [name]: row };
  } catch {
    /* 保持未加载态，源码/概览区留空 */
  }
});

function parseNote(raw: unknown): { title: string; content: string } | null {
  if (raw == null) return null;
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (typeof o.title === "string" && typeof o.content === "string") {
      return { title: o.title, content: o.content };
    }
    return null;
  }
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.title === "string" && typeof parsed.content === "string") {
      return { title: parsed.title, content: parsed.content };
    }
  } catch {
    /* 非 JSON：整串当 title=content */
  }
  return { title: raw, content: raw };
}

const noteParsed = computed(() => parseNote(detail.value?.def?.note ?? null));
const noteTitle = computed(() => noteParsed.value?.title ?? "");
const noteContent = computed(() => {
  const n = noteParsed.value;
  return n && n.content !== n.title ? n.content : "";
});

const fields = computed<Array<{ sql: string; alias: string | null; inNeed: boolean }>>(() => {
  const raw = detail.value?.def?.query?.fields;
  if (!Array.isArray(raw)) return [];
  return raw.map((f: any) => ({
    sql: String(f?.sql ?? ""),
    alias: f?.as ?? null,
    inNeed: Boolean(f?.in_need),
  }));
});

const listEntries = computed(() => {
  const list = detail.value?.def?.list;
  if (!list || typeof list !== "object") return [] as any[];
  return Object.entries(list as Record<string, any>).map(([key, value]) => ({
    key,
    sql: typeof value?.sql === "string" ? value.sql : null,
    dataVar: value?.data_var ?? null,
    provider: typeof value?.provider === "string" ? value.provider : null,
    childVar: value?.child_var ?? null,
    properties: value?.properties ? JSON.stringify(value.properties) : null,
    meta: value?.meta ? JSON.stringify(value.meta) : null,
  }));
});

const sourceText = computed(() => detail.value?.source ?? t("plugins.detail.providerDefaultInjected"));
</script>
