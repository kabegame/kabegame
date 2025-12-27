<template>
  <div class="page-header">
    <div class="left">
      <el-button v-if="showBack" circle @click="$emit('back')">
        <el-icon>
          <ArrowLeft />
        </el-icon>
      </el-button>
      <div v-if="$slots.icon" class="icon-slot">
        <slot name="icon" />
      </div>
      <div class="text">
        <div class="title">{{ title }}</div>
        <div class="subtitle" v-if="subtitle">{{ subtitle }}</div>
      </div>
    </div>
    <div class="right">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ArrowLeft } from "@element-plus/icons-vue";

defineProps<{
  title: string;
  subtitle?: string;
  showBack?: boolean;
}>();

defineEmits<{
  back: [];
}>();
</script>

<style scoped lang="scss">
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
  padding: 16px;
  background: var(--anime-bg-card);
  border-radius: 12px;
  box-shadow: var(--anime-shadow);

.left {
  display: flex;
  align-items: center;
  gap: 14px;
  flex: 1;
  min-width: 0;
}

.right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.title {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.2;
  background: linear-gradient(135deg, var(--anime-primary) 0%, var(--anime-secondary) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.subtitle {
  color: var(--anime-text-muted);
  font-size: 13px;
  line-height: 1.2;
}

.icon-slot {
  width: 64px;
  height: 64px;
  border-radius: 12px;
  overflow: hidden;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--anime-bg-secondary);
  border: 2px solid var(--anime-border);
  }
}
</style>
