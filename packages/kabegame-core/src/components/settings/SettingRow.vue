<template>
  <div class="setting-row grid min-w-0 items-center gap-4 py-[15px]">
    <div class="setting-meta min-w-0">
      <div class="text-[14px] font-600 leading-5 text-[var(--anime-text-primary)]">
        {{ label }}
      </div>
      <p v-if="description" class="m-0 mt-1 text-[12px] leading-[1.55] text-[var(--anime-text-muted)]">
        {{ description }}
      </p>
    </div>
    <div class="setting-control flex min-w-0 items-center justify-end">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  label: string;
  description?: string;
}>();
</script>

<style scoped>
.setting-row {
  grid-template-columns: minmax(0, 1fr) minmax(180px, auto);
  /* 分隔线只是"呼吸感"，不是边框：取主色的极低透明度，在近白的面板上几乎化开。
     注意别用 var(--anime-border)（0.3 透明度）——那是控件描边的强度，做分隔线偏重。 */
  border-top: 1px solid color-mix(in srgb, var(--anime-primary) 15%, transparent);
}

@media (max-width: 640px) {
  .setting-row {
    grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
    gap: 12px;
  }

  .setting-control {
    width: 100%;
  }
}
</style>
