<template>
  <div class="flex items-center gap-1">
    <el-switch v-model="localValue" :disabled="props.disabled || disabled || wallpaperModeSwitching"
      :loading="showDisabled" @change="handleChange" />
    <el-tooltip v-if="IS_ANDROID && isOptimized" :content="$t('common.batteryOptimizationTooltip')" placement="top">
      <el-button link type="warning" class="!p-1 shrink-0" @click="onBatteryIconClick">
        <el-icon :size="18"><Lightning /></el-icon>
      </el-button>
    </el-tooltip>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { Lightning } from "@element-plus/icons-vue";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { useUiStore } from "@kabegame/core/stores/ui";
import { IS_ANDROID } from "@kabegame/core/env";
import { useBatteryOptimizationStore } from "@/stores/batteryOptimization";

const props = defineProps<{
  disabled?: boolean;
}>();

const { settingValue, disabled, showDisabled, set } = useSettingKeyState("wallpaperRotationEnabled");
const localValue = ref(false);

const { wallpaperModeSwitching } = useUiStore();

const batteryStore = useBatteryOptimizationStore();
const { isOptimized } = storeToRefs(batteryStore);

async function onBatteryIconClick() {
  await batteryStore.checkAndPromptIfNeeded({ force: true });
}

watch(
  () => settingValue.value,
  (v) => {
    localValue.value = !!v;
  },
  { immediate: true }
);

const handleChange = async (value: boolean) => {
  if (value) {
    await batteryStore.checkAndPromptIfNeeded();
  }

  await set(value);
};
</script>