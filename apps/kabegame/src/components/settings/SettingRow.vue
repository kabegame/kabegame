<template>
  <div class="setting-row grid min-w-0 items-center gap-4 border-0 border-t border-solid border-kb-line py-[15px]">
    <div class="setting-meta min-w-0">
      <div class="text-[14px] font-600 leading-5 text-kb-fg">
        {{ label }}
      </div>
      <p v-if="description" class="m-0 mt-1 text-[12px] leading-[1.55] text-kb-fg-muted">
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
