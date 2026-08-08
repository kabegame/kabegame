<template>
  <div class="surf-page">
    <div class="surf-scroll-container" :class="{ 'has-records': hasRecords }">
      <PageHeader
        :title="$t('surf.title')"
        :show="surfHeaderShowIds"
        sticky
        @action="handleSurfHeaderAction"
      >
        <template #extra>
          <el-button circle :title="$t('surf.surfHelpTitle')" @click="helpDialog.open()">
            <el-icon><QuestionFilled /></el-icon>
          </el-button>
        </template>
      </PageHeader>

      <div class="surf-content" :class="{ 'has-records': hasRecords }">
        <!-- Logo：搜索栏上方 -->
        <div class="surf-logo">
          <img
            src="/swim.png"
            :alt="$t('surf.title')"
            draggable="false"
            class="surf-logo-img"
            :style="hasRecords ? { height: logoHeight + 'px' } : undefined"
          />
        </div>
        <!-- 输入区 -->
        <div class="surf-search-row" :class="{ 'is-open': suggestOpen }">
          <el-autocomplete
            ref="autocompleteRef"
            v-model="inputUrl"
            :fetch-suggestions="fetchSuggestions"
            :placeholder="$t('surf.placeholderUrl')"
            :trigger-on-focus="true"
            :highlight-first-item="true"
            fit-input-width
            popper-class="surf-suggest-popper"
            size="large"
            clearable
            @select="onSuggestionSelect"
            @keydown.enter="onEnterKey"
          >
            <template #prepend>
              <PluginPickerField
                :model-value="pluginQuickSelect || null"
                :plugins="pluginsWithHttpRoot"
                value-key="baseUrl"
                :placeholder="$t('surf.placeholderPlugin')"
                size="large"
                class="surf-plugin-select"
                @update:model-value="onPluginQuickSelect"
              />
            </template>

            <template #append>
              <el-button
                class="surf-go-btn"
                type="primary"
                circle
                :disabled="!inputUrl.trim()"
                :title="$t('surf.startSurf')"
                @click="handleStart"
              >
                <el-icon><Right /></el-icon>
              </el-button>
            </template>

            <template #default="{ item }">
              <div class="surf-suggest-item">
                <span class="surf-suggest-icon">
                  <img v-if="item.icon" :src="item.icon" alt="" />
                  <span v-else-if="item.kind === 'plugin'" class="letter">{{ item.letter }}</span>
                  <el-icon v-else-if="item.kind === 'history'"><Clock /></el-icon>
                  <el-icon v-else><Link /></el-icon>
                </span>
                <span class="surf-suggest-label">{{ item.pre }}<b>{{ item.hit }}</b>{{ item.post }}</span>
                <span class="surf-suggest-meta">{{ item.meta }}</span>
              </div>
            </template>
          </el-autocomplete>
        </div>

        <!-- 畅游记录列表 -->
        <div class="surf-list-wrap" @wheel="onListWheel">
          <transition-group name="surf-list" tag="div" class="surf-list">
            <el-card
              v-for="record in surfStore.records"
              :key="record.id"
              :class="['surf-card', appBackgroundCardClass]"
              @click="goImages(record.host)"
              @contextmenu.prevent="openRecordContextMenu($event, record)"
            >
              <div class="card-head">
                <img v-if="iconDataUrl(record.icon)" class="site-icon" :src="iconDataUrl(record.icon)" alt="icon" />
                <div v-else class="site-icon fallback">{{ record.host[0]?.toUpperCase() }}</div>
                <div class="site-meta">
                  <div class="host">{{ record.name || record.host }}</div>
                  <div class="root-url">{{ record.rootUrl }}</div>
                </div>
                <div class="surf-card-tags">
                  <el-tag size="small" type="info">{{ $t('surf.imageCount') }} {{ surfCounts.countOf(record.host) }}</el-tag>
                </div>
              </div>
              <div class="card-foot">
                <span :title="formatAbsolute(record.lastVisitAt)">
                  {{ $t('surf.lastVisit') }}{{ formatRelative(record.lastVisitAt) }}
                </span>
                  <div class="card-actions">
                    <el-button
                      size="small"
                      type="primary"
                      @click.stop="handleRecordClick(record)"
                    >
                      {{ isActiveSurf(record) ? $t('surf.openSurf') : $t('surf.startSurf') }}
                    </el-button>
                    <el-button v-if="isActiveSurf(record)" size="small" type="danger" @click.stop="handleCloseSurf(record)">
                      {{ $t('surf.closeSurf') }}
                    </el-button>
                    <el-button size="small" @click.stop="openDetailDialog(record)">
                      {{ $t('surf.recordDetails') }}
                    </el-button>
                  </div>
              </div>
            </el-card>
          </transition-group>
        </div>
      </div>
    </div>

    <ActionRenderer
      :visible="recordMenu.visible.value"
      :position="recordMenu.position.value"
      :actions="(surfRecordActions as import('@kabegame/core/actions/types').ActionItem<unknown>[])"
      :context="recordMenuContext"
      :z-index="recordMenu.zIndex.value"
      @close="recordMenu.hide"
      @command="(cmd) => handleRecordMenuCommand(cmd as 'viewImages' | 'details' | 'delete')"
    />

    <ElDialog
      :model-value="detailDialog.isOpen.value"
      :z-index="detailDialog.zIndex.value"
      :title="detailRecord?.name || detailRecord?.host || $t('surf.recordDetails')"
      width="600px"
      class="surf-detail-dialog"
      @update:model-value="detailDialog.close"
      @closed="resetDetailDialog"
    >
      <div v-if="detailRecord" class="surf-detail-content">
        <div class="detail-item">
          <span class="detail-label">{{ $t("surf.recordName") }}</span>
          <el-input
            v-model="detailName"
            :placeholder="$t('surf.recordNamePlaceholder')"
            size="default"
            class="detail-input"
            @blur="saveDetailName"
          />
        </div>
        <div class="detail-item">
          <span class="detail-label">{{ $t("surf.entryPath") }}</span>
          <div class="detail-value-wrap">
            <el-input
              v-model="detailEntryPath"
              :placeholder="$t('surf.entryPathPlaceholder')"
              size="default"
              class="detail-input"
              @blur="saveDetailEntryPath"
            />
            <div class="detail-url-preview">{{ detailFullUrlPreview }}</div>
          </div>
        </div>
        <div class="detail-item detail-stats">
          <span class="detail-label">{{ $t("surf.lastVisitLabel") }}</span>
          <span class="detail-stat-value">{{ formatAbsolute(detailRecord.lastVisitAt) }}</span>
        </div>
        <div class="detail-item">
          <span class="detail-label">{{ $t("surf.cookieLabel") }}</span>
          <el-input
            :model-value="detailRecord?.cookie || ''"
            type="textarea"
            :rows="5"
            readonly
            :placeholder="$t('surf.cookieEmpty')"
            class="detail-textarea"
          />
        </div>
      </div>

      <template #footer>
        <div class="surf-detail-footer">
          <el-button type="danger" @click="deleteRecordFromDetail">
            {{ $t("surf.deleteRecordDanger") }}
          </el-button>
          <div class="surf-detail-footer-right">
            <el-button @click="detailDialog.close()">{{ $t("common.close") }}</el-button>
            <el-button type="primary" :disabled="!(detailRecord?.cookie || '').trim()" @click="copyDetailCookie">
              {{ detailCopyDone ? $t("surf.copied") : $t("surf.copy") }}
            </el-button>
          </div>
        </div>
      </template>
    </ElDialog>

    <ElDialog
      :model-value="helpDialog.isOpen.value"
      :z-index="helpDialog.zIndex.value"
      :title="$t('surf.surfHelpTitle')"
      width="420px"
      class="surf-help-dialog"
      @update:model-value="helpDialog.close"
    >
      <p class="surf-help-p">
        {{ $t('surf.surfHelpIntro') }}
      </p>
      <p class="surf-help-p">
        {{ $t('surf.surfHelpRecord') }}
      </p>
      <p v-if="IS_LINUX" class="surf-help-p surf-help-linux">
        {{ $t('surf.linuxHintHelp') }}
      </p>
      <template #footer>
        <el-button type="primary" @click="helpDialog.close()">{{ $t('surf.gotIt') }}</el-button>
      </template>
    </ElDialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, computed, watch } from "vue";
import { useRouter } from "vue-router";
import { ElMessageBox } from "@kabegame/element-plus";
import { kameMessage as ElMessage } from "@kabegame/core/utils/kameMessage";
import { ElDialog } from "@kabegame/element-plus";
import { QuestionFilled, Right, Clock, Link } from "@kabegame/element-plus-icons";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import { useModal } from "@kabegame/core/composables/useModal";
import { HeaderFeatureId } from "@kabegame/core/stores/header";
import { IS_LINUX } from "@kabegame/core/env";
import { useSurfStore, type SurfRecord } from "@/stores/surf";
import { useSurfImageCountsStore } from "@/stores/surfImageCounts";
import { useGlobalPathRoute } from "@/stores/pathRoute";
import { usePluginStore } from "@/stores/plugins";
import { useI18n } from "@kabegame/i18n";
import { useActionMenu } from "@kabegame/core/composables/useActionMenu";
import ActionRenderer from "@kabegame/core/components/ActionRenderer.vue";
import { createSurfRecordActions } from "@/actions/surfRecordActions";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import PluginPickerField from "@/components/PluginPickerField.vue";
import {
  useImagesChangeRefresh,
  type ImagesChangePayload,
} from "@/composables/useImagesChangeRefresh";
import {
  formatAbsoluteTime,
  formatRelativeTime,
} from "@kabegame/core/utils/relativeTime";

const { t } = useI18n();
const router = useRouter();
const surfStore = useSurfStore();
const surfCounts = useSurfImageCountsStore();
const globalRoute = useGlobalPathRoute();
const pluginStore = usePluginStore();
const settingsStore = useSettingsStore();
const appBackgroundCardClass = computed(() =>
  settingsStore.values.appBackgroundEnabled
    ? "!bg-transparent [--el-card-bg-color:transparent]"
    : ""
);
const surfHeaderShowIds = computed(() => [HeaderFeatureId.TaskDrawer]);

const helpDialog = useModal();
const detailDialog = useModal();
const detailRecord = ref<SurfRecord | null>(null);
const detailName = ref("");
const detailEntryPath = ref("/");
const detailCopyDone = ref(false);

const inputUrl = ref("");
const pluginQuickSelect = ref("");

/** el-autocomplete 实例；用它暴露的 activated/suggestions/highlightedIndex 判断面板真实状态 */
const autocompleteRef = ref<any>(null);
/** 面板真的展开（有内容）时才让胶囊下缘变直角，否则会出现「方角接空气」 */
const suggestOpen = computed(() => {
  const ac = autocompleteRef.value;
  return !!ac?.activated && (ac?.suggestions?.length ?? 0) > 0;
});

type SurfSuggestion = {
  kind: "plugin" | "history" | "url";
  /** 选中后填入输入框的值（el-autocomplete 默认 value-key = "value"） */
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
  pluginStore.plugins.filter((p) => p.baseUrl && p.baseUrl.toLowerCase().startsWith("http"))
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
      ElMessage.warning(result.error);
      return;
    }
    const normalized = result.url;
    await surfStore.startSession(normalized);
    ElMessage.success(t("surf.sessionStartSuccess"));
  } catch (e: any) {
    ElMessage.error(e?.message || String(e) || t("surf.sessionStartFailed"));
  }
};

/**
 * 建议列表：只消费已有数据源（pluginsWithHttpRoot、surfStore.records），不新增接口。
 * 空输入 → 只出历史；有输入 → 插件 / 历史 / 直接打开三类混排。
 */
const fetchSuggestions = (
  queryString: string,
  cb: (data: SurfSuggestion[]) => void
) => {
  const q = (queryString || "").trim();
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

  // ③ 直接打开 —— 复用已有的 normalizeAndValidateUrl，跟上面不重复才加
  if (lower && !out.some((s) => s.value.toLowerCase() === lower)) {
    const direct = normalizeAndValidateUrl(q);
    if ("url" in direct) {
      out.push({
        kind: "url",
        value: direct.url,
        ...highlight(direct.url, q),
        meta: t("surf.suggestOpen"),
      });
    }
  }

  cb(out.slice(0, 8));
};

/** EP 在 keydown 阶段就处理了 Enter 选中；标记一下，避免我们的 Enter 处理重复起会话 */
let selectGuard = false;

const onSuggestionSelect = async (item: Record<string, any>) => {
  const s = item as SurfSuggestion;
  selectGuard = true;
  setTimeout(() => (selectGuard = false), 0);
  inputUrl.value = s.value;
  // 历史记录走 handleRecordClick（它带上记录自己的 rootUrl 语义）
  if (s.kind === "history" && s.host) {
    const record = surfStore.records.find((r) => r.host === s.host);
    if (record) return handleRecordClick(record);
  }
  await handleStart();
};

/**
 * Enter：若面板里已有高亮项，交给 el-autocomplete 走 select（-> onSuggestionSelect），
 * 我们不再重复起一次会话；否则按输入框里的原文开始畅游。
 */
const onEnterKey = () => {
  const highlighted = autocompleteRef.value?.highlightedIndex;
  if (selectGuard || (typeof highlighted === "number" && highlighted >= 0)) return;
  void handleStart();
};

async function openDetailDialog(record: SurfRecord) {
  try {
    const latest = await surfStore.getRecord(record.host);
    const target = latest ?? record;
    detailRecord.value = target;
    detailName.value = target.name || "";
    detailEntryPath.value = extractEntryPath(target);
    detailCopyDone.value = false;
    detailDialog.open();
  } catch (e: any) {
    ElMessage.error(e?.message || String(e) || t("surf.operationFailed"));
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
    ElMessage.success(t("surf.savedSuccess"));
  } catch (e: any) {
    ElMessage.error(e?.message || String(e) || t("surf.operationFailed"));
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
    ElMessage.success(t("surf.savedSuccess"));
  } catch (e: any) {
    ElMessage.error(e?.message || String(e) || t("surf.operationFailed"));
  }
}

async function copyDetailCookie() {
  const cookie = (detailRecord.value?.cookie || "").trim();
  if (!cookie) return;
  try {
    await navigator.clipboard.writeText(cookie);
    detailCopyDone.value = true;
    ElMessage.success(t("surf.copySuccess"));
  } catch {
    ElMessage.error(t("common.copyFailed"));
  }
}

async function confirmAndDeleteRecord(record: SurfRecord) {
  await ElMessageBox.confirm(
    t("surf.deleteRecordConfirm", { host: record.host }),
    t("surf.deleteRecordTitle"),
    { confirmButtonText: t("surf.deleteButton"), cancelButtonText: t("common.cancel"), type: "warning" }
  );
  await surfStore.deleteRecord(record.host);
  ElMessage.success(t("surf.deleteSuccess"));
}

async function deleteRecordFromDetail() {
  const record = detailRecord.value;
  if (!record) return;
  try {
    await confirmAndDeleteRecord(record);
    detailDialog.close();
  } catch (e: any) {
    if (e !== "cancel") {
      ElMessage.error(e?.message || String(e) || t("surf.deleteFailed"));
    }
  }
}

const handleRecordClick = async (record: SurfRecord) => {
  try {
    inputUrl.value = record.rootUrl;
    await surfStore.startSession(record.rootUrl);
    ElMessage.success(t("surf.sessionStartSuccess"));
  } catch (e: any) {
    ElMessage.error(e?.message || String(e) || t("surf.sessionStartFailed"));
  }
};

const isActiveSurf = (record: SurfRecord) =>
  surfStore.sessionActive && surfStore.activeHost === record.host;

const handleCloseSurf = async (record: SurfRecord) => {
  try {
    await surfStore.closeSession(record.host);
    ElMessage.success(t("surf.sessionClosed"));
  } catch (e: any) {
    ElMessage.error(e?.message || String(e) || t("surf.operationFailed"));
  }
};

const goImages = (host: string) => {
  router.push(`/surf/${host}/images`);
};

const openRecordContextMenu = (e: MouseEvent, record: SurfRecord) => {
  recordMenu.show(record, e);
};

const handleRecordMenuCommand = async (command: "viewImages" | "details" | "delete") => {
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
  if (command === "delete") {
    try {
      await confirmAndDeleteRecord(record);
    } catch (e: any) {
      if (e !== "cancel") {
        ElMessage.error(e?.message || String(e) || t("surf.deleteFailed"));
      }
    }
  }
};

const allSurfHosts = () => surfStore.records.map((record) => record.host);

useImagesChangeRefresh({
  enabled: ref(true),
  onRefresh: async (payload: ImagesChangePayload) => {
    const recordIds = (payload.surfRecordIds ?? [])
      .map((id) => String(id).trim())
      .filter(Boolean);
    if (recordIds.length === 0) {
      await surfCounts.refreshAll(allSurfHosts());
      return;
    }
    const hosts = recordIds
      .map((id) => surfStore.hostById(id))
      .filter((host): host is string => !!host);
    await surfCounts.refreshSome(hosts);
  },
});

watch(
  () => globalRoute.hide,
  () => void surfCounts.refreshAll(allSurfHosts()),
);

// 记录集合变化（含 init 首次灌入、后续增删）即重算。immediate 覆盖「store 已被别处
// 初始化过、length 不再变化」的情况；此时 init() 不触发第二次，不会打两轮全量 count。
watch(
  () => surfStore.orderedIds.length,
  () => void surfCounts.refreshAll(allSurfHosts()),
  { immediate: true },
);

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
  display: flex;
  align-items: center;
  width: 100%;
  max-width: 640px;
  margin: 0 auto;
  flex-shrink: 0;

  .surf-content.has-records & {
    margin-bottom: 16px;
  }

  > .el-autocomplete {
    flex: 1;
    min-width: 0;
  }

  /* ── 一颗胶囊：外壳只画在最外层 .el-input 上 ── */
  :deep(.el-input) {
    height: 56px;
    border-radius: 28px;
    background: var(--el-fill-color-blank, #fff);
    border: 1px solid rgba(74, 21, 75, 0.08);
    box-shadow: 0 1px 4px rgba(74, 21, 75, 0.06);
    overflow: hidden;
    transition: box-shadow 0.18s ease, border-color 0.18s ease,
      border-radius 0.18s ease;

    &:hover {
      box-shadow: 0 3px 12px rgba(74, 21, 75, 0.1);
    }

    /* 聚焦：边框让位给阴影，粉色不上边框 */
    &:focus-within {
      border-color: transparent;
      box-shadow: 0 6px 22px rgba(74, 21, 75, 0.14);
    }
  }

  /* 内层三段一律抹平：EP 默认给 wrapper / prepend / append 各自一圈 box-shadow 边框 */
  :deep(.el-input__wrapper) {
    box-shadow: none !important;
    background: transparent;
    padding: 0 4px;
  }

  :deep(.el-input-group__prepend),
  :deep(.el-input-group__append) {
    background: transparent;
    border: none;
    box-shadow: none !important;
    color: inherit;
  }

  /* 左端：插件选择器 + 一根 1px 竖分隔线（唯一的内部分界）
     PluginPickerField 在 select 外多包了一层 div，EP 为“裸 select 直放 prepend”
     准备的 padding(0 20px) + 负 margin(-20px) 抵消不再成立，统一归零 */
  :deep(.el-input-group__prepend) {
    position: relative;
    padding: 0 0 0 16px;

    .el-select {
      margin: 0;
      width: 100%;
    }

    /* EP 还会给 prepend 内的 select wrapper 单独描一圈 inset 边框，一并抹掉 */
    .el-select__wrapper {
      box-shadow: none !important;
      background: transparent;
    }

    &::after {
      content: "";
      position: absolute;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      width: 1px;
      height: 24px;
      background: rgba(74, 21, 75, 0.1);
    }
  }

  .surf-plugin-select {
    width: 150px;
  }

  /* 右端：圆形主按钮，渐变只出现在这一处。
     选择器要比 EP 的 `.el-input-group__append button.el-button` 更具体，
     否则 flex:1 / margin:-20px / 透明底色会把按钮打回原形 */
  :deep(.el-input-group__append) {
    padding: 0 8px 0 0;

    .surf-go-btn {
      flex: none;
      display: inline-flex;
      width: 40px;
      height: 40px;
      margin: 0;
      border: none;
      background: linear-gradient(135deg, var(--anime-primary) 0%, var(--anime-secondary) 100%);
      box-shadow: 0 2px 10px rgba(255, 107, 157, 0.35);
      color: #fff;
      transition: transform 0.15s ease, opacity 0.15s ease;

      &:hover:not(.is-disabled) {
        transform: scale(1.06);
      }

      &.is-disabled {
        opacity: 0.4;
        box-shadow: none;
      }
    }
  }

  /* 面板展开：胶囊下缘变直角，和面板连成一块（Google 的做法） */
  &.is-open :deep(.el-input) {
    border-radius: 28px 28px 0 0;
    border-color: transparent;
    box-shadow: 0 8px 30px rgba(74, 21, 75, 0.18);
  }
}

/* 建议项 —— popper 虽被 teleport 到 body，但插槽内容写在本文件模板里，
   编译期就带上了本组件的 scope id，scoped 依然生效 */
.surf-suggest-item {
  display: flex;
  align-items: center;
  gap: 13px;
  width: 100%;

  .surf-suggest-icon {
    flex: none;
    width: 18px;
    height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--el-text-color-placeholder);

    img {
      width: 100%;
      height: 100%;
      border-radius: 4px;
      object-fit: cover;
    }

    .letter {
      width: 100%;
      height: 100%;
      border-radius: 4px;
      background: var(--anime-primary);
      color: #fff;
      font-size: 10px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
    }
  }

  .surf-suggest-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--el-text-color-primary);

    b {
      font-weight: 700;
    }
  }

  .surf-suggest-meta {
    margin-left: auto;
    flex: none;
    padding-left: 12px;
    font-size: 12px;
    color: var(--el-text-color-placeholder);
  }
}

.surf-linux-tip {
  width: 100%;
  margin-top: 12px;
  margin-bottom: 4px;

  .surf-content.has-records & {
    margin-bottom: 12px;
  }
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
  gap: 12px;
}

.surf-card {
  cursor: pointer;
}

.card-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.site-icon {
  width: 24px;
  height: 24px;
  border-radius: 6px;
}

.site-icon.fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  background: #ddd;
  font-size: 12px;
}

.site-meta {
  flex: 1;
  min-width: 0;
}

.host {
  font-weight: 600;
}

.root-url {
  color: #888;
  font-size: 12px;
  word-break: break-all;
}

.surf-card-tags {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  flex-shrink: 0;
}

.card-foot {
  margin-top: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: #888;
  font-size: 12px;
  gap: 8px;
}

.card-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.load-more {
  margin-top: 16px;
  text-align: center;
  width: 92%;
}

/* 列表进入/离开/重排动画 */
.surf-list-enter-active,
.surf-list-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
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

.surf-help-dialog .surf-help-p {
  margin: 0 0 12px;
  line-height: 1.6;
  color: var(--el-text-color-regular);
}
.surf-help-dialog .surf-help-p:last-of-type {
  margin-bottom: 0;
}
.surf-help-dialog .surf-help-linux {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.surf-cookie-dialog .surf-cookie-host {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.surf-cookie-dialog .surf-cookie-tip {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  line-height: 1.5;
}
.surf-cookie-dialog .surf-cookie-textarea {
  font-family: ui-monospace, monospace;
  font-size: 12px;
}

.surf-detail-content {
  display: flex;
  flex-direction: column;
  gap: 16px;

  .detail-item {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }

  .detail-label {
    font-weight: 500;
    color: var(--anime-text-secondary);
    min-width: 80px;
    flex-shrink: 0;
  }

  .detail-value-wrap {
    flex: 1;
    min-width: 0;
  }

  .detail-input {
    width: 100%;
  }

  .detail-url-preview {
    margin-top: 6px;
    font-size: 12px;
    color: var(--anime-text-secondary);
    word-break: break-all;
  }

  .detail-textarea {
    flex: 1;
    min-width: 0;
    font-family: ui-monospace, monospace;
    font-size: 12px;
  }

  .detail-stats {
    align-items: center;
  }

  .detail-stat-value {
    flex: 1;
    min-width: 0;
    font-variant-numeric: tabular-nums;
  }
}

.surf-detail-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.surf-detail-footer-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>

<style lang="scss">
/* popper 挂在 body 上，容器本身到不了 scoped，用 popper-class 限定作用域。
   el-autocomplete 不透传 offset/popper-options，ElTooltip 默认 offset=12，
   这里用负 margin 把面板贴回胶囊下缘（popper 用 top/left 定位，margin 生效）。 */
.surf-suggest-popper.el-popper {
  margin-top: -12px;
  border: none !important;
  border-radius: 0 0 20px 20px !important;
  background: var(--el-fill-color-blank, #fff) !important;
  box-shadow: 0 8px 30px rgba(74, 21, 75, 0.18) !important;
  padding: 8px 0 10px !important;
  overflow: hidden;

  .el-popper__arrow {
    display: none !important;
  }

  /* 建议最多 8 条，max-height 取 8 × 44px，避免 EP 默认 280px 在末尾裁出半行 */
  .el-autocomplete-suggestion__wrap {
    padding: 0;
    max-height: 352px;
  }

  .el-autocomplete-suggestion__list li {
    height: 44px;
    line-height: 44px;
    padding: 0 22px;

    &.highlighted,
    &:hover {
      background: rgba(255, 107, 157, 0.07);
    }
  }
}
</style>
