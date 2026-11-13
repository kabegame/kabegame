<template>
  <div class="flex items-center gap-1">
    <Switch
      v-model="localValue"
      :disabled="props.disabled || disabled || showDisabled || wallpaperModeSwitching"
      @update:model-value="handleChange"
    />
    <!-- 电池优化提示（只有 Android）：触屏上提示不弹，点按直接走引导 -->
    <Tooltip v-if="IS_ANDROID && isOptimized" :content="$t('common.batteryOptimizationTooltip')" side="top">
      <button
        type="button"
        class="grid size-7 shrink-0 cursor-pointer place-items-center rounded-kb-md border-0 bg-transparent p-0 text-kb-warning outline-none hover:bg-kb-hover focus-visible:ring-2 focus-visible:ring-kb-ring"
        :aria-label="$t('common.batteryOptimizationTooltip')"
        @click="onBatteryIconClick"
      >
        <Zap class="size-[18px]" />
      </button>
    </Tooltip>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { Zap } from "@lucide/vue";
import Switch from "@/components/ui/Switch.vue";
import Tooltip from "@/components/ui/Tooltip.vue";
import { useSettingKeyState } from "@/composables/useSettingKeyState";
import { useUiStore } from "@/stores/ui";
import { IS_ANDROID } from "@/env";
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
  { immediate: true },
);

const handleChange = async (value: boolean) => {
  if (value) {
    await batteryStore.checkAndPromptIfNeeded();
  }

  await set(value);
};
</script>
