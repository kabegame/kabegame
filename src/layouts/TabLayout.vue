<template>
  <div class="tab-layout" :style="containerStyle">
    <PageHeader
      :title="title"
      :subtitle="subtitle"
      :show-back="showBack"
      :sticky="sticky"
      @back="$emit('back')"
    >
      <template v-if="$slots.icon" #icon>
        <slot name="icon" />
      </template>
      <template v-if="$slots.title" #title>
        <slot name="title" />
      </template>
      <template v-if="$slots.left" #left>
        <slot name="left" />
      </template>
      <slot name="actions" />
    </PageHeader>

    <div class="tab-layout-body">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import PageHeader from "@/components/common/PageHeader.vue";

const props = withDefaults(
  defineProps<{
    title: string;
    subtitle?: string;
    showBack?: boolean;
    sticky?: boolean;
    /** 例如 "1200px" */
    maxWidth?: string;
    /** 当设置了 maxWidth 时，是否居中（margin: 0 auto） */
    center?: boolean;
  }>(),
  {
    sticky: true,
    center: true,
  }
);

defineEmits<{
  back: [];
}>();

const containerStyle = computed(() => {
  if (!props.maxWidth) return undefined;
  return {
    maxWidth: props.maxWidth,
    margin: props.center ? "0 auto" : undefined,
  } as Record<string, string | undefined>;
});
</script>

<style scoped lang="scss">
.tab-layout {
  width: 100%;
  height: 100%;
  padding: 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;

  /* 隐藏滚动条 */
  scrollbar-width: none; /* Firefox */
  -ms-overflow-style: none; /* IE and Edge */

  &::-webkit-scrollbar {
    display: none; /* Chrome, Safari, Opera */
  }
}

.tab-layout-body {
  width: 100%;
  min-height: 0;
}
</style>


