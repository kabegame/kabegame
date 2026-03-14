<template>
  <el-drawer
    :model-value="modelValue"
    :title="title"
    :size="IS_ANDROID ? 'auto' : '400px'"
    :direction="IS_ANDROID ? 'btt' : 'rtl'"
    :close-on-click-modal="true"
    :with-header="!IS_ANDROID"
    class="option-picker-drawer"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <div class="option-picker-content">
      <div class="picker-options">
        <div
          v-for="opt in options"
          :key="opt.id"
          class="picker-option"
          @click="handleSelect(opt.id)"
        >
          <div class="option-icon">
            <el-icon :size="32">
              <component :is="opt.icon" />
            </el-icon>
          </div>
          <div class="option-content">
            <div class="option-title">{{ opt.title }}</div>
            <div v-if="opt.desc" class="option-desc">{{ opt.desc }}</div>
          </div>
          <el-icon class="option-arrow">
            <ArrowRight />
          </el-icon>
        </div>
      </div>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import type { Component } from "vue";
import { ArrowRight } from "@element-plus/icons-vue";
import { ElDrawer, ElIcon } from "element-plus";
import { IS_ANDROID } from "@kabegame/core/env";
import { computed } from "vue";
import { useModalBack } from "@kabegame/core/composables/useModalBack";

export interface OptionItem {
  id: string;
  title: string;
  desc?: string;
  icon: Component;
}

interface Props {
  modelValue: boolean;
  title?: string;
  options: OptionItem[];
}

const props = withDefaults(defineProps<Props>(), {
  title: "请选择",
});

const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
  (e: "select", id: string): void;
}>();

const optionPickerOpen = computed({
  get: () => props.modelValue,
  set: (v) => emit("update:modelValue", v),
});
useModalBack(optionPickerOpen);

const handleSelect = (id: string) => {
  emit("select", id);
};
</script>

<style lang="scss" scoped>
.option-picker-drawer {
  :deep(.el-drawer__header) {
    margin-bottom: 20px;
    padding: 20px 20px 0;
  }

  :deep(.el-drawer__body) {
    padding: 20px;
  }

  &:deep(.el-drawer.btt) {
    .el-drawer__body {
      padding-bottom: calc(20px + var(--sab, env(safe-area-inset-bottom, 0px)));
    }
  }
}

.option-picker-content {
  width: 100%;
}

.picker-options {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.picker-option {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px;
  background: var(--anime-bg-card);
  border: 2px solid var(--anime-border);
  border-radius: 16px;
  cursor: pointer;
  transition: all 0.2s ease;
  user-select: none;

  &:hover {
    background: linear-gradient(
      135deg,
      rgba(255, 107, 157, 0.1) 0%,
      rgba(167, 139, 250, 0.1) 100%
    );
    border-color: var(--anime-primary);
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(255, 107, 157, 0.15);
  }

  &:active {
    transform: translateY(0);
  }
}

.option-icon {
  flex-shrink: 0;
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(
    135deg,
    rgba(255, 107, 157, 0.15) 0%,
    rgba(167, 139, 250, 0.15) 100%
  );
  border-radius: 12px;
  color: var(--anime-primary);
}

.option-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.option-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--anime-text-primary);
  line-height: 1.4;
}

.option-desc {
  font-size: 13px;
  color: var(--anime-text-secondary);
  line-height: 1.4;
}

.option-arrow {
  flex-shrink: 0;
  color: var(--anime-text-secondary);
  transition: transform 0.2s ease;
}

.picker-option:hover .option-arrow {
  transform: translateX(4px);
  color: var(--anime-primary);
}
</style>
