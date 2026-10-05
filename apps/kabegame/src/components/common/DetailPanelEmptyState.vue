<template>
  <div class="detail-panel-empty-state">
    <div class="detail-panel-empty-icon">
      <el-icon><Document /></el-icon>
    </div>
    <div class="detail-panel-empty-title">{{ title }}</div>
    <div class="detail-panel-empty-desc">{{ description }}</div>
  </div>
</template>

<script setup lang="ts">
import { Document } from "@kabegame/element-plus-icons";

defineProps<{
  title: string;
  description: string;
}>();
</script>

<style scoped lang="scss">
.detail-panel-empty-state {
  display: flex;
  align-items: center;
  flex-direction: column;
  gap: 12px;
  padding: 42px 24px;
  text-align: center;
}

.detail-panel-empty-icon {
  display: flex;
  width: 60px;
  height: 60px;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: var(--anime-secondary);
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--anime-primary) 14%, transparent),
    color-mix(in srgb, var(--anime-secondary) 16%, transparent)
  );
  font-size: 28px;
}

.detail-panel-empty-title {
  color: var(--anime-text-primary);
  font-size: 14.5px;
  font-weight: 600;
}

.detail-panel-empty-desc {
  max-width: 380px;
  color: var(--anime-text-secondary);
  font-size: 12.5px;
  line-height: 1.65;
}
</style>
