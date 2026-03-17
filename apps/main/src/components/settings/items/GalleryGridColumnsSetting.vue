<template>
  <div class="gallery-grid-columns-setting">
    <div class="controls-row">
      <span class="label">{{ $t('settings.fixedColumns') }}</span>
      <el-switch
        :model-value="fixedModeEnabled"
        :disabled="disabled"
        :loading="showDisabled"
        @change="onToggleFixedMode"
      />
      <el-input-number
        v-if="fixedModeEnabled"
        v-model="fixedColumns"
        :min="1"
        :max="4"
        :step="1"
        :disabled="disabled"
        :controls="true"
        @change="onFixedColumnsChange"
      />
    </div>
    <div class="hint">
      {{ $t('settings.fixedColumnsHint') }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { useUiStore } from "@kabegame/core/stores/ui";

const { settingValue, disabled, showDisabled, set } = useSettingKeyState("galleryGridColumns");
const uiStore = useUiStore();

const clampFixedColumns = (value: number) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 4;
  return Math.min(4, Math.max(1, Math.round(n)));
};

const fixedColumns = ref(4);

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
    }
  },
  { immediate: true }
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
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  const next = clampFixedColumns(value);
  fixedColumns.value = next;
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
