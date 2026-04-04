<template>
  <el-switch v-model="localValue" :disabled="props.disabled || disabled" :loading="showDisabled" @change="onChange" />
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useSettingKeyState } from "../../../composables/useSettingKeyState";
import { type AppSettingKey } from "../../../stores/settings";

const props = defineProps<{
  settingKey: AppSettingKey;
  disabled?: boolean;
}>();

const { settingValue, disabled, showDisabled, set } = useSettingKeyState(props.settingKey);
const localValue = ref<boolean>(false);

watch(
  () => settingValue.value,
  (v) => {
    localValue.value = !!v;
  },
  { immediate: true }
);

const onChange = async (v: boolean) => {
  await set(v);
};
</script>

