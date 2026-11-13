<template>
  <Transition
    enter-active-class="transition-opacity duration-150"
    leave-active-class="transition-opacity duration-150"
    enter-from-class="opacity-0"
    leave-to-class="opacity-0"
  >
    <div
      v-if="visible"
      class="absolute inset-0 z-[5] grid place-items-center rounded-[inherit] bg-[color-mix(in_srgb,var(--kb-surface-raised)_72%,transparent)] text-kb-fg-muted"
    >
      <Spinner :size="22" />
    </div>
  </Transition>
</template>

<script setup lang="ts">
/** v-loading 指令挂进宿主元素的遮罩（指令在 loading.ts）。 */
import Spinner from "./Spinner.vue";

defineProps<{ visible: boolean }>();
</script>
