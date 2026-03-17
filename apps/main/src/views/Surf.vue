<template>
  <div class="surf-page">
    <div class="surf-scroll-container" :class="{ 'has-records': hasRecords }">
      <PageHeader
        :title="$t('surf.title')"
        :show="surfHeaderShowIds"
        sticky
        @action="handleSurfHeaderAction"
      />

      <div class="surf-content" :class="{ 'has-records': hasRecords }">
        <!-- Logo：搜索栏上方 -->
        <div class="surf-logo">
          <img
            src="/swim.jpeg"
            :alt="$t('surf.title')"
            class="surf-logo-img"
            :style="hasRecords ? { height: logoHeight + 'px' } : undefined"
          />
        </div>
        <!-- 输入区 -->
        <div class="surf-search-row">
          <el-select
            v-model="pluginQuickSelect"
            :placeholder="$t('surf.placeholderPlugin')"
            size="large"
            filterable
            :disabled="surfStore.sessionActive"
            class="surf-plugin-select"
            @change="onPluginQuickSelect"
          >
            <el-option
              v-for="p in pluginsWithHttpRoot"
              :key="p.id"
              :label="pluginName(p)"
              :value="p.baseUrl"
            />
          </el-select>
          <el-input
            v-model="inputUrl"
            :placeholder="$t('surf.placeholderUrl')"
            :disabled="surfStore.sessionActive"
            size="large"
            @keyup.enter="handleStart"
          />
          <el-button type="primary" size="large" @click="handleStart">
            {{ surfStore.sessionActive ? $t('surf.openSession') : $t('surf.startSurf') }}
          </el-button>
          <el-button v-if="surfStore.sessionActive" size="large" @click="handleCloseSession">
            {{ $t('surf.endSession') }}
          </el-button>
          <el-button
            v-if="surfStore.sessionActive"
            size="large"
            :loading="cookieLoading"
            @click="handleViewCookies"
          >
            {{ $t('surf.viewCookie') }}
          </el-button>
        </div>

        <el-alert
          v-if="IS_LINUX"
          type="info"
          :closable="false"
          show-icon
          class="surf-linux-tip"
        >
          {{ $t('surf.linuxHint') }}
        </el-alert>

        <!-- 畅游记录列表 -->
        <div class="surf-list-wrap" @wheel="onListWheel">
          <transition-group name="surf-list" tag="div" class="surf-list">
            <el-card
              v-for="record in surfStore.records"
              :key="record.id"
              class="surf-card"
              @click="handleRecordClick(record)"
              @contextmenu.prevent="openRecordContextMenu($event, record)"
            >
              <div class="card-head">
                <img v-if="iconDataUrl(record.icon)" class="site-icon" :src="iconDataUrl(record.icon)" alt="icon" />
                <div v-else class="site-icon fallback">{{ record.host[0]?.toUpperCase() }}</div>
                <div class="site-meta">
                  <div class="host">{{ record.host }}</div>
                  <div class="root-url">{{ record.rootUrl }}</div>
                </div>
                <el-tag size="small" type="info">{{ $t('surf.downloadCount') }} {{ record.downloadCount }}</el-tag>
              </div>
              <div class="card-foot">
                <span>{{ $t('surf.lastVisit') }}{{ formatTime(record.lastVisitAt) }}</span>
                <span v-if="record.lastImage" class="last-image" @click.stop="goImages(record.id)">
                  {{ $t('surf.viewRecentImages') }}
                </span>
              </div>
            </el-card>
          </transition-group>
          <div class="load-more">
            <el-button v-if="surfStore.hasMore" :loading="surfStore.loading" @click="surfStore.loadMore()">
              {{ $t('surf.loadMore') }}
            </el-button>
          </div>
        </div>
      </div>
    </div>

    <ActionRenderer
      :visible="recordMenu.visible.value"
      :position="recordMenu.position.value"
      :actions="(surfRecordActions as import('@kabegame/core/actions/types').ActionItem<unknown>[])"
      :context="recordMenuContext"
      :z-index="3500"
      @close="recordMenu.hide"
      @command="(cmd) => handleRecordMenuCommand(cmd as 'viewImages' | 'delete')"
    />

    <ElDialog
      v-model="cookieDialogVisible"
      :title="$t('surf.cookieDialogTitle')"
      width="560px"
      class="surf-cookie-dialog"
      @closed="cookieString = ''"
    >
      <p v-if="cookieHost" class="surf-cookie-host">{{ $t('surf.site') }}{{ cookieHost }}</p>
      <p class="surf-cookie-tip">{{ $t('surf.cookieTip') }}</p>
      <el-input
        v-model="cookieString"
        type="textarea"
        :rows="8"
        readonly
        :placeholder="$t('surf.noCookie')"
        class="surf-cookie-textarea"
      />
      <template #footer>
        <el-button @click="cookieDialogVisible = false">{{ $t('common.close') }}</el-button>
        <el-button type="primary" :disabled="!cookieString" @click="copyCookie">
          {{ copyDone ? $t('surf.copied') : $t('surf.copy') }}
        </el-button>
      </template>
    </ElDialog>

    <ElDialog
      v-model="surfHelpVisible"
      :title="$t('surf.surfHelpTitle')"
      width="420px"
      class="surf-help-dialog"
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
        <el-button type="primary" @click="surfHelpVisible = false">{{ $t('surf.gotIt') }}</el-button>
      </template>
    </ElDialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import { useRouter } from "vue-router";
import { invoke } from "@tauri-apps/api/core";
import { ElMessage, ElMessageBox } from "element-plus";
import { ElDialog } from "element-plus";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import { useModalBack } from "@kabegame/core/composables/useModalBack";
import { HeaderFeatureId } from "@kabegame/core/stores/header";
import { IS_ANDROID, IS_LINUX } from "@kabegame/core/env";
import { useSurfStore, type SurfRecord } from "@/stores/surf";
import { usePluginStore } from "@/stores/plugins";
import { usePluginManifestI18n } from "@/composables/usePluginManifestI18n";
import { useActionMenu } from "@kabegame/core/composables/useActionMenu";
import ActionRenderer from "@kabegame/core/components/ActionRenderer.vue";
import { createSurfRecordActions } from "@/actions/surfRecordActions";
import { useI18n } from "vue-i18n";

const { t } = useI18n();
const router = useRouter();
const surfStore = useSurfStore();
const pluginStore = usePluginStore();
const { pluginName } = usePluginManifestI18n();
const surfHeaderShowIds = computed(() =>
  IS_ANDROID ? [HeaderFeatureId.Help] : [HeaderFeatureId.Help, HeaderFeatureId.OpenCrawlerWebview]
);

const surfHelpVisible = ref(false);
useModalBack(surfHelpVisible);

const cookieDialogVisible = ref(false);
useModalBack(cookieDialogVisible);
const cookieString = ref("");
const cookieHost = ref<string | null>(null);
const cookieLoading = ref(false);
const copyDone = ref(false);

const inputUrl = ref("");
const pluginQuickSelect = ref("");
const crawlerWebviewOpening = ref(false);

async function openCrawlerWindow() {
  crawlerWebviewOpening.value = true;
  try {
    await invoke("show_crawler_window");
    ElMessage.success(t("surf.openWebViewSuccess"));
  } catch (e) {
    ElMessage.error(String(e));
  } finally {
    crawlerWebviewOpening.value = false;
  }
}

function handleSurfHeaderAction(payload: { id: string; data: { type: string } }) {
  if (payload.id === HeaderFeatureId.Help) surfHelpVisible.value = true;
  else if (payload.id === HeaderFeatureId.OpenCrawlerWebview) openCrawlerWindow();
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

const onPluginQuickSelect = (baseUrl: string) => {
  inputUrl.value = baseUrl;
  pluginQuickSelect.value = "";
};


const hasRecords = computed(() => surfStore.records.length > 0);

const LOGO_MAX = 180;
const LOGO_MIN = 80;
const logoHeight = ref(LOGO_MAX);
const logoCollapsed = computed(() => logoHeight.value <= LOGO_MIN);

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

const formatTime = (ts: number) => {
  if (!ts) return "-";
  const date = new Date(ts * 1000);
  return date.toLocaleString();
};

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
    const raw = inputUrl.value || (surfStore.sessionActive ? "https://example.com" : "");
    const result = normalizeAndValidateUrl(raw);
    if ("error" in result) {
      ElMessage.warning(result.error);
      return;
    }
    const normalized = result.url;
    if (surfStore.sessionActive) {
      await surfStore.startSession(normalized);
      return;
    }
    await surfStore.startSession(normalized);
    ElMessage.success(t("surf.sessionStartSuccess"));
  } catch (e: any) {
    ElMessage.error(e?.message || String(e) || t("surf.sessionStartFailed"));
  }
};

const handleCloseSession = async () => {
  try {
    await surfStore.closeSession();
    ElMessage.success(t("surf.sessionEndSuccess"));
  } catch (e: any) {
    ElMessage.error(e?.message || String(e) || t("surf.sessionEndFailed"));
  }
};

async function handleViewCookies() {
  cookieLoading.value = true;
  try {
    const result = await invoke<{ cookieString: string; host?: string | null }>("surf_get_cookies");
    cookieString.value = result.cookieString || "";
    cookieHost.value = result.host ?? null;
    cookieDialogVisible.value = true;
    copyDone.value = false;
  } catch (e: any) {
    ElMessage.error(e?.message || String(e) || t("surf.getCookieFailed"));
  } finally {
    cookieLoading.value = false;
  }
}

async function copyCookie() {
  if (!cookieString.value) return;
  try {
    await navigator.clipboard.writeText(cookieString.value);
    copyDone.value = true;
    ElMessage.success(t("surf.copySuccess"));
  } catch {
    ElMessage.error(t("common.copyFailed"));
  }
}

const handleRecordClick = async (record: SurfRecord) => {
  if (surfStore.sessionActive) return;
  try {
    inputUrl.value = record.rootUrl;
    await surfStore.startSession(record.rootUrl);
  } catch (e: any) {
    ElMessage.error(e?.message || String(e) || t("surf.sessionStartFailed"));
  }
};

const goImages = (id: string) => {
  router.push(`/surf/${id}/images`);
};

const openRecordContextMenu = (e: MouseEvent, record: SurfRecord) => {
  recordMenu.show(record, e);
};

const handleRecordMenuCommand = async (command: "viewImages" | "delete") => {
  const record = recordMenu.context.value.target;
  recordMenu.hide();
  if (!record) return;
  if (command === "viewImages") {
    goImages(record.id);
    return;
  }
  if (command === "delete") {
    try {
      await ElMessageBox.confirm(
        t("surf.deleteRecordConfirm", { host: record.host }),
        t("surf.deleteRecordTitle"),
        { confirmButtonText: t("surf.deleteButton"), cancelButtonText: t("common.cancel"), type: "warning" }
      );
      await surfStore.deleteRecord(record.id);
      ElMessage.success(t("surf.deleteSuccess"));
    } catch (e: any) {
      if (e !== "cancel") {
        ElMessage.error(e?.message || String(e) || t("surf.deleteFailed"));
      }
    }
  }
};

onMounted(async () => {
  await surfStore.checkSession();
  await surfStore.loadRecords();
  if (pluginStore.plugins.length === 0) {
    await pluginStore.loadPlugins();
  }
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
  gap: 10px;
  align-items: center;
  width: 100%;
  flex-shrink: 0;

  .surf-content.has-records & {
    margin-bottom: 16px;
  }

  .surf-plugin-select {
    width: 180px;
    flex-shrink: 0;
  }

  .el-input {
    flex: 1;
    min-width: 0;
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

.card-foot {
  margin-top: 8px;
  display: flex;
  justify-content: space-between;
  color: #888;
  font-size: 12px;
}

.last-image {
  color: var(--el-color-primary);
  cursor: pointer;
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
</style>
