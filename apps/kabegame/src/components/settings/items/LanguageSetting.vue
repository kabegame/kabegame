<template>
  <!-- 紧凑档：底部滚轮选择（与其它设置项的 AndroidPickerSelect 同一个触发条与弹层） -->
  <AndroidPickerSelect
    v-if="uiStore.isCompact"
    :model-value="effectiveLocale"
    :options="options"
    :title="$t('settings.language')"
    :placeholder="$t('settings.language')"
    :disabled="props.disabled || disabled"
    @update:model-value="(v) => v && handleChange(v)"
  />
  <Select
    v-else
    :model-value="effectiveLocale"
    :options="options"
    :placeholder="$t('settings.language')"
    class="!w-[180px]"
    :disabled="props.disabled || disabled"
    @update:model-value="(v) => v && handleChange(v)"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { SUPPORTED_LANGUAGES, resolveLanguage } from "@kabegame/i18n";
import AndroidPickerSelect from "@/components/AndroidPickerSelect.vue";
import Select from "@/components/ui/Select.vue";
import { useSettingKeyState } from "@/composables/useSettingKeyState";
import { useUiStore } from "@/stores/ui";

const props = defineProps<{
  disabled?: boolean;
}>();

const { settingValue, disabled, set } = useSettingKeyState("language");

const options = computed(() => SUPPORTED_LANGUAGES.map((l) => ({ label: l.label, value: l.value as string })));

const uiStore = useUiStore();

/** 与解析链一致，保证选项中始终有合法选中值 */
const effectiveLocale = computed<string>(() => resolveLanguage(settingValue.value as string | null | undefined));

function handleChange(v: string) {
  if (v === effectiveLocale.value) return;
  void set(v);
}
</script>
