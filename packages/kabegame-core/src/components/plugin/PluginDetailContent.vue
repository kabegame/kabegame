<template>
  <div v-if="showSkeleton" class="p-10">
    <el-skeleton :rows="5" animated />
  </div>

  <div v-else-if="!loading && !plugin" class="p-10 text-center">
    <el-empty :description="t('common.pluginNotExist')" />
  </div>

  <!-- 桌面：1a 三栏工作台（标题栏由宿主页面的 PageHeader 承载，这里只管主体） -->
  <div v-else-if="plugin && !uiStore.isCompact" class="flex flex-col h-full min-h-0">
    <div
      v-if="plugin.minAppIncompatible"
      class="flex items-center gap-2 py-2 px-4 flex-none border-b border-b-solid border-[var(--anime-border)] text-13.5px"
      style="background: rgba(239, 68, 68, 0.08)"
    >
      <span class="kb-chip text-white whitespace-nowrap" style="background: linear-gradient(135deg, #ef4444 0%, #f87171 100%)">
        {{ t("plugins.detail.requireAppVersion", { version: plugin.minAppVersion }) }}
      </span>
      <span>{{ t("plugins.detail.appVersionBad", { app: appVersionText ?? "?", min: plugin.minAppVersion }) }}</span>
      <div class="flex-1" />
      <a href="#" class="underline whitespace-nowrap" @click.prevent="handleOpenReleaseLink">{{ t("plugins.docReleaseLinkText") }}</a>
    </div>

    <div class="flex items-center gap-3 px-4 pt-2.5 pb-2 flex-none">
      <KbTab v-model="activeTab" :items="tabItems" />
      <div class="flex-1" />
      <a
        v-if="plugin.baseUrl"
        href="#"
        class="text-13.5px underline font-mono whitespace-nowrap text-[var(--anime-text-secondary)]"
        @click.prevent="handleOpenBaseUrl"
      >
        {{ plugin.baseUrl }} ↗
      </a>
    </div>

    <!-- 两侧栏用 flex-none + 自身 width：grid 的 auto 列会按 min/max-content 收缩，
         把 KbResizable clamp 出来的宽度压掉（拖到下限会塌成 0） -->
    <div class="plugin-detail-panes flex-1 min-h-0 flex border-t border-t-solid border-[var(--anime-border)]">
      <PluginDocToc
        v-if="isMarkdownTab && tocOpen"
        v-model:width="menuWidth"
        class="flex-none"
        :headings="activeHeadings"
        :active-id="activeHeadingId"
        :default-width="MENU_DEFAULT_WIDTH"
        @select="handleTocSelect"
        @collapse="tocOpen = false"
      />
      <button
        v-else-if="isMarkdownTab"
        type="button"
        :title="t('plugins.detail.tocExpand')"
        :aria-label="t('plugins.detail.tocExpand')"
        class="flex-none w-26px border-none border-r border-r-solid border-[var(--anime-border)] bg-[color-mix(in_srgb,white_35%,transparent)] text-[var(--anime-text-muted)] flex items-center justify-center cursor-pointer hover:text-[var(--anime-primary)]"
        @click="tocOpen = true"
      >
        <el-icon :size="14"><ArrowRight /></el-icon>
      </button>

      <div class="relative flex-1 min-w-0 min-h-0">
        <div v-show="activeTab === 'doc'" class="absolute inset-0">
          <PluginDocPanel
            ref="docPanelRef"
            show-carousel
            anchor-prefix="kbdoc"
            :reset-token="plugin.id"
            :markdown="displayDoc"
            :assets="plugin.assets ?? null"
            :empty-description="t('common.pluginNoDoc')"
            @headings="docHeadings = $event"
            @image-preview-open="emit('doc-image-preview-open', $event)"
            @image-preview-close="emit('doc-image-preview-close', $event)"
          />
        </div>
        <div v-show="activeTab === 'config'" class="absolute inset-0">
          <PluginConfigPanel
            v-model:menu-width="menuWidth"
            :plugin="plugin"
            :menu-default-width="MENU_DEFAULT_WIDTH"
            @start-task="emit('start-task', $event)"
            @import-all-presets="emit('import-all-presets', $event)"
          />
        </div>
        <div v-show="activeTab === 'pathql'" class="absolute inset-0">
          <PluginProviderPanel
            v-model:menu-width="menuWidth"
            :plugin-id="plugin.id"
            :can-query="canQueryProvider"
            :menu-default-width="MENU_DEFAULT_WIDTH"
            @loaded="pathqlCount = $event"
          />
        </div>
        <div v-if="displayChangelog" v-show="activeTab === 'changelog'" class="absolute inset-0">
          <PluginDocPanel
            ref="changelogPanelRef"
            anchor-prefix="kbchangelog"
            :markdown="displayChangelog"
            :assets="plugin.assets ?? null"
            :empty-description="t('plugins.detail.noChangelog')"
            @headings="changelogHeadings = $event"
            @image-preview-open="emit('doc-image-preview-open', $event)"
            @image-preview-close="emit('doc-image-preview-close', $event)"
          />
        </div>
      </div>

      <PluginSideRail
        v-model:width="railWidth"
        class="flex-none"
        :plugin="plugin"
        :app-version="appVersionText"
        :default-width="RAIL_DEFAULT_WIDTH"
        @start-task="emit('start-task', $event)"
      />
    </div>
  </div>

  <!-- 紧凑端：单列（Android / 窄视口），不做三栏与走马灯。标题栏同样由宿主页面承载 -->
  <div v-else-if="plugin" class="p-4 flex flex-col gap-4 h-full overflow-y-auto [scrollbar-width:none]">
    <div class="flex flex-wrap items-center gap-1.5">
      <span class="kb-chip bg-[#ecf5ff] text-[#409eff]">v{{ plugin.version }}</span>
      <span
        v-if="plugin.minAppVersion"
        class="kb-chip text-white"
        :style="{ background: plugin.minAppIncompatible ? 'linear-gradient(135deg, #ef4444 0%, #f87171 100%)' : 'linear-gradient(135deg, #10b981 0%, #34d399 100%)' }"
      >
        {{ t("plugins.detail.requireAppVersion", { version: plugin.minAppVersion }) }}
      </span>
      <span class="kb-chip" :class="actionState === 'installed' ? 'text-white kb-grad' : 'bg-[#f4f4f5] text-[#909399]'">
        {{ actionState === "installed" ? t("plugins.installed") : t("plugins.notInstalled") }}
      </span>
    </div>

    <div v-if="displayDesc" class="text-14px text-[var(--anime-text-secondary)]">{{ displayDesc }}</div>
    <PluginLabelTags v-if="plugin.labels?.length" :labels="plugin.labels" />
    <a v-if="plugin.baseUrl" href="#" class="text-13.5px underline font-mono break-all" @click.prevent="handleOpenBaseUrl">
      {{ plugin.baseUrl }}
    </a>

    <div>
      <KbTab v-if="displayChangelog" v-model="compactTab" :items="compactTabItems" class="mb-3" />
      <PluginDocRenderer
        v-if="compactDocText"
        :markdown="compactDocText"
        :assets="plugin.assets ?? null"
        :anchor-prefix="compactAnchorPrefix"
        :empty-description="t('common.pluginNoDoc')"
        @image-preview-open="emit('doc-image-preview-open', $event)"
        @image-preview-close="emit('doc-image-preview-close', $event)"
      />
      <el-empty v-else :description="t('common.pluginNoDoc')" :image-size="100" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useLocalStorage, useThrottleFn } from "@vueuse/core";
import { ArrowRight } from "@element-plus/icons-vue";
import { useI18n, resolveManifestText, resolveManifestDoc } from "@kabegame/i18n";
import KbTab, { type KbTabItem } from "../common/KbTab.vue";
import PluginDocRenderer, { type DocHeading } from "./PluginDocRenderer.vue";
import PluginDocPanel from "./PluginDocPanel.vue";
import PluginDocToc from "./PluginDocToc.vue";
import PluginConfigPanel from "./PluginConfigPanel.vue";
import PluginProviderPanel from "./PluginProviderPanel.vue";
import PluginSideRail from "./PluginSideRail.vue";
import PluginLabelTags from "./PluginLabelTags.vue";
import type { Plugin } from "../../stores/plugins";
import { useUiStore } from "../../stores/ui";
import { usePluginActionState } from "../../composables/usePluginActionState";
import { APP_VERSION } from "../../env";
import { openExternalLink } from "../../utils/openExternalLink";

const { t, locale } = useI18n();
const uiStore = useUiStore();

const props = withDefaults(
  defineProps<{
    plugin: Plugin | null;
    loading: boolean;
    showSkeleton: boolean;
    /** 看的是不是一个「待安装的包」（商店条目 / .kgpg 预览）。false = 已安装的插件本体 */
    isRemote?: boolean;
  }>(),
  {
    isRemote: false,
  }
);

const emit = defineEmits<{
  (
    e: "start-task",
    payload: { pluginId: string; vars?: Record<string, any>; httpHeaders?: Record<string, string> }
  ): void;
  (e: "import-all-presets", presets: unknown[]): void;
  (e: "doc-image-preview-open", payload: { index: number; count: number; src: string; alt: string }): void;
  (e: "doc-image-preview-close", payload: { index: number; count: number; src: string; alt: string }): void;
}>();

const displayDesc = computed(() =>
  props.plugin
    ? resolveManifestText(props.plugin.description, locale.value) ||
      (typeof props.plugin.description === "object" && props.plugin.description["default"]) ||
      ""
    : ""
);
const displayDoc = computed(() => resolveManifestDoc(props.plugin?.doc ?? null, locale.value ?? "zh"));
const displayChangelog = computed(() => resolveManifestDoc(props.plugin?.changelog ?? null, locale.value ?? "zh"));

const appVersionText = computed(() => APP_VERSION ?? undefined);

// 按钮态（紧凑端的已安装/未安装 chip 用）——判据与页面头部共用同一个 composable
const { actionState } = usePluginActionState(
  () => props.plugin,
  () => props.isRemote
);

// PathQL provider 只反映「已安装表」里的定义；isRemote 时该表要么查不到、要么是另一个版本，一律不查
const canQueryProvider = computed(() => !props.isRemote);

function handleOpenBaseUrl() {
  if (props.plugin?.baseUrl) void openExternalLink(props.plugin.baseUrl);
}
function handleOpenReleaseLink() {
  void openExternalLink("https://github.com/kabegame/kabegame/releases/latest");
}

// ---- 桌面三栏 ----
/** 双击把手复位用；上下限统一走 kb-side-pane（与图片预览抽屉同一套 CSS 变量） */
const MENU_DEFAULT_WIDTH = 240;
const RAIL_DEFAULT_WIDTH = 264;
/** 左栏宽度三个 tab 共用一份，切 tab 不跳宽度 */
const menuWidth = useLocalStorage("kabegame-plugin-detail-menu-width", MENU_DEFAULT_WIDTH, {
  mergeDefaults: true,
});
const railWidth = useLocalStorage("kabegame-plugin-detail-rail-width", RAIL_DEFAULT_WIDTH, {
  mergeDefaults: true,
});

type DesktopTab = "doc" | "config" | "pathql" | "changelog";
const activeTab = ref<DesktopTab>("doc");
const pathqlCount = ref<number | null>(null);
watch(
  () => props.plugin?.id,
  () => {
    activeTab.value = "doc";
    pathqlCount.value = null;
  }
);

const configVarsCount = computed(() => {
  const vars = props.plugin?.config?.vars;
  return Array.isArray(vars) ? vars.length : null;
});

const tabItems = computed<KbTabItem<DesktopTab>[]>(() => {
  const items: KbTabItem<DesktopTab>[] = [
    { name: "doc", label: t("plugins.detail.tabDoc") },
    { name: "config", label: t("plugins.detail.tabConfig"), count: configVarsCount.value },
    { name: "pathql", label: t("plugins.detail.tabPathql"), count: pathqlCount.value },
  ];
  if (displayChangelog.value) {
    items.push({ name: "changelog", label: t("plugins.detail.tabChangelog") });
  }
  return items;
});

const isMarkdownTab = computed(() => activeTab.value === "doc" || activeTab.value === "changelog");
const tocOpen = ref(true);

const docHeadings = ref<DocHeading[]>([]);
const changelogHeadings = ref<DocHeading[]>([]);
const activeHeadings = computed(() => (activeTab.value === "changelog" ? changelogHeadings.value : docHeadings.value));

const docPanelRef = ref<InstanceType<typeof PluginDocPanel> | null>(null);
const changelogPanelRef = ref<InstanceType<typeof PluginDocPanel> | null>(null);
const activeScrollEl = computed<HTMLElement | null>(
  () => (activeTab.value === "changelog" ? changelogPanelRef.value?.scrollEl : docPanelRef.value?.scrollEl) ?? null
);

const docActiveHeadingId = ref<string | null>(null);
const changelogActiveHeadingId = ref<string | null>(null);
const activeHeadingId = computed(() =>
  activeTab.value === "changelog" ? changelogActiveHeadingId.value : docActiveHeadingId.value
);

/** scrollspy：找到「顶部已越过容器顶部一小段距离」的最后一个标题作为当前高亮项 */
function computeActiveHeading(container: HTMLElement | null | undefined, headings: DocHeading[]): string | null {
  if (!container || !headings.length) return null;
  const base = container.getBoundingClientRect().top;
  let current = headings[0]?.id ?? null;
  for (const h of headings) {
    const el = document.getElementById(h.id);
    if (!el) continue;
    if (el.getBoundingClientRect().top - base <= 24) current = h.id;
    else break;
  }
  return current;
}

const throttledDocScroll = useThrottleFn(() => {
  docActiveHeadingId.value = computeActiveHeading(docPanelRef.value?.scrollEl, docHeadings.value);
}, 120);
const throttledChangelogScroll = useThrottleFn(() => {
  changelogActiveHeadingId.value = computeActiveHeading(changelogPanelRef.value?.scrollEl, changelogHeadings.value);
}, 120);

watch(
  () => docPanelRef.value?.scrollEl,
  (el, oldEl) => {
    oldEl?.removeEventListener("scroll", throttledDocScroll);
    el?.addEventListener("scroll", throttledDocScroll);
  }
);
watch(
  () => changelogPanelRef.value?.scrollEl,
  (el, oldEl) => {
    oldEl?.removeEventListener("scroll", throttledChangelogScroll);
    el?.addEventListener("scroll", throttledChangelogScroll);
  }
);
watch(docHeadings, () => {
  docActiveHeadingId.value = computeActiveHeading(docPanelRef.value?.scrollEl, docHeadings.value);
});
watch(changelogHeadings, () => {
  changelogActiveHeadingId.value = computeActiveHeading(changelogPanelRef.value?.scrollEl, changelogHeadings.value);
});

function handleTocSelect(id: string) {
  const container = activeScrollEl.value;
  const target = document.getElementById(id);
  if (!container || !target) return;
  const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 12;
  container.scrollTo({ top, behavior: "smooth" });
}

// ---- 紧凑端 ----
type CompactTab = "doc" | "changelog";
const compactTab = ref<CompactTab>("doc");
watch(
  () => props.plugin?.id,
  () => {
    compactTab.value = "doc";
  }
);
const compactTabItems = computed<KbTabItem<CompactTab>[]>(() => [
  { name: "doc", label: t("plugins.detail.tabDoc") },
  { name: "changelog", label: t("plugins.detail.tabChangelog") },
]);
const compactDocText = computed(() => (compactTab.value === "changelog" ? displayChangelog.value : displayDoc.value));
const compactAnchorPrefix = computed(() => (compactTab.value === "changelog" ? "kbchangelog-compact" : "kbdoc-compact"));
</script>

<style scoped>
/* 四个侧栏（目录 / 配置项 / PathQL 的左栏 + 右侧信息栏）的拖拽宽度限制，靠变量继承一处生效。
   比图片预览抽屉的 45vw 收敛：那是 90vw 对话框里的一半，这里是整页布局，同样的像素更占地方。 */
.plugin-detail-panes {
  --kb-resizable-min: 240px;
  --kb-resizable-max: min(560px, 30vw);
}
</style>
