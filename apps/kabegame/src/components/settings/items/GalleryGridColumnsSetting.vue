<template>
  <div class="gallery-grid-columns-setting">
    <div class="controls-row">
      <span class="label">{{ $t("settings.fixedColumns") }}</span>
      <el-switch
        :model-value="fixedModeEnabled"
        :disabled="disabled"
        :loading="showDisabled"
        @change="onToggleFixedMode"
      />
      <KbNumber
        v-if="fixedModeEnabled"
        v-model="inputColumns"
        type="int"
        class="!w-[120px]"
        :min="1"
        :max="6"
        :disabled="disabled"
        @change="onFixedColumnsChange"
      />
    </div>
    <div class="hint">
      {{ $t("settings.fixedColumnsHint") }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useSettingKeyState } from "@/composables/useSettingKeyState";
import { useUiStore } from "@/stores/ui";
import KbNumber from "@/components/common/form/KbNumber.vue";

const { settingValue, disabled, showDisabled, set } = useSettingKeyState("galleryGridColumns");
const uiStore = useUiStore();

const clampFixedColumns = (value: number) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 4;
  return Math.min(6, Math.max(1, Math.round(n)));
};

const fixedColumns = ref(4);
/** 输入框的原始值：编辑中可能是非法文本（string），提交后回到 fixedColumns */
const inputColumns = ref<number | string | undefined>(4);

const fixedModeEnabled = computed(() => {
  const current = Number(settingValue.value ?? 0);
  return Number.isFinite(current) && current > 0;
});

watch(
  () => settingValue.value,
  (v) => {
    const n = Number(v ?? 0);
    if (Number.isFinite(n) && n > 0) {
      fixedColumns.value = clampFixedColumns(n);
      inputColumns.value = fixedColumns.value;
    }
  },
  { immediate: true },
);

const onToggleFixedMode = async (enabled: boolean | string | number) => {
  if (typeof enabled !== "boolean") return;
  if (!enabled) {
    await set(0);
    return;
  }
  const next = clampFixedColumns(fixedColumns.value || uiStore.imageGridColumns);
  await set(next);
  uiStore.imageGridColumns = next;
};

const onFixedColumnsChange = async (value: number | undefined) => {
  if (!fixedModeEnabled.value) return;
  // 非法文本回退；值未变（如回车后再失焦）不重复保存
  if (typeof value !== "number" || !Number.isFinite(value) || clampFixedColumns(value) === fixedColumns.value) {
    inputColumns.value = fixedColumns.value;
    return;
  }
  const next = clampFixedColumns(value);
  fixedColumns.value = next;
  inputColumns.value = next;
  await set(next);
  uiStore.imageGridColumns = next;
};
</script>

<style scoped lang="scss">
.gallery-grid-columns-setting {
  width: 100%;
}

.controls-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.label {
  color: var(--anime-text-color);
  font-size: 13px;
}

.hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--anime-text-muted);
}
</style>
