<template>
  <el-dialog
    :model-value="modal.isOpen.value"
    :z-index="modal.zIndex.value"
    :title="title"
    width="360px"
    destroy-on-close
    class="setting-choice-dialog"
    @update:model-value="modal.close"
  >
    <div class="setting-choice-options">
      <div
        v-for="opt in options"
        :key="opt.id"
        class="setting-choice-option"
        @click="handleSelect(opt.id)"
      >
        <el-icon>
          <component :is="opt.icon" />
        </el-icon>
        <div class="setting-choice-option-content">
          <div class="setting-choice-option-title">{{ opt.title }}</div>
          <div v-if="opt.desc" class="setting-choice-option-desc">{{ opt.desc }}</div>
        </div>
      </div>
    </div>
    <el-checkbox v-model="keepChecked" class="setting-choice-keep">
      {{ t("common.keepChoiceNextTime") }}
    </el-checkbox>
  </el-dialog>
</template>

<script setup lang="ts">
import { ElCheckbox, ElDialog, ElIcon } from "element-plus";
import { ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { useModal } from "../../composables/useModal";
import type { OptionItem } from "./OptionPickerDrawer.vue";

interface Props {
  modelValue: boolean;
  title?: string;
  options: OptionItem[];
}

const props = withDefaults(defineProps<Props>(), {
  title: undefined,
});
const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
  (e: "select", payload: { id: string; persist: boolean }): void;
}>();
const { t } = useI18n();
const keepChecked = ref(false);

const modal = useModal({ onClose: () => emit("update:modelValue", false) });
watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      keepChecked.value = false;
      modal.open();
    } else {
      modal.close();
    }
  },
  { immediate: true },
);

function handleSelect(id: string) {
  emit("select", { id, persist: keepChecked.value });
}
</script>

<style scoped>
.setting-choice-options {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.setting-choice-option {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border: 2px solid var(--anime-border);
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.setting-choice-option:hover {
  border-color: var(--anime-primary);
  background: var(--el-fill-color-light);
}

.setting-choice-option .el-icon {
  flex-shrink: 0;
  font-size: 20px;
  color: var(--anime-primary);
}

.setting-choice-option-content {
  min-width: 0;
}

.setting-choice-option-title {
  line-height: 1.4;
}

.setting-choice-option-desc {
  margin-top: 2px;
  color: var(--anime-text-secondary);
  font-size: 12px;
  line-height: 1.4;
}

.setting-choice-keep {
  margin-top: 16px;
}
</style>
