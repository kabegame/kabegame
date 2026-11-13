<template>
  <button
    type="button"
    class="box-border flex h-9 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-kb-md border-0 bg-transparent px-2.5 text-left [font-family:inherit] text-[13px] text-kb-fg outline-none transition-colors duration-150 hover:bg-kb-hover focus-visible:bg-kb-hover disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-kb-fg-muted"
    :disabled="disabled"
  >
    <slot name="icon" />
    <span class="min-w-0 flex-1 truncate">{{ label }}</span>
    <span v-if="hint" class="shrink-0 text-[12px] tabular-nums text-kb-fg-subtle">{{ hint }}</span>
    <slot />
  </button>
</template>

<script setup lang="ts">
/**
 * 工具箱（侧栏浮层 / 紧凑端 tab / 吉祥物气泡）里的一行：图标 + 文字 + 右侧提示或开关。
 * 整理、清理隐藏、检查更新这些自带逻辑的条目也用它，外观与普通条目一致。
 */
defineProps<{ label: string; hint?: string; disabled?: boolean }>();
</script>
