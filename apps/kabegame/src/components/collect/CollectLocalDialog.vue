<template>
  <Dialog
    v-model:open="open"
    :title="$t('gallery.collectLocalTitle')"
    :width="640"
    @open-auto-focus="focusCheckedSource"
  >
    <!-- 每次打开换 key：面板重新挂载，草稿从干净的开始 -->
    <div :key="store.openSeq" class="flex flex-col gap-4">
      <SegmentedControl
        v-if="LOCAL_SOURCES.length > 1"
        v-model="source"
        :options="sourceOptions"
        class="max-w-[320px]"
      />
      <!-- 来源第一次切过去才挂载，之后 v-show 留着：本次打开内来回切换不丢草稿。
           外面包一层 div：CrawlerTaskForm 等是多根节点，v-show 直接放上去不生效 -->
      <div v-if="visited.has('folder')" v-show="source === 'folder'">
        <LocalFolderPanel :ref="panelRef.folder" :initial-config="store.localImportInitial" @done="store.close()" />
      </div>
      <div v-if="visited.has('wpe')" v-show="source === 'wpe'">
        <WpeLocalPanel :ref="panelRef.wpe" @done="store.close()" />
      </div>
    </div>

    <template #footer>
      <span v-if="active?.hint" class="mr-auto text-[12px] text-kb-fg-muted">{{ active.hint }}</span>
      <Button @click="store.close()">{{ $t("common.cancel") }}</Button>
      <Button variant="primary" :disabled="!active?.canSubmit || active?.submitting" @click="active?.submit()">
        <Spinner v-if="active?.submitting" :size="14" />
        {{ $t("albums.startImport") }}
      </Button>
    </template>
  </Dialog>
</template>

<script setup lang="ts">
/**
 * 收集入口「本地」：顶部分段切换来源（文件夹 / WPE 壁纸），底部按钮读当前面板（约定见 panel.ts）。
 * 只在桌面档挂载；紧凑档（Android）的本地导入是画廊里的 MediaPicker。
 */
import { computed, reactive, shallowReactive, watch } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "@kabegame/i18n";
import { Button, Dialog, SegmentedControl, Spinner } from "@/components/ui";
import { LOCAL_SOURCES, useCollectDialogsStore, type LocalSource } from "@/stores/collectDialogs";
import LocalFolderPanel from "./LocalFolderPanel.vue";
import WpeLocalPanel from "./WpeLocalPanel.vue";
import type { CollectPanelApi } from "./panel";

const { t } = useI18n();
const store = useCollectDialogsStore();
const { localSource: source } = storeToRefs(store);

const open = computed({
  get: () => store.openGroup === "local",
  set: (v: boolean) => {
    if (!v) store.close();
  },
});

const SOURCE_LABELS: Record<LocalSource, string> = {
  folder: "gallery.collectSourceFolder",
  wpe: "gallery.collectSourceWpe",
};
const sourceOptions = computed(() => LOCAL_SOURCES.map((value) => ({ label: t(SOURCE_LABELS[value]), value })));

/** 本次打开里切到过的来源；换一次打开清空 */
const visited = reactive(new Set<LocalSource>());
watch(
  () => [store.openSeq, source.value] as const,
  ([seq], old) => {
    if (old && old[0] !== seq) visited.clear();
    visited.add(source.value);
  },
);

const panels = shallowReactive<Partial<Record<LocalSource, CollectPanelApi | null>>>({});
/** 每个来源一个稳定的函数 ref（内联箭头函数每次渲染都是新的） */
const panelRef: Partial<Record<LocalSource, (el: unknown) => void>> = {};
for (const key of LOCAL_SOURCES) {
  panelRef[key] = (el) => {
    panels[key] = (el as CollectPanelApi | null) ?? null;
  };
}
const active = computed(() => panels[source.value] ?? null);

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
