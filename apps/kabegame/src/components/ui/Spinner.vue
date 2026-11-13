<template>
  <svg
    viewBox="0 0 24 24"
    fill="none"
    role="status"
    :aria-label="label"
    data-kb-motion
    class="shrink-0 animate-[kb-spin_0.8s_linear_infinite]"
    :style="{ width: `${size}px`, height: `${size}px` }"
  >
    <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.25" opacity="0.18" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" />
  </svg>
</template>

<script setup lang="ts">
/** 转圈：颜色跟随 currentColor（默认继承文字色），尺寸用 size（px）。 */
withDefaults(defineProps<{ size?: number; label?: string }>(), { size: 18, label: "loading" });
</script>
