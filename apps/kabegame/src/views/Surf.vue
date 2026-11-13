<template>
  <div class="surf-page">
    <div class="surf-scroll-container" :class="{ 'has-records': hasRecords, 'is-android': IS_ANDROID }">
      <PageHeader :title="$t('surf.title')" :show="surfHeaderShowIds" sticky @action="handleSurfHeaderAction">
        <template #extra>
          <Tooltip :content="$t('surf.surfHelpTitle')">
            <Button variant="ghost" size="icon" :aria-label="$t('surf.surfHelpTitle')" @click="helpOpen = true">
              <CircleHelp />
            </Button>
          </Tooltip>
        </template>
      </PageHeader>

      <div class="surf-content" :class="{ 'has-records': hasRecords }">
        <!-- Logo：搜索栏上方 -->
        <div class="surf-logo">
          <img
            :src="swimImageUrl"
            :alt="$t('surf.title')"
            draggable="false"
            class="surf-logo-img"
            :style="hasRecords ? { height: logoHeight + 'px' } : undefined"
          />
        </div>
        <!-- 输入区：一颗胶囊（左端插件选择、中间地址、右端出发），候选面板展开时下缘变直角、和面板连成一块 -->
        <div class="surf-search-row">
          <Autocomplete
            v-model="inputUrl"
            :items="suggestions"
            :item-key="(item: SurfSuggestion) => `${item.kind}:${item.value}`"
            :placeholder="$t('surf.placeholderUrl')"
            :side-offset="0"
            clearable
            :anchor-class="SEARCH_ANCHOR_CLASS"
            :input-class="SEARCH_INPUT_CLASS"
            :content-class="SUGGEST_PANEL_CLASS"
            :item-class="SUGGEST_ITEM_CLASS"
            @select="onSuggestionSelect"
            @submit="handleStart"
          >
            <template #prefix>
              <div
                class="surf-plugin-select relative flex h-full shrink-0 items-center pl-3 pr-1 after:absolute after:right-0 after:top-1/2 after:h-6 after:w-px after:-translate-y-1/2 after:bg-kb-line-strong after:content-['']"
                data-kb-autocomplete-keep
              >
                <PluginPickerField
                  :model-value="pluginQuickSelect || null"
                  :plugins="pluginsWithHttpRoot"
                  value-key="baseUrl"
                  :placeholder="$t('surf.placeholderPlugin')"
                  :select-trigger="IS_ANDROID"
                  :style="{ width: IS_ANDROID ? '40px' : '150px' }"
                  @update:model-value="onPluginQuickSelect"
                >
                  <template #compact-trigger="{ open }">
                    <button
                      type="button"
                      class="flex h-10 w-10 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-kb-fg-muted transition-colors active:bg-kb-pressed active:text-kb-fg"
                      :title="$t('surf.placeholderPlugin')"
                      :aria-label="$t('surf.placeholderPlugin')"
                      @click="open()"
                    >
                      <LayoutGrid class="size-5" />
                    </button>
                  </template>
                </PluginPickerField>
              </div>
            </template>

            <template #suffix>
              <button
                type="button"
                class="mr-2 grid size-10 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-kb-primary p-0 text-kb-primary-fg shadow-kb-sm transition-[background-color,opacity,transform] duration-150 hover:bg-kb-primary-hover active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kb-ring disabled:cursor-default disabled:opacity-30 disabled:shadow-none"
                :disabled="!inputUrl.trim()"
                :title="$t('surf.startSurf')"
                :aria-label="$t('surf.startSurf')"
                @click="handleStart"
              >
                <ArrowRight class="size-[18px]" />
              </button>
            </template>

            <template #item="{ item }">
              <span class="grid size-[18px] shrink-0 place-items-center text-kb-fg-subtle">
                <img v-if="item.icon" :src="item.icon" alt="" class="size-full rounded object-cover" />
                <span
                  v-else-if="item.kind === 'plugin'"
                  class="grid size-full place-items-center rounded bg-kb-accent text-[10px] font-700 text-white"
                >
                  {{ item.letter }}
                </span>
                <History v-else class="size-4" />
              </span>
              <!-- pre/hit/post 是同一个词的连续片段，必须紧贴：本项目
                   htmlWhitespaceSensitivity=ignore，Prettier 会把三个子节点各放一行，
                   中间的空隙渲染时折叠成一个空格，把 "kabegame" 显示成 "ka begame"。
                   注意指令注释必须精确为下述一行，多一个字都会失效。 -->
              <!-- prettier-ignore -->
              <span class="min-w-0 flex-1 truncate">{{ item.pre }}<b class="font-700">{{ item.hit }}</b>{{ item.post }}</span>
              <span class="shrink-0 pl-3 text-[12px] text-kb-fg-subtle">{{ item.meta }}</span>
            </template>
          </Autocomplete>
        </div>

        <!-- 畅游记录列表 -->
        <div class="surf-list-wrap" @wheel="onListWheel">
          <transition-group name="surf-list" tag="div" class="surf-list">
            <div
              v-for="record in surfStore.records"
              :key="record.id"
              class="box-border cursor-pointer rounded-kb-lg border border-solid border-kb-line px-4 py-3.5 shadow-kb-sm transition-[box-shadow,border-color] duration-150 hover:border-kb-line-strong hover:shadow-kb-md"
              :class="cardSurfaceClass"
              @click="goImages(record.host)"
              @contextmenu.prevent="openRecordContextMenu($event, record)"
            >
              <div class="flex items-center gap-3">
                <img
                  v-if="iconDataUrl(record.icon)"
                  class="size-7 shrink-0 rounded-kb-sm"
                  :src="iconDataUrl(record.icon)"
                  alt=""
                />
                <div
                  v-else
                  class="grid size-7 shrink-0 place-items-center rounded-kb-sm bg-kb-fill text-[12px] font-600 text-kb-fg-muted"
                >
                  {{ record.host[0]?.toUpperCase() }}
                </div>
                <div class="min-w-0 flex-1">
                  <div class="truncate text-[14px] font-600 leading-5 text-kb-fg">{{ record.name || record.host }}</div>
                  <div class="truncate text-[12px] leading-[18px] text-kb-fg-subtle" :title="record.rootUrl">
                    {{ record.rootUrl }}
                  </div>
                </div>
                <Tag size="sm" class="shrink-0 tabular-nums">
                  {{ $t("surf.imageCount") }} {{ surfCounts.countOf(record.host) }}
                </Tag>
              </div>
              <div class="mt-2.5 flex items-center justify-between gap-2 text-[12px] text-kb-fg-muted">
                <span class="min-w-0 truncate" :title="formatAbsolute(record.lastVisitAt)">
                  {{ $t("surf.lastVisit") }}{{ formatRelative(record.lastVisitAt) }}
                </span>
                <div class="flex shrink-0 items-center gap-1.5">
                  <Button
                    v-if="isActiveSurf(record)"
                    size="sm"
                    variant="ghost-danger"
                    @click.stop="handleCloseSurf(record)"
                  >
                    {{ $t("surf.closeSurf") }}
                  </Button>
                  <Button size="sm" variant="ghost" @click.stop="openDetailDialog(record)">
                    {{ $t("surf.recordDetails") }}
                  </Button>
                  <Button size="sm" variant="primary" @click.stop="handleRecordClick(record)">
                    {{ isActiveSurf(record) ? $t("surf.openSurf") : $t("surf.startSurf") }}
                  </Button>
                </div>
              </div>
            </div>
          </transition-group>
        </div>
      </div>
    </div>

    <ActionRenderer
      :visible="recordMenu.visible.value"
      :position="recordMenu.position.value"
      :actions="surfRecordActions as import('@/actions/types').ActionItem<unknown>[]"
      :context="recordMenuContext"
      :z-index="recordMenu.zIndex.value"
      @close="recordMenu.hide"
      @command="(cmd) => handleRecordMenuCommand(cmd as SurfRecordMenuCommand)"
    />

    <Dialog
      v-model:open="detailOpen"
      :title="detailRecord?.name || detailRecord?.host || $t('surf.recordDetails')"
      :width="600"
      @close-auto-focus="resetDetailDialog"
    >
      <div v-if="detailRecord" class="flex flex-col gap-4 [--kb-field-label-width:96px]">
        <Field :label="$t('surf.recordName')" orientation="horizontal">
          <Input v-model="detailName" :placeholder="$t('surf.recordNamePlaceholder')" @blur="saveDetailName" />
        </Field>
        <Field :label="$t('surf.entryPath')" orientation="horizontal" :description="detailFullUrlPreview">
          <Input v-model="detailEntryPath" :placeholder="$t('surf.entryPathPlaceholder')" @blur="saveDetailEntryPath" />
        </Field>
        <Field :label="$t('surf.lastVisitLabel')" orientation="horizontal">
          <span class="flex h-8 items-center text-[13px] tabular-nums text-kb-fg">
            {{ formatAbsolute(detailRecord.lastVisitAt) }}
          </span>
        </Field>
        <Field :label="$t('surf.cookieLabel')" orientation="horizontal">
          <Textarea
            :model-value="detailRecord?.cookie || ''"
            :rows="5"
            readonly
            :placeholder="$t('surf.cookieEmpty')"
            class="kb-selectable font-mono text-[12px]"
          />
        </Field>
      </div>

      <template #footer>
        <Button variant="ghost-danger" class="mr-auto" @click="deleteRecordFromDetail">
          <Trash2 />
          {{ $t("surf.deleteRecordDanger") }}
        </Button>
        <Button @click="detailOpen = false">{{ $t("common.close") }}</Button>
        <Button variant="primary" :disabled="!(detailRecord?.cookie || '').trim()" @click="copyDetailCookie">
          <Check v-if="detailCopyDone" />
          <Copy v-else />
          {{ detailCopyDone ? $t("surf.copied") : $t("surf.copy") }}
        </Button>
      </template>
    </Dialog>

    <Dialog v-model:open="helpOpen" :title="$t('surf.surfHelpTitle')" :width="420">
      <p class="m-0 mb-3 text-[13px] leading-[1.7] text-[var(--kb-fg-regular)]">
        {{ $t(IS_ANDROID ? "surf.surfHelpIntroAndroid" : "surf.surfHelpIntro") }}
      </p>
      <p class="m-0 text-[13px] leading-[1.7] text-[var(--kb-fg-regular)]">
        {{ $t(IS_ANDROID ? "surf.surfHelpRecordAndroid" : "surf.surfHelpRecord") }}
      </p>
      <template #footer>
        <Button variant="primary" @click="helpOpen = false">{{ $t("surf.gotIt") }}</Button>
      </template>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import { useRouter } from "vue-router";
import { ArrowRight, Check, CircleHelp, Copy, History, LayoutGrid, Trash2 } from "@lucide/vue";
import { kameMessage } from "@/utils/kameMessage";
import PageHeader from "@/components/common/PageHeader.vue";
import { HeaderFeatureId } from "@/stores/header";
import { useSurfStore, type SurfRecord } from "@/stores/surf";
import { useSurfImageCounts } from "@/composables/useSurfImageCounts";
import { usePluginStore } from "@/stores/plugins";
import { useI18n } from "@kabegame/i18n";
import { useActionMenu } from "@/composables/useActionMenu";
import ActionRenderer from "@/components/ActionRenderer.vue";
import { createSurfRecordActions } from "@/actions/surfRecordActions";
import { useSettingsStore } from "@/stores/settings";
import PluginPickerField from "@/components/PluginPickerField.vue";
import { formatAbsoluteTime, formatRelativeTime } from "@/utils/relativeTime";
import { IS_ANDROID } from "@/env";
import { swimImageUrl } from "@/assets/illustrations";
import { Autocomplete, Button, Dialog, Field, Input, Tag, Textarea, Tooltip } from "@/components/ui";
import { messageBox } from "@/components/ui/messageBox";

const { t } = useI18n();
const router = useRouter();
const surfStore = useSurfStore();
const surfCounts = useSurfImageCounts();
const pluginStore = usePluginStore();
const settingsStore = useSettingsStore();
// 开应用背景时卡片半透明磨砂，否则实底（两套类分开写：没有 tailwind-merge，叠加覆盖不可靠）
const cardSurfaceClass = computed(() =>
  settingsStore.values.appBackgroundEnabled ? "bg-kb-glass-strong backdrop-blur-md" : "bg-kb-surface-raised",
);
const surfHeaderShowIds = computed(() => [HeaderFeatureId.TaskDrawer]);

const helpOpen = ref(false);
const detailOpen = ref(false);
const detailRecord = ref<SurfRecord | null>(null);
const detailName = ref("");
const detailEntryPath = ref("/");
const detailCopyDone = ref(false);

const inputUrl = ref("");
const pluginQuickSelect = ref("");

/**
 * 地址栏造型（Autocomplete 的整套类替换）。外框带 data-open：面板真的展开（有候选）时胶囊下缘变直角、
 * 和面板连成一块（Google 的做法）；没有候选时不变，免得「方角接空气」。
 */
const SEARCH_ANCHOR_CLASS =
  "box-border flex h-14 w-full items-center rounded-[28px] border border-solid border-kb-line bg-kb-surface-raised shadow-kb-sm transition-[box-shadow,border-color,border-radius] duration-200 hover:shadow-kb-md focus-within:border-transparent focus-within:shadow-kb-lg data-[open]:rounded-b-none data-[open]:border-transparent data-[open]:shadow-kb-pop";
const SEARCH_INPUT_CLASS =
  "h-full min-w-0 flex-1 border-0 bg-transparent px-3 py-0 text-[15px] text-kb-fg outline-none [font-family:inherit] placeholder:text-kb-fg-subtle";
// 最多 8 条 × 44px，不在末尾裁出半行
const SUGGEST_PANEL_CLASS =
  "box-border max-h-[368px] overflow-y-auto rounded-b-[20px] border-0 border-t border-solid border-kb-line bg-kb-surface-raised py-2 shadow-kb-pop outline-none data-[state=open]:animate-[kb-fade-in_120ms_ease-out]";
const SUGGEST_ITEM_CLASS =
  "flex h-11 cursor-pointer select-none items-center gap-3 px-[22px] text-[13.5px] text-kb-fg data-[highlighted]:bg-kb-hover";

type SurfSuggestion = {
  kind: "plugin" | "history";
  /** 选中后填入输入框、用来打开的地址 */
  value: string;
  pre: string;
  hit: string;
  post: string;
  meta: string;
  icon?: string;
  letter?: string;
  host?: string;
};

/** 把 text 按 q 切成 前 / 命中 / 后 三段，供模板加粗（不用 v-html，避免 XSS） */
function highlight(text: string, q: string) {
  if (!q) return { pre: text, hit: "", post: "" };
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return { pre: text, hit: "", post: "" };
  return {
    pre: text.slice(0, i),
    hit: text.slice(i, i + q.length),
    post: text.slice(i + q.length),
  };
}

function handleSurfHeaderAction(_payload: { id: string; data: { type: string } }) {
  // HeaderFeatureId.Help 已下线，帮助按钮改为页面本地入口（见上方 #extra 插槽）；
  // 当前 show 区只剩 TaskDrawer，其自身处理点击，不经过这里。
}

const surfRecordActions = createSurfRecordActions();
const recordMenu = useActionMenu<SurfRecord>();
const recordMenuContext = computed(() => ({
  target: recordMenu.context.value.target,
  selectedIds: new Set<string>() as ReadonlySet<string>,
  selectedCount: 0,
}));

/** 声明了以 http 开头的根 URL 的插件（用于快速填入输入框） */
const pluginsWithHttpRoot = computed(() =>
  pluginStore.plugins.filter((p) => p.baseUrl && p.baseUrl.toLowerCase().startsWith("http")),
);

const onPluginQuickSelect = (baseUrl: string | null) => {
  inputUrl.value = baseUrl ?? "";
  pluginQuickSelect.value = "";
};

const hasRecords = computed(() => surfStore.records.length > 0);

const LOGO_MAX = 180;
const LOGO_MIN = 80;
const logoHeight = ref(LOGO_MAX);

const onListWheel = (e: WheelEvent) => {
  if (!hasRecords.value) return;
  if (logoHeight.value > LOGO_MIN && e.deltaY > 0) {
    e.preventDefault();
    logoHeight.value = Math.max(LOGO_MIN, logoHeight.value - e.deltaY);
  } else if (e.deltaY < 0) {
    const target = e.currentTarget as HTMLElement;
    if (target.scrollTop <= 0) {
      e.preventDefault();
      logoHeight.value = Math.min(LOGO_MAX, logoHeight.value - e.deltaY);
    }
  }
};

const toBase64 = (bytes: number[]) =>
  btoa(new Uint8Array(bytes).reduce((acc, byte) => acc + String.fromCharCode(byte), ""));

const iconDataUrl = (bytes?: number[] | null) => {
  if (!bytes || bytes.length === 0) return "";
  return `data:image/png;base64,${toBase64(bytes)}`;
};

/** 列表/建议里只给「多久以前」，精确到秒的时间在详情弹窗看 */
const formatRelative = (ts: number) => (ts ? formatRelativeTime(ts * 1000) : "-");
const formatAbsolute = (ts: number) => (ts ? formatAbsoluteTime(ts * 1000) : "-");

function fallbackRootUrl(host: string) {
  return `https://${host}/`;
}

function parseRecordUrl(record: SurfRecord) {
  try {
    return new URL(record.rootUrl);
  } catch {
    return new URL(fallbackRootUrl(record.host));
  }
}

function extractEntryPath(record: SurfRecord) {
  const parsed = parseRecordUrl(record);
  const path = `${parsed.pathname || "/"}${parsed.search || ""}${parsed.hash || ""}`;
  return path || "/";
}

function buildRootUrl(host: string, rawPath: string) {
  const trimmed = rawPath.trim();
  const normalizedPath = !trimmed ? "/" : trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return `https://${host}${normalizedPath}`;
}

const detailFullUrlPreview = computed(() => {
  if (!detailRecord.value) return "";
  return buildRootUrl(detailRecord.value.host, detailEntryPath.value);
});

/** 规范化并校验 URL：仅允许 https；域名字符串自动补 https；http 提示需用 https；其他协议提示不支持 */
function normalizeAndValidateUrl(input: string): { url: string } | { error: string } {
  const v = input.trim();
  if (!v) return { error: t("surf.pleaseEnterUrl") };
  const lower = v.toLowerCase();
  if (lower.startsWith("https://")) return { url: v };
  if (lower.startsWith("http://")) return { error: t("surf.useHttps") };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return { error: t("surf.unsupportedProtocol") };
  return { url: `https://${v}` };
}

const handleStart = async () => {
  try {
    const result = normalizeAndValidateUrl(inputUrl.value);
    if ("error" in result) {
      kameMessage.warning(result.error);
      return;
    }
    const normalized = result.url;
    await surfStore.startSession(normalized);
    kameMessage.success(t("surf.sessionStartSuccess"));
  } catch (e: any) {
    kameMessage.error(e?.message || String(e) || t("surf.sessionStartFailed"));
  }
};

/**
 * 建议列表：只消费已有数据源（pluginsWithHttpRoot、surfStore.records），不新增接口。
 * 空输入 → 只出历史；有输入 → 插件 / 历史混排。当前输入由回车或右侧按钮直接打开，
 * 不再伪装成一条匿名候选。
 * 按输入同步算出，没有防抖：回车时看到的候选就是当前输入的候选。
 */
const suggestions = computed<SurfSuggestion[]>(() => {
  const q = inputUrl.value.trim();
  const lower = q.toLowerCase();
  const out: SurfSuggestion[] = [];

  // ① 已安装插件 —— 只在有输入时出现，空态不铺插件全表（全表走左端下拉）
  if (lower) {
    for (const p of pluginsWithHttpRoot.value) {
      const base = p.baseUrl;
      // name 可能是 { name?, ja?, ... } 多语言对象，统一走 store 解析成展示字符串
      const text = pluginStore.pluginLabel(p.id) || base;
      if (!text.toLowerCase().includes(lower) && !base.toLowerCase().includes(lower)) continue;
      out.push({
        kind: "plugin",
        value: base,
        ...highlight(text, q),
        meta: t("surf.suggestPlugin"),
        icon: pluginStore.pluginIconSrc(p.id),
        letter: text[0]?.toUpperCase(),
      });
    }
  }

  // ② 历史畅游记录 —— 空输入时这里就是「最近畅游」列表
  for (const r of surfStore.records) {
    const text = r.name || r.host;
    if (lower && !text.toLowerCase().includes(lower) && !r.rootUrl.toLowerCase().includes(lower)) continue;
    out.push({
      kind: "history",
      value: r.rootUrl,
      host: r.host,
      ...highlight(text, q),
      meta: `${formatRelative(r.lastVisitAt)} · ${t("surf.imageCount")} ${surfCounts.countOf(r.host)}`,
      icon: iconDataUrl(r.icon) || undefined,
    });
  }

  return out.slice(0, 8);
});

/** 点候选，或用方向键选中后回车；直接回车（没选候选）由 Autocomplete 的 submit 提交输入框原文。 */
const onSuggestionSelect = async (s: SurfSuggestion) => {
  inputUrl.value = s.value;
  // 历史记录走 handleRecordClick（它带上记录自己的 rootUrl 语义）
  if (s.kind === "history" && s.host) {
    const record = surfStore.records.find((r) => r.host === s.host);
    if (record) return handleRecordClick(record);
  }
  await handleStart();
};

async function openDetailDialog(record: SurfRecord) {
  try {
    const latest = await surfStore.getRecord(record.host);
    const target = latest ?? record;
    detailRecord.value = target;
    detailName.value = target.name || "";
    detailEntryPath.value = extractEntryPath(target);
    detailCopyDone.value = false;
    detailOpen.value = true;
  } catch (e: any) {
    kameMessage.error(e?.message || String(e) || t("surf.operationFailed"));
  }
}

function resetDetailDialog() {
  detailRecord.value = null;
  detailName.value = "";
  detailEntryPath.value = "/";
  detailCopyDone.value = false;
}

async function saveDetailName() {
  const record = detailRecord.value;
  if (!record) return;
  const nextName = detailName.value.trim();
  if (nextName === (record.name || "")) return;
  try {
    await surfStore.updateName(record.host, nextName);
    detailRecord.value = { ...record, name: nextName };
    kameMessage.success(t("surf.savedSuccess"));
  } catch (e: any) {
    kameMessage.error(e?.message || String(e) || t("surf.operationFailed"));
  }
}

async function saveDetailEntryPath() {
  const record = detailRecord.value;
  if (!record) return;
  const nextRootUrl = buildRootUrl(record.host, detailEntryPath.value);
  if (nextRootUrl === record.rootUrl) return;
  try {
    await surfStore.updateRootUrl(record.host, nextRootUrl);
    detailRecord.value = { ...record, rootUrl: nextRootUrl };
    kameMessage.success(t("surf.savedSuccess"));
  } catch (e: any) {
    kameMessage.error(e?.message || String(e) || t("surf.operationFailed"));
  }
}

async function copyDetailCookie() {
  const cookie = (detailRecord.value?.cookie || "").trim();
  if (!cookie) return;
  try {
    await navigator.clipboard.writeText(cookie);
    detailCopyDone.value = true;
    kameMessage.success(t("surf.copySuccess"));
  } catch {
    kameMessage.error(t("common.copyFailed"));
  }
}

async function confirmAndDeleteRecord(record: SurfRecord) {
  await messageBox.confirm(t("surf.deleteRecordConfirm", { host: record.host }), t("surf.deleteRecordTitle"), {
    confirmButtonText: t("surf.deleteButton"),
    cancelButtonText: t("common.cancel"),
    type: "warning",
  });
  await surfStore.deleteRecord(record.host);
  kameMessage.success(t("surf.deleteSuccess"));
}

async function deleteRecordFromDetail() {
  const record = detailRecord.value;
  if (!record) return;
  try {
    await confirmAndDeleteRecord(record);
    detailOpen.value = false;
  } catch (e: any) {
    if (e !== "cancel") {
      kameMessage.error(e?.message || String(e) || t("surf.deleteFailed"));
    }
  }
}

const handleRecordClick = async (record: SurfRecord) => {
  try {
    inputUrl.value = record.rootUrl;
    await surfStore.startSession(record.rootUrl);
    kameMessage.success(t("surf.sessionStartSuccess"));
  } catch (e: any) {
    kameMessage.error(e?.message || String(e) || t("surf.sessionStartFailed"));
  }
};

const isActiveSurf = (record: SurfRecord) => surfStore.sessionActive && surfStore.activeHost === record.host;

const handleCloseSurf = async (record: SurfRecord) => {
  try {
    await surfStore.closeSession(record.host);
    kameMessage.success(t("surf.sessionClosed"));
  } catch (e: any) {
    kameMessage.error(e?.message || String(e) || t("surf.operationFailed"));
  }
};

const goImages = (host: string) => {
  router.push(`/surf/${host}/images`);
};

const openRecordContextMenu = (e: MouseEvent, record: SurfRecord) => {
  recordMenu.show(record, e);
};

type SurfRecordMenuCommand = "viewImages" | "details" | "addToHome" | "delete";

const handleRecordMenuCommand = async (command: SurfRecordMenuCommand) => {
  const record = recordMenu.context.value.target;
  recordMenu.hide();
  if (!record) return;
  if (command === "viewImages") {
    goImages(record.host);
    return;
  }
  if (command === "details") {
    await openDetailDialog(record);
    return;
  }
  if (command === "addToHome") {
    // 成功时系统 Toast 已提示（含国产 ROM 权限说明），这里只处理失败。
    try {
      await surfStore.pinShortcut(record.host);
    } catch (e: any) {
      kameMessage.error(e?.message || String(e) || t("surf.operationFailed"));
    }
    return;
  }
  if (command === "delete") {
    try {
      await confirmAndDeleteRecord(record);
    } catch (e: any) {
      if (e !== "cancel") {
        kameMessage.error(e?.message || String(e) || t("surf.deleteFailed"));
      }
    }
  }
};

onMounted(async () => {
  await surfStore.init();
});
</script>

<style scoped lang="scss">
.surf-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}

/* 外层容器：无记录时整体可滚动；有记录时不滚动，由内部列表独立滚动 */
.surf-scroll-container {
  flex: 1;
  padding: 20px;
  display: flex;
  flex-direction: column;
  min-height: 0;

  &:not(.has-records) {
    overflow-y: auto;
    overflow-x: hidden;
  }

  &.has-records {
    overflow: hidden;
  }

  &.is-android {
    padding: 0;

    .surf-content {
      width: 100%;
    }

    .surf-search-row {
      width: 92%;
    }
  }
}

/* 内容区：空态居中，有记录时 flex 填满 */
.surf-content {
  width: 80%;
  max-width: 720px;
  margin: 0 auto;

  &:not(.has-records) {
    padding: 24px 0 32px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    min-height: 60vh;
  }

  &.has-records {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    padding-top: 16px;
  }
}

.surf-logo {
  display: flex;
  justify-content: center;
  flex-shrink: 0;

  .surf-content:not(.has-records) & {
    margin-bottom: 24px;
  }

  .surf-content.has-records & {
    margin-bottom: 12px;
  }
}

.surf-logo-img {
  display: block;
  width: auto;
  object-fit: contain;
  border-radius: 12px;

  .surf-content:not(.has-records) & {
    height: 180px;
  }

  .surf-content.has-records & {
    transition: height 0.22s ease-out;
  }
  /* has-records 时 height 由 JS :style 绑定控制 */
}

.surf-search-row {
  width: 100%;
  max-width: 640px;
  margin: 0 auto;
  flex-shrink: 0;

  .surf-content.has-records & {
    margin-bottom: 16px;
  }
}

/* 左端插件选择器嵌在胶囊里：去掉它自己的输入框外框，只留文字与下拉箭头（分隔线由外层 ::after 画） */
.surf-plugin-select :deep(.kb-control) {
  border-color: transparent;
  background: transparent;
  box-shadow: none;
}

/* 列表区：有记录时占据剩余空间、独立滚动 */
.surf-list-wrap {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;

  .surf-content.has-records & {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    padding-bottom: 16px;
    scrollbar-width: none;

    &::-webkit-scrollbar {
      display: none;
    }
  }
}

.surf-list {
  width: 92%;
  max-width: 100%;
  display: grid;
  gap: 10px;
  /* 卡片悬停阴影不被滚动容器裁掉 */
  padding: 2px 0;
}

/* 列表进入/离开/重排动画 */
.surf-list-enter-active,
.surf-list-leave-active {
  transition:
    opacity 0.25s ease,
    transform 0.25s ease;
}

.surf-list-enter-from {
  opacity: 0;
  transform: translateY(-8px);
}

.surf-list-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

.surf-list-move {
  transition: transform 0.3s ease;
}
</style>
