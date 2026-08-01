<template>
  <KbSegmentedControl
    :model-value="radioValue"
    :options="options"
    :disabled="props.disabled || disabled || showDisabled"
    @update:model-value="onChange"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useSettingKeyState } from "../../../composables/useSettingKeyState";
import { type AppSettingKey } from "../../../stores/settings";
import KbSegmentedControl from "../../common/form/KbSegmentedControl.vue";

type Option = { label: string; value: string };

const props = defineProps<{
  settingKey: AppSettingKey;
  options: Option[];
  disabled?: boolean;
}>();

const { settingValue, disabled, showDisabled, set } = useSettingKeyState(props.settingKey);
const radioValue = computed(() => settingValue.value == null ? "" : String(settingValue.value));

const onChange = async (v: string) => {
  await set(v);
};
</script>

