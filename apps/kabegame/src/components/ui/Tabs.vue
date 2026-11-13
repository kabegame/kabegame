<template>
  <TabsRoot v-model="model" activation-mode="manual" class="min-w-0 max-w-full">
    <TabsList
      class="box-border inline-flex min-w-0 max-w-full items-center gap-0.5 overflow-x-auto overscroll-x-contain rounded-kb-lg bg-kb-fill p-[3px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <template v-for="item in items" :key="item.name">
        <!-- 动作项（如「添加源」）不是一个内容页：普通按钮，不进 Tabs 的选中与方向键漫游 -->
        <Tooltip v-if="item.action" :content="item.iconOnly ? item.label : ''">
          <button
            type="button"
            :class="[TRIGGER, item.iconOnly ? 'w-7.5 px-0' : 'px-3']"
            :aria-label="item.iconOnly ? item.label : undefined"
            @click="emit('select', item.name)"
          >
            <component :is="item.icon" v-if="item.icon" />
            <span v-if="!item.iconOnly">{{ item.label }}</span>
          </button>
        </Tooltip>
        <Tooltip v-else :content="item.iconOnly ? item.label : ''">
          <TabsTrigger
            :value="item.name"
            :class="[TRIGGER, item.iconOnly ? 'w-7.5 px-0' : 'px-3']"
            :aria-label="item.iconOnly ? item.label : undefined"
            @click="emit('select', item.name)"
          >
            <component :is="item.icon" v-if="item.icon" />
            <span v-if="!item.iconOnly">{{ item.label }}</span>
            <span v-if="item.count != null" class="text-[11.5px] font-500 tabular-nums text-kb-fg-subtle">
              {{ item.count }}
            </span>
            <span
              v-if="(item.badge ?? 0) > 0"
              class="box-border inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-kb-accent px-1 text-[10px] font-600 leading-none tabular-nums text-white"
            >
              {{ (item.badge ?? 0) > 99 ? "99+" : item.badge }}
            </span>
            <!-- 叉号在触发器里：按下就会被 Tabs 当成选中，三种指针事件都要拦 -->
            <span
              v-if="item.closable"
              role="button"
              :aria-label="closeTitle"
              :title="closeTitle"
              class="-mr-1.5 grid size-4.5 place-items-center rounded-kb-sm text-kb-fg-subtle transition-colors hover:bg-kb-hover hover:text-kb-danger [&_svg]:size-3"
              @pointerdown.stop
              @mousedown.stop
              @click.stop="emit('close', item.name)"
            >
              <X />
            </span>
          </TabsTrigger>
        </Tooltip>
      </template>
    </TabsList>
  </TabsRoot>
</template>

<script setup lang="ts" generic="T extends string">
/**
 * 分段式选项卡：只管 tab 头，内容由调用方按 v-model 自己切换（各处的内容要么很重要懒加载，
 * 要么根本不是「面板」语义）。行为来自 Reka Tabs（方向键漫游、手动激活）。
 * 计数跟在文字后、角标是行内的强调色小圆，不做右上角浮起——列表横向可滚，浮出去会被裁掉。
 */
import { TabsList, TabsRoot, TabsTrigger } from "reka-ui";
import { X } from "@lucide/vue";
import Tooltip from "./Tooltip.vue";
import type { TabItem } from "./tabs";

const model = defineModel<T>({ required: true });

defineProps<{
  items: TabItem<T>[];
  /** 可删除项叉号的提示文字 */
  closeTitle?: string;
}>();

const emit = defineEmits<{
  close: [name: T];
  select: [name: T];
}>();

const TRIGGER =
  "relative box-border inline-flex h-7.5 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] " +
  "border-0 bg-transparent py-0 [font-family:inherit] text-[13px] font-500 leading-none text-kb-fg-muted cursor-pointer " +
  "outline-none select-none transition-[background-color,color,box-shadow] duration-150 hover:text-kb-fg " +
  "focus-visible:ring-2 focus-visible:ring-kb-ring data-[state=active]:bg-kb-surface-raised data-[state=active]:text-kb-fg " +
  "data-[state=active]:shadow-kb-md [&_svg]:size-4 [&_svg]:shrink-0";
</script>
