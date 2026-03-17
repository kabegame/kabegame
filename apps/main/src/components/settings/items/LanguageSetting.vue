<template>
  <AndroidPickerSelect
    v-if="IS_ANDROID"
    :model-value="pickerModelValue"
    :options="pickerOptions"
    :title="$t('settings.language')"
    :placeholder="$t('settings.language')"
    :disabled="props.disabled || disabled"
    @update:model-value="onPickerChange"
  />
  <el-select
    v-else
    :model-value="(settingValue as string | null | undefined) ?? SYSTEM_VALUE"
    :placeholder="$t('settings.language')"
    style="min-width: 180px"
    :disabled="props.disabled || disabled"
    @change="handleChange"
  >
    <el-option
      v-for="opt in options"
      :key="String(opt.value ?? '')"
      :label="opt.label"
      :value="opt.value"
    />
  </el-select>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { IS_ANDROID } from "@kabegame/core/env";
import AndroidPickerSelect from "@kabegame/core/components/AndroidPickerSelect.vue";
import { SUPPORTED_LANGUAGES } from "@/i18n";

const props = defineProps<{
  disabled?: boolean;
}>();

const { settingValue, disabled, set } = useSettingKeyState("language");

const SYSTEM_VALUE = "";

const options = computed(() => [
  { label: "跟随系统", value: SYSTEM_VALUE },
  ...SUPPORTED_LANGUAGES.map((l) => ({ label: l.label, value: l.value })),
]);

const pickerModelValue = computed(() => {
  const v = settingValue.value as string | null | undefined;
  return !v || v === "" ? SYSTEM_VALUE : v;
});

const pickerOptions = computed(() =>
  options.value.map((o) => ({
    text: o.label,
    value: o.value,
  }))
);

function handleChange(v: string) {
  void set(v === SYSTEM_VALUE ? null : v);
}

function onPickerChange(v: string) {
  void set(v === SYSTEM_VALUE ? null : v);
}
</script>
