<template>
  <!-- 紧凑档（Android / 窄屏 Web）：全宽抽屉 -->
  <AndroidDrawer v-if="uiStore.isCompact" v-model="open" show-close-button>
    <template #header>
      <div class="flex items-center justify-between gap-3">
        <h3 class="m-0 text-[17px] font-600 text-kb-fg">{{ $t("gallery.collectNetworkTitle") }}</h3>
        <Button v-if="source === 'plugin'" variant="ghost" size="sm" @click="goRunConfigs">
          {{ $t("plugins.runConfig") }}
        </Button>
      </div>
    </template>

    <!-- 抽屉关上后内容还留着：每次打开换 key，面板重新挂载 -->
    <div :key="store.openSeq" class="flex flex-col gap-4 py-2">
      <SegmentedControl v-if="NETWORK_SOURCES.length > 1" v-model="source" :options="sourceOptions" />
      <div v-if="visited.has('plugin')" v-show="source === 'plugin'">
        <CrawlerTaskForm ref="taskFormRef" @close="store.close()" />
      </div>
      <div v-if="visited.has('webpage')" v-show="source === 'webpage'">
        <WebpageCollectPanel :ref="panelRef.webpage" :initial-config="store.webpageInitial" @done="store.close()" />
      </div>
    </div>

    <div class="mt-2 flex items-center justify-end gap-2 border-0 border-t border-solid border-kb-line px-5 pt-4">
      <Button
        v-if="source === 'plugin'"
        variant="outline"
        :disabled="!hasPlugin"
        @click="taskFormRef?.openSaveConfigDialog()"
      >
        {{ $t("plugins.saveAsConfig") }}
      </Button>
      <Button variant="primary" :disabled="!active?.canSubmit || active?.submitting" @click="active?.submit()">
        <Spinner v-if="active?.submitting" :size="14" />
        {{ submitLabel }}
      </Button>
    </div>
  </AndroidDrawer>

  <Dialog v-else v-model:open="open" :width="640" @open-auto-focus="focusCheckedSource">
    <template #title>
      <span class="flex items-center justify-between gap-3">
        {{ $t("gallery.collectNetworkTitle") }}
        <!-- 定时只在自动配置页编辑：插件来源给个跳转 -->
        <Button v-if="source === 'plugin'" variant="ghost" size="sm" class="-my-1" @click="goRunConfigs">
          {{ $t("plugins.runConfig") }}
          <ArrowUpRight />
        </Button>
      </span>
    </template>

    <!-- 每次打开换 key：面板重新挂载，草稿从干净的开始（插件来源的参数在全局 taskConfig 里，不受影响） -->
    <div :key="store.openSeq" class="flex flex-col gap-4">
      <SegmentedControl
        v-if="NETWORK_SOURCES.length > 1"
        v-model="source"
        :options="sourceOptions"
        class="max-w-[360px]"
      />
      <!-- 来源第一次切过去才挂载，之后 v-show 留着：本次打开内来回切换不丢草稿。
           外面包一层 div：CrawlerTaskForm 等是多根节点，v-show 直接放上去不生效 -->
      <div v-if="visited.has('plugin')" v-show="source === 'plugin'">
        <CrawlerTaskForm ref="taskFormRef" @close="store.close()" />
      </div>
      <div v-if="visited.has('webpage')" v-show="source === 'webpage'">
        <WebpageCollectPanel :ref="panelRef.webpage" :initial-config="store.webpageInitial" @done="store.close()" />
      </div>
      <div v-if="visited.has('steam')" v-show="source === 'steam'">
        <SteamImportPanel :ref="panelRef.steam" @done="store.close()" />
      </div>
    </div>

    <template #footer>
      <Button
        v-if="source === 'plugin'"
        variant="outline"
        class="mr-auto"
        :disabled="!hasPlugin"
        @click="taskFormRef?.openSaveConfigDialog()"
      >
        {{ $t("plugins.saveAsConfig") }}
      </Button>
      <span v-else-if="active?.hint" class="mr-auto text-[12px] text-kb-fg-muted">{{ active.hint }}</span>
      <Button variant="outline" @click="store.close()">{{ $t("common.cancel") }}</Button>
      <Button variant="primary" :disabled="!active?.canSubmit || active?.submitting" @click="active?.submit()">
        <Spinner v-if="active?.submitting" :size="14" />
        {{ submitLabel }}
      </Button>
    </template>
  </Dialog>
</template>

<script setup lang="ts">
/**
 * 收集入口「网络」：顶部分段切换来源（插件 / 网页 / Steam），底部按钮读当前面板（约定见 panel.ts）。
 * 插件来源的表单编辑全局唯一的 `taskConfig`：调用方「先写再打开」（`writeTaskConfig` + `openNetwork("plugin")`）。
 */
import { computed, reactive, ref, shallowReactive, watch } from "vue";
import { useRouter } from "vue-router";
import { storeToRefs } from "pinia";
import { useI18n } from "@kabegame/i18n";
import { ArrowUpRight } from "@lucide/vue";
import AndroidDrawer from "@/components/AndroidDrawer.vue";
import { Button, Dialog, SegmentedControl, Spinner } from "@/components/ui";
import CrawlerTaskForm from "@/components/crawler/CrawlerTaskForm.vue";
import { useUiStore } from "@/stores/ui";
import { useCrawlerStore } from "@/stores/crawler";
import { usePluginStore } from "@/stores/plugins";
import { NETWORK_SOURCES, useCollectDialogsStore, type NetworkSource } from "@/stores/collectDialogs";
import WebpageCollectPanel from "./WebpageCollectPanel.vue";
import SteamImportPanel from "./SteamImportPanel.vue";
import type { CollectPanelApi } from "./panel";

const { t } = useI18n();
const router = useRouter();
const uiStore = useUiStore();
const crawlerStore = useCrawlerStore();
const pluginStore = usePluginStore();
const store = useCollectDialogsStore();
const { networkSource: source } = storeToRefs(store);

const open = computed({
  get: () => store.openGroup === "network",
  set: (v: boolean) => {
    if (!v) store.close();
  },
});

const SOURCE_LABELS: Record<NetworkSource, string> = {
  plugin: "gallery.collectSourcePlugin",
  webpage: "gallery.webpage",
  steam: "gallery.collectSourceSteam",
};
const sourceOptions = computed(() => NETWORK_SOURCES.map((value) => ({ label: t(SOURCE_LABELS[value]), value })));
const submitLabel = computed(() => t(source.value === "steam" ? "albums.startImport" : "gallery.startCollect"));

/** 本次打开里切到过的来源；换一次打开清空 */
const visited = reactive(new Set<NetworkSource>());
watch(
  () => [store.openSeq, source.value] as const,
  ([seq], old) => {
    if (old && old[0] !== seq) visited.clear();
    visited.add(source.value);
  },
);

// ---------- 当前面板 ----------
const taskFormRef = ref<InstanceType<typeof CrawlerTaskForm> | null>(null);
const hasPlugin = computed(() => !!crawlerStore.taskConfig?.pluginId);
/** 插件表单不是按 panel.ts 写的：在这里包一层（提交成功时它自己 emit close） */
const pluginPanel = computed<CollectPanelApi | null>(() =>
  taskFormRef.value
    ? { submit: () => taskFormRef.value?.submit(), canSubmit: hasPlugin.value, submitting: false }
    : null,
);
const panels = shallowReactive<Partial<Record<NetworkSource, CollectPanelApi | null>>>({});
/** 每个来源一个稳定的函数 ref（内联箭头函数每次渲染都是新的） */
const panelRef: Partial<Record<NetworkSource, (el: unknown) => void>> = {};
for (const key of NETWORK_SOURCES) {
  panelRef[key] = (el) => {
    panels[key] = (el as CollectPanelApi | null) ?? null;
  };
}
const active = computed(() => (source.value === "plugin" ? pluginPanel.value : (panels[source.value] ?? null)));

/** 跳自动配置页（定时只在那边编辑） */
function goRunConfigs() {
  store.close();
  void router.push({ name: "AutoConfigs" });
}

// 打开时刷新一次已安装源（插件下拉与网页表单的字段定义都来自它）
watch(open, async (isOpen) => {
  if (!isOpen) return;
  try {
    await pluginStore.loadPlugins();
  } catch (e) {
    console.debug("收集弹窗打开时刷新已安装源失败（忽略）：", e);
  }
});

/**
 * 打开时焦点落在选中的来源上：默认会落到第一个分段，它的焦点环看起来像「选中」，
 * 上次停在别的来源时很容易误读。只有一个来源（没有分段）时走默认。
 */
function focusCheckedSource(e: Event) {
  const checked = (e.target as HTMLElement | null)?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
  if (!checked) return;
  e.preventDefault();
  checked.focus();
}
</script>
