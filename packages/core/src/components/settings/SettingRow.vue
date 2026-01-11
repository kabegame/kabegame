<template>
  <div class="setting-row">
    <div class="setting-meta">
      <div class="label">
        {{ label }}
        <el-tooltip v-if="description" :content="description" placement="top">
          <el-icon class="help-icon">
            <QuestionFilled />
          </el-icon>
        </el-tooltip>
      </div>
    </div>
    <div class="setting-control">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { QuestionFilled } from "@element-plus/icons-vue";

defineProps<{
  label: string;
  description?: string;
}>();
</script>

<style scoped lang="scss">
.setting-row {
  display: grid;
  grid-template-columns: 3fr 7fr;
  align-items: center;
  gap: 16px;
  padding: 10px 0;
}

.setting-meta {
  justify-self: end;
  display: flex;
  justify-content: flex-end;
}

.label {
  font-weight: 600;
  color: var(--anime-text-primary);
  line-height: 1.3;
  display: flex;
  align-items: center;
  gap: 6px;
}

.help-icon {
  color: var(--anime-text-muted);
  font-size: 14px;
  cursor: help;
  flex-shrink: 0;
}

.setting-control {
  display: flex;
  justify-content: flex-start;
}

@media (max-width: 720px) {
  .setting-row {
    grid-template-columns: 1fr;
  }

  .setting-meta {
    min-width: 0;
  }

  .setting-control {
    width: 100%;
    min-width: 0;
    justify-content: flex-start;
  }
}
</style>

