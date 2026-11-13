<template>
  <div class="flex min-w-0 items-baseline gap-3" :style="span > 1 ? { gridColumn: `span ${span}` } : undefined">
    <dt class="w-[var(--kb-dl-label-width,112px)] shrink-0 text-kb-fg-muted">{{ label }}</dt>
    <dd class="m-0 min-w-0 flex-1 break-words text-kb-fg"><slot /></dd>
  </div>
</template>

<script setup lang="ts">
/** DescriptionList 的一行；span 跨几列。 */
withDefaults(defineProps<{ label: string; span?: number }>(), { span: 1 });
</script>
