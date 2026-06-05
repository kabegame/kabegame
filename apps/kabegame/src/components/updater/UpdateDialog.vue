<template>
  <el-dialog
    :model-value="store.dialogOpen"
    :z-index="modal.zIndex.value"
    :title="t('updater.dialogTitle')"
    width="640px"
    append-to-body
    class="update-dialog"
    @update:model-value="modal.close"
  >
    <el-tabs v-if="releases.length" v-model="activeTab" type="card" class="update-tabs">
      <el-tab-pane v-for="r in releases" :key="r.tag" :name="r.tag" :label="r.tag">
        <div class="changelog" v-html="renderedBody(r)" @click="onBodyClick"></div>
      </el-tab-pane>
    </el-tabs>

    <template #footer>
      <div class="update-footer">
        <span v-if="store.lastDownloadError" class="download-error">{{ store.lastDownloadError }}</span>
        <span v-else-if="showNoAssetHint" class="no-asset-hint">{{ t('updater.noAssetHint') }}</span>
        <span class="footer-actions">
          <el-button text @click="active && openRelease(active)">{{ t('updater.viewOnGithub') }}</el-button>
          <el-button
            v-if="active && canDownload(active)"
            type="primary"
            :loading="store.busy"
            @click="onDownload(active)"
          >
            {{ t('updater.download') }}
          </el-button>
          <el-button v-else type="primary" @click="active && openRelease(active)">
            {{ t('updater.openReleasePage') }}
          </el-button>
        </span>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElButton, ElDialog, ElTabPane, ElTabs } from "element-plus";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useI18n } from "@kabegame/i18n";
import { IS_LINUX } from "@kabegame/core/env";
import { useModal } from "@kabegame/core/composables/useModal";
import { renderBasicMarkdown } from "@kabegame/core/utils/renderMarkdown";
import * as updaterService from "@/services/updater";
import { useUpdaterStore, type ReleaseInfo } from "@/stores/updater";

const { t } = useI18n();
const store = useUpdaterStore();

const modal = useModal({ onClose: () => store.closeDialog() });
watch(() => store.dialogOpen, (v) => v ? modal.open() : modal.close(), { immediate: true });

const releases = computed(() => store.releases);
const activeTab = ref("");

// 打开时 / 列表变化时，默认选中最新（第一个）版本
watch(
  [() => store.dialogOpen, releases],
  ([open, list]: [boolean, ReleaseInfo[]]) => {
    if (open && list.length && !list.some((r) => r.tag === activeTab.value)) {
      activeTab.value = list[0].tag;
    }
  },
  { immediate: true },
);

const active = computed(
  () => releases.value.find((r) => r.tag === activeTab.value) ?? releases.value[0] ?? null,
);

// changelog 渲染缓存：按 tag 缓存，但 body 变化（如发布后编辑了 release notes）时失效重渲染
const bodyCache = new Map<string, { body: string; html: string }>();
function renderedBody(r: ReleaseInfo): string {
  const cached = bodyCache.get(r.tag);
  if (cached && cached.body === r.body) return cached.html;
  const html = renderBasicMarkdown(r.body);
  bodyCache.set(r.tag, { body: r.body, html });
  return html;
}

/** Linux 恒不可下载；mac/win 看 asset 是否命中（决策 D1）。 */
function canDownload(r: ReleaseInfo): boolean {
  return !IS_LINUX && !!r.assetUrl;
}

// mac/win 上未匹配到安装包时提示去发布页；Linux 本就无下载，不提示
const showNoAssetHint = computed(() => !IS_LINUX && !!active.value && !active.value.assetUrl);

async function openRelease(r: ReleaseInfo) {
  try {
    await openUrl(r.htmlUrl);
  } catch (e) {
    console.warn("[updater] openUrl failed:", e);
  }
}

async function onDownload(r: ReleaseInfo) {
  // 关闭 changelog 弹窗，由 DownloadProgressDialog 接管进度展示
  store.closeDialog();
  try {
    await updaterService.downloadAndStage(r);
  } catch (e) {
    // 错误已由后端 update-download-error 事件 + kameMessage 反馈；这里仅兜底日志
    console.warn("[updater] download failed:", e);
  }
}

// 拦截 changelog 正文里的链接点击，统一走 opener（webview 内 target=_blank 不可靠）
function onBodyClick(e: MouseEvent) {
  const anchor = (e.target as HTMLElement).closest("a");
  if (!anchor) return;
  const href = anchor.getAttribute("href");
  if (!href) return;
  e.preventDefault();
  void openUrl(href).catch((err) => console.warn("[updater] openUrl failed:", err));
}
</script>

<style scoped lang="scss">
.update-tabs {
  :deep(.el-tabs__header) {
    margin-bottom: 12px;
  }
}

.changelog {
  max-height: 50vh;
  overflow-y: auto;
  font-size: 14px;
  line-height: 1.6;
  color: var(--anime-text-primary);
  word-break: break-word;

  :deep(h1),
  :deep(h2),
  :deep(h3) {
    font-size: 16px;
    font-weight: 600;
    margin: 12px 0 6px;
  }

  :deep(ul),
  :deep(ol) {
    padding-left: 20px;
    margin: 6px 0;
  }

  :deep(a) {
    color: var(--anime-primary);
    cursor: pointer;
  }

  :deep(code) {
    background: rgba(167, 139, 250, 0.12);
    padding: 1px 5px;
    border-radius: 4px;
  }

  :deep(pre) {
    background: rgba(0, 0, 0, 0.05);
    padding: 10px;
    border-radius: 8px;
    overflow-x: auto;
  }

  :deep(img) {
    max-width: 100% !important;
    height: auto;
  }
}

.update-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;

  .no-asset-hint {
    font-size: 12px;
    color: var(--anime-text-secondary);
    text-align: left;
    flex: 1;
  }

  .download-error {
    font-size: 12px;
    color: var(--el-color-danger);
    text-align: left;
    flex: 1;
    word-break: break-word;
  }

  .footer-actions {
    margin-left: auto;
    flex-shrink: 0;
  }
}
</style>
