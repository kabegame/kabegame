<template>
  <section class="settings-section">
    <h2 class="settings-section-title">
      {{ title }}
    </h2>
    <div class="settings-section-rows">
      <slot />
    </div>
  </section>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  title: string;
  /** @deprecated 分组不再使用卡片背景，保留仅为兼容旧调用点 */
  transparent?: boolean;
}>(), {
  transparent: false,
});
</script>

<style scoped>
.settings-section + .settings-section {
  margin-top: 24px;
}

.settings-section-title {
  margin: 0 0 12px;
  padding: 0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.14em;
  color: color-mix(in srgb, var(--anime-primary) 55%, var(--anime-secondary) 30%);
}
</style>
