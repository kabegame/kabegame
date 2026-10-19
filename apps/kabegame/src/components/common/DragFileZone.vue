<template>
  <component :is="tag" ref="rootRef">
    <slot />
  </component>
</template>

<script setup lang="ts">
// 区域级拖入热区：挂载时登记根元素、卸载时注销。
// 注册表直接持有响应式 props，命中时（disabled / plan）读到的总是最新值。
import { onBeforeUnmount, onMounted, ref } from "vue";
import { registerDragZone, unregisterDragZone, type DragFileItem, type DragFilePlan } from "@/utils/dragFileZones";

const props = withDefaults(
  defineProps<{
    tag?: string;
    plan: (items: DragFileItem[]) => DragFilePlan | null;
    onDrop: (plan: DragFilePlan) => void | Promise<void>;
    disabled?: boolean;
  }>(),
  { tag: "div", disabled: false },
);

const rootRef = ref<HTMLElement | null>(null);

onMounted(() => {
  if (rootRef.value) registerDragZone(rootRef.value, props);
});

onBeforeUnmount(() => {
  if (rootRef.value) unregisterDragZone(rootRef.value);
});
</script>
