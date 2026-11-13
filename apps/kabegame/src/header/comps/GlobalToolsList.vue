<template>
  <div class="flex flex-col">
    <template v-if="busyCount > 0 || hasUnseenFailure">
      <BusyTasksSection @close="emit('close')" />
      <div class="-mx-1.5 my-1.5 h-px bg-kb-line" />
    </template>
    <template v-if="compact">
      <!-- 任务入口不进工具箱：各页 header 已常驻 TaskDrawerButton -->
      <div :class="GROUP_TITLE">{{ t("header.toolboxApp") }}</div>
      <ToolRow :label="t('route.settings')" @click="emit('open-settings')">
        <template #icon><Settings /></template>
      </ToolRow>
      <ToolRow v-if="!IS_WEB" :label="t('route.surf')" @click="openSurf">
        <template #icon><Compass /></template>
      </ToolRow>
      <div v-if="groups.length > 0" class="-mx-1.5 my-1.5 h-px bg-kb-line" />
    </template>

    <template v-for="(group, gi) in groups" :key="group.id">
      <div :class="GROUP_TITLE">{{ group.title }}</div>
      <template v-for="item in group.items" :key="item.id">
        <component :is="item.comp" v-if="item.comp" @done="emit('close')" />
        <ToolRow
          v-else-if="item.kind === 'toggle'"
          :label="item.label"
          role="switch"
          :aria-checked="!!item.toggleGet?.()"
          @click="item.toggleSet?.(!item.toggleGet?.())"
        >
          <template #icon><component :is="item.icon" /></template>
          <!-- 整行可点；开关本身只是状态显示，不再单独接点击（否则点在开关上会切两次） -->
          <Switch
            :model-value="!!item.toggleGet?.()"
            size="sm"
            as="span"
            class="pointer-events-none"
            aria-hidden="true"
          />
        </ToolRow>
        <ToolRow v-else :label="item.label" :hint="item.shortcut" @click="runAction(item)">
          <template #icon><component :is="item.icon" /></template>
        </ToolRow>
      </template>
      <div v-if="gi < groups.length - 1" class="-mx-1.5 my-1.5 h-px bg-kb-line" />
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * 全局工具箱的内容：后台任务、（紧凑端）应用入口、维护与显示两组条目。
 * 侧栏 / 紧凑端的浮层（GlobalToolsPopover）与吉祥物气泡（KameToolboxBubble）共用这一份。
 * 自定义条目组件（整理、清理隐藏、检查更新）完成动作后 emit('done')，由这里转成 close。
 */
import { useRouter } from "vue-router";
import { Compass, Settings } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import { Switch } from "@/components/ui";
import { useGlobalTools, type GlobalToolItem } from "@/header/globalToolsRegistry";
import { useBusyTasks } from "@/composables/useBusyTasks";
import BusyTasksSection from "@/components/busy/BusyTasksSection.vue";
import { IS_WEB } from "@/env";
import ToolRow from "./ToolRow.vue";

defineProps<{
  /** 紧凑端（底部 tab）：多一组「应用」入口（设置、畅游） */
  compact?: boolean;
}>();
const emit = defineEmits<{ close: []; "open-settings": [] }>();

const { t } = useI18n();
const router = useRouter();
const { groups } = useGlobalTools();
const { count: busyCount, hasUnseenFailure } = useBusyTasks();

const GROUP_TITLE = "px-2.5 pb-1 pt-1.5 text-[11.5px] font-500 text-kb-fg-subtle";

function openSurf() {
  void router.push("/surf");
  emit("close");
}

function runAction(item: GlobalToolItem) {
  item.action?.();
  emit("close");
}
</script>
