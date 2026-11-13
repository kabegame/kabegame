<template>
  <Dialog v-model:open="open" :title="t('updater.dialogTitle')" :width="640">
    <template v-if="releases.length">
      <Tabs v-model="activeTab" :items="tabItems" class="mb-3 max-w-full" />
      <div v-if="active" class="changelog" v-html="renderedBody(active)" @click="onBodyClick"></div>
    </template>

    <template #footer>
      <div class="flex w-full items-center justify-between gap-3">
        <div class="flex min-w-0 flex-1 flex-col gap-0.5 text-left text-[12px] text-kb-fg-muted">
          <span v-if="store.currentVersion">
            {{ t("updater.currentVersion", { version: store.currentVersion }) }}
          </span>
          <span v-if="store.lastDownloadError" class="break-words text-kb-danger">{{ store.lastDownloadError }}</span>
          <span v-else-if="showNoAssetHint">{{ t("updater.noAssetHint") }}</span>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Button variant="ghost" @click="active && openRelease(active)">
            <ExternalLink />
            {{ t("updater.viewOnGithub") }}
          </Button>
          <Button
            v-if="active && canDownload(active)"
            variant="primary"
            :disabled="store.busy"
            @click="onDownload(active)"
          >
            <Spinner v-if="store.busy" :size="14" />
            <Download v-else />
            {{ t("updater.download") }}
          </Button>
          <Button v-else variant="primary" @click="active && openRelease(active)">
            {{ t("updater.openReleasePage") }}
          </Button>
        </div>
      </div>
    </template>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Download, ExternalLink } from "@lucide/vue";
import { Button, Dialog, Spinner, Tabs, type TabItem } from "@/components/ui";
import { useI18n } from "@kabegame/i18n";
import { IS_LINUX } from "@/env";
import { renderBasicMarkdown } from "@/utils/renderMarkdown";
import { openExternalLink } from "@/utils/openExternalLink";
import * as updaterService from "@/services/updater";
import { useUpdaterStore, type ReleaseInfo } from "@/stores/updater";

const { t } = useI18n();
const store = useUpdaterStore();

// 开合以 store 为准：服务层 / 侧栏按钮打开，对话框里关闭（Esc、遮罩、×、Android 返回）写回 store
const open = computed({
  get: () => store.dialogOpen,
  set: (value: boolean) => (value ? store.openDialog() : store.closeDialog()),
});

const releases = computed(() => store.releases);
const activeTab = ref("");

// 打开时 / 列表变化时，默认选中最新（第一个）版本
watch(
  [() => store.dialogOpen, releases],
  ([isOpen, list]: [boolean, ReleaseInfo[]]) => {
    if (isOpen && list.length && !list.some((r) => r.tag === activeTab.value)) {
      activeTab.value = list[0].tag;
    }
  },
  { immediate: true },
);

const active = computed(() => releases.value.find((r) => r.tag === activeTab.value) ?? releases.value[0] ?? null);

const tabItems = computed<TabItem[]>(() => releases.value.map((r) => ({ name: r.tag, label: r.tag })));

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
    await openExternalLink(r.htmlUrl);
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
  void openExternalLink(href).catch((err) => console.warn("[updater] openUrl failed:", err));
}
</script>

<style scoped>
/* 更新日志是 v-html 渲染的 markdown，元素不在模板里，只能用 :deep 给样式 */
.changelog {
  max-height: 50vh;
  overflow-y: auto;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--kb-fg);
  word-break: break-word;
}

.changelog :deep(h1),
.changelog :deep(h2),
.changelog :deep(h3) {
  font-size: 15px;
  font-weight: 600;
  margin: 12px 0 6px;
}

.changelog :deep(ul),
.changelog :deep(ol) {
  padding-left: 20px;
  margin: 6px 0;
}

.changelog :deep(a) {
  color: var(--kb-accent);
  cursor: pointer;
}

.changelog :deep(code) {
  background: var(--kb-fill);
  padding: 1px 5px;
  border-radius: var(--kb-radius-sm);
  font-size: 12.5px;
}

.changelog :deep(pre) {
  background: var(--kb-fill-light);
  padding: 10px;
  border-radius: var(--kb-radius-md);
  overflow-x: auto;
}

.changelog :deep(pre code) {
  background: transparent;
  padding: 0;
}

.changelog :deep(img) {
  max-width: 100% !important;
  height: auto;
}
</style>
