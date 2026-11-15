<template>
  <!-- 六个档位，项多用下拉；紧凑档用底部滚轮（与语言设置同一套） -->
  <AndroidPickerSelect
    v-if="uiStore.isCompact"
    :model-value="current"
    :options="options"
    :title="$t('settings.wpeSceneShadows')"
    :placeholder="$t('settings.wpeSceneShadows')"
    :disabled="props.disabled || disabled"
    @update:model-value="(v) => v && handleChange(v)"
  />
  <Select
    v-else
    :model-value="current"
    :options="options"
    :placeholder="$t('settings.wpeSceneShadows')"
    class="!w-[180px]"
    :disabled="props.disabled || disabled"
    @update:model-value="(v) => v && handleChange(v)"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import AndroidPickerSelect from "@/components/AndroidPickerSelect.vue";
import Select from "@/components/ui/Select.vue";
import { useSettingKeyState } from "@/composables/useSettingKeyState";
import { useUiStore } from "@/stores/ui";

const props = defineProps<{
  disabled?: boolean;
}>();

const { t } = useI18n();
const { settingValue, disabled, set } = useSettingKeyState("wpeSceneShadows");
const uiStore = useUiStore();

const options = computed(() => [
  { label: t("settings.wpeSceneShadowsFollow"), value: "follow" },
  { label: t("settings.wpeSceneShadowsDisabled"), value: "disabled" },
  { label: t("settings.wpeSceneShadowsLow"), value: "low" },
  { label: t("settings.wpeSceneShadowsMedium"), value: "medium" },
  { label: t("settings.wpeSceneShadowsHigh"), value: "high" },
  { label: t("settings.wpeSceneShadowsUltra"), value: "ultra" },
]);

const current = computed<string>(() => (settingValue.value as string | undefined) ?? "follow");

function handleChange(v: string) {
  if (v === current.value) return;
  void set(v);
}
</script>
