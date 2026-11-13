<template>
  <span
    v-if="count > 0"
    class="pointer-events-none absolute -right-1 -top-1 box-border flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-600 leading-none tabular-nums text-white ring-2 ring-[var(--kb-surface-raised)]"
    :class="tone === 'danger' ? 'bg-kb-danger' : 'bg-kb-accent'"
    aria-hidden="true"
  >
    {{ count > max ? `${max}+` : count }}
  </span>
</template>

<script setup lang="ts">
/**
 * 角标计数：放在一个 relative 的元素里（Button 已是 relative），浮在右上角；为 0 不显示。
 * 只是视觉提示，aria-hidden；需要读屏时把数量写进按钮的 aria-label。
 */
withDefaults(
  defineProps<{
    count: number;
    /** accent：进行中这类中性提醒；danger：失败、错误 */
    tone?: "accent" | "danger";
    max?: number;
  }>(),
  { tone: "accent", max: 99 },
);
</script>
