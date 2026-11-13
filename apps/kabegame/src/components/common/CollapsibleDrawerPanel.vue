<template>
  <!-- 中性外框：细线 + 圆角，不铺底色（宿主侧栏 / 抽屉自己是白底）；kb-collapsible-panel* 是标记类，
       宿主样式（ImageDetailDialog 的堆叠布局）按它判断展开 / 收拢 -->
  <section
    class="kb-collapsible-panel box-border flex min-h-11 min-w-0 flex-col overflow-hidden rounded-kb-lg border border-solid border-kb-line text-kb-fg"
    :class="[
      panelOpen ? '' : 'kb-collapsible-panel--collapsed flex-none',
      fillWhenExpanded ? 'kb-collapsible-panel--fill' : '',
      panelOpen && fillWhenExpanded ? 'min-h-0 flex-1' : '',
    ]"
  >
    <div class="box-border flex w-full shrink-0 items-center justify-between gap-2 py-2 pl-3 pr-2 text-left">
      <button
        v-if="collapsible"
        type="button"
        class="flex min-h-7 min-w-0 flex-1 cursor-pointer items-center border-0 bg-transparent p-0 text-left text-inherit [font:inherit] outline-none focus-visible:rounded-kb-sm focus-visible:ring-2 focus-visible:ring-kb-ring"
        :aria-expanded="panelOpen"
        :aria-label="toggleAriaLabel"
        @click="panelOpen = !panelOpen"
      >
        <span :class="TITLE_CLASS">
          <slot name="title" />
        </span>
      </button>
      <span v-else class="flex min-h-7 min-w-0 flex-1 items-center">
        <span :class="TITLE_CLASS">
          <slot name="title" />
        </span>
      </span>
      <div class="inline-flex shrink-0 items-center gap-1">
        <slot name="trailing" />
        <Button
          v-if="collapsible"
          variant="ghost"
          size="icon-sm"
          :aria-expanded="panelOpen"
          :aria-label="toggleAriaLabel"
          @click="panelOpen = !panelOpen"
        >
          <ChevronDown class="transition-transform duration-200" :class="{ 'rotate-180': panelOpen }" />
        </Button>
      </div>
    </div>
    <!-- 收拢时不渲染内容（v-if 而非 v-show）：插件简介 iframe 等重内容需要真正销毁 -->
    <div v-if="panelOpen" class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <slot />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useLocalStorage } from "@vueuse/core";
import { ChevronDown } from "@lucide/vue";
import { Button } from "@/components/ui";

const props = withDefaults(
  defineProps<{
    storageKey: string;
    defaultOpen?: boolean;
    /** 无障碍：标题区无可见文案时建议传入 */
    toggleAriaLabel?: string;
    /** 展开时是否参与 flex 占满剩余高度（任务抽屉、图片详情插件区等） */
    fillWhenExpanded?: boolean;
    /**
     * 是否允许收拢。false 时隐藏箭头、标题不可点，内容恒定展开
     * （详情弹窗桌面端三栏并排，空间充足，不提供收拢）。
     */
    collapsible?: boolean;
  }>(),
  {
    defaultOpen: true,
    fillWhenExpanded: true,
    collapsible: true,
  },
);

const TITLE_CLASS = "min-w-0 flex-1 truncate text-[13.5px] font-600 leading-5 text-kb-fg";

const storedOpen = useLocalStorage(props.storageKey, props.defaultOpen, {
  mergeDefaults: true,
});

/** 不可收拢时恒定展开，但不写回持久化值（保留用户在可收拢场景下的偏好）。 */
const panelOpen = computed({
  get: () => (props.collapsible ? storedOpen.value : true),
  set: (v: boolean) => {
    if (props.collapsible) storedOpen.value = v;
  },
});
</script>
