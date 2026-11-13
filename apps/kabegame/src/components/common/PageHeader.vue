<template>
  <!-- 类名 page-header / title / subtitle / left / right 保留：外部样式与测试按它们定位 -->
  <header
    class="page-header box-border flex h-16 shrink-0 items-center justify-between gap-4 mb-5 px-4 border border-solid border-kb-line bg-kb-surface backdrop-blur-xl backdrop-saturate-150"
    :class="[
      props.sticky ? 'sticky top-0 z-100' : '',
      uiStore.isCompact ? 'is-compact rounded-none border-x-0 border-t-0' : 'rounded-kb-lg shadow-kb-sm',
    ]"
  >
    <div class="left flex min-w-0 flex-1 items-center gap-3">
      <Tooltip v-if="showBack" :content="t('header.back')">
        <Button variant="ghost" size="icon" class="-ml-1.5" :aria-label="t('header.back')" @click="$emit('back')">
          <ChevronLeft />
        </Button>
      </Tooltip>
      <div
        v-if="$slots.icon"
        class="box-border flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-kb-md border border-solid border-kb-line bg-kb-surface-raised"
      >
        <slot name="icon" />
      </div>
      <div class="flex min-w-0 flex-col gap-0.5">
        <h1 class="title m-0 truncate text-[17px] font-600 leading-6 tracking-[-0.01em] text-kb-fg">
          <slot name="title">{{ title }}</slot>
        </h1>
        <div
          v-if="subtitle || $slots.subtitle"
          class="subtitle truncate text-[12.5px] leading-[18px] text-kb-fg-muted tabular-nums"
        >
          <slot name="subtitle">{{ subtitle }}</slot>
        </div>
      </div>
      <div v-if="$slots.left" class="ml-auto flex items-center gap-2">
        <slot name="left" />
      </div>
    </div>
    <div class="right flex shrink-0 items-center gap-1">
      <slot name="extra" />
      <!-- 自定义 slot 优先 -->
      <slot v-if="$slots.default" />
      <!-- 自动渲染 show features -->
      <template v-else>
        <template v-for="featureId in show" :key="featureId">
          <component
            v-if="getShowComponent(featureId)"
            :is="getShowComponent(featureId)"
            v-bind="getShowProps(featureId)"
            @action="(data: any) => $emit('action', { id: featureId, data })"
          />
        </template>
        <DropdownMenu v-if="fold && fold.length > 0">
          <Tooltip :content="t('header.more')">
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="icon" :aria-label="t('header.more')">
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent>
            <DropdownMenuItem
              v-for="featureId in fold"
              :key="featureId"
              @select="$emit('action', { id: featureId, data: { type: 'click' } })"
            >
              <component :is="getFoldIcon(featureId)" v-if="getFoldIcon(featureId)" />
              <span>{{ getFoldLabel(featureId) }}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </template>
    </div>
  </header>
</template>

<script setup lang="ts">
import { ChevronLeft, Ellipsis } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
} from "@/components/ui";
import { useHeaderStore } from "../../stores/header";
import { useUiStore } from "../../stores/ui";
import HeaderActionButton from "./HeaderActionButton.vue";

const props = withDefaults(
  defineProps<{
    title: string;
    subtitle?: string;
    showBack?: boolean;
    sticky?: boolean;
    show?: string[];
    fold?: string[];
  }>(),
  {
    sticky: true,
    show: () => [],
    fold: () => [],
  },
);

defineEmits<{
  back: [];
  action: [payload: { id: string; data: { type: string; [key: string]: any } }];
}>();

const { t } = useI18n();
const headerStore = useHeaderStore();
const uiStore = useUiStore();

const getShowComponent = (featureId: string) => {
  const feature = headerStore.get(featureId);
  if (feature?.comp) {
    return feature.comp;
  }
  if (feature?.icon && feature?.label) {
    return HeaderActionButton;
  }
  return null;
};

const getShowProps = (featureId: string) => {
  const feature = headerStore.get(featureId);
  if (feature?.comp) {
    return {};
  }
  if (feature?.icon && feature?.label) {
    return { icon: feature.icon, label: feature.label };
  }
  return {};
};

const getFoldIcon = (featureId: string) => {
  const feature = headerStore.get(featureId);
  return feature?.icon;
};

const getFoldLabel = (featureId: string) => headerStore.getFoldLabel(featureId);
</script>

<style scoped>
/* 紧凑布局下顶栏贴满视口宽度（父容器有左右内边距） */
.page-header.is-compact {
  width: 100vw;
  margin-right: calc(50% - 50vw);
  margin-left: calc(50% - 50vw);
}
</style>
