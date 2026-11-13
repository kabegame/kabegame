<template>
  <!-- Android：自研全宽抽屉 -->
  <AndroidDrawer v-if="uiStore.isCompact" v-model="open" show-close-button>
    <template #header>
      <div class="flex items-center justify-between gap-3">
        <h3 class="m-0 text-[17px] font-600 text-kb-fg">{{ $t("plugins.startCollect") }}</h3>
        <Button variant="ghost" size="sm" @click="goRunConfigs">{{ $t("plugins.runConfig") }}</Button>
      </div>
    </template>

    <CrawlerTaskForm ref="taskFormRef" @close="open = false" />

    <div class="mt-2 flex items-center justify-end gap-2 border-0 border-t border-solid border-kb-line px-5 pt-4">
      <Button variant="outline" :disabled="!hasPlugin" @click="taskFormRef?.openSaveConfigDialog()">
        {{ $t("plugins.saveAsConfig") }}
      </Button>
      <Button variant="primary" :disabled="!hasPlugin" @click="taskFormRef?.submit()">
        {{ $t("plugins.startCollect") }}
      </Button>
    </div>
  </AndroidDrawer>

  <Dialog v-else v-model:open="open" :width="600">
    <template #title>
      <span class="flex items-center justify-between gap-3">
        {{ $t("plugins.startCollect") }}
        <Button variant="ghost" size="sm" class="-my-1" @click="goRunConfigs">
          {{ $t("plugins.runConfig") }}
          <ArrowUpRight />
        </Button>
      </span>
    </template>

    <CrawlerTaskForm ref="taskFormRef" @close="open = false" />

    <template #footer>
      <Button variant="outline" class="mr-auto" :disabled="!hasPlugin" @click="taskFormRef?.openSaveConfigDialog()">
        {{ $t("plugins.saveAsConfig") }}
      </Button>
      <Button variant="outline" @click="open = false">{{ $t("common.close") }}</Button>
      <Button variant="primary" :disabled="!hasPlugin" @click="taskFormRef?.submit()">
        {{ $t("plugins.startCollect") }}
      </Button>
    </template>
  </Dialog>
</template>

<script setup lang="ts">
/**
 * 收集弹窗：对来源无感。全局 crawler store 只存一份 `taskConfig`，
 * 调用方「先写再打开」（`writeTaskConfig` + `crawlerDrawerStore.open()`），
 * 这里只响应式地编辑这份对象。
 */
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ArrowUpRight } from "@lucide/vue";
import AndroidDrawer from "@/components/AndroidDrawer.vue";
import Button from "@/components/ui/Button.vue";
import Dialog from "@/components/ui/Dialog.vue";
import { useUiStore } from "@/stores/ui";
import { useCrawlerStore } from "@/stores/crawler";
import { usePluginStore } from "@/stores/plugins";
import CrawlerTaskForm from "@/components/crawler/CrawlerTaskForm.vue";

interface Props {
  modelValue: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
}>();

const router = useRouter();
const crawlerStore = useCrawlerStore();
const pluginStore = usePluginStore();
const uiStore = useUiStore();
const taskFormRef = ref<InstanceType<typeof CrawlerTaskForm> | null>(null);

/** 开关直接透传给 Dialog / AndroidDrawer：两者各自接 Android 返回栈与层级 */
const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit("update:modelValue", v),
});

const hasPlugin = computed(() => !!crawlerStore.taskConfig?.pluginId);

/** 任何入口都显示：跳自动配置页（定时只在那边编辑） */
function goRunConfigs() {
  open.value = false;
  void router.push({ name: "AutoConfigs" });
}

watch(
  open,
  async (isOpen) => {
    if (!isOpen) return;
    try {
      await pluginStore.loadPlugins();
    } catch (e) {
      console.debug("导入弹窗打开时刷新已安装源失败（忽略）：", e);
    }
  },
  { immediate: true },
);
</script>
