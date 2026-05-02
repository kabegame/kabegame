<template>
  <template v-if="uiStore.isCompact">
    <div
      class="android-picker-select language-setting-android"
      :class="{ 'is-disabled': props.disabled || disabled }"
      @click="onAndroidTriggerClick"
    >
      <span class="android-picker-select__value">{{ displayLanguageLabel }}</span>
      <el-icon class="android-picker-select__arrow">
        <ArrowDown />
      </el-icon>
    </div>
    <Teleport to="body">
      <van-popup v-model:show="showLanguagePicker" position="bottom" round>
        <van-picker
          v-model="languagePickerSelected"
          :title="$t('settings.language')"
          :columns="languagePickerColumns"
          :confirm-button-text="$t('common.confirm')"
          :cancel-button-text="$t('common.cancel')"
          @confirm="onLanguagePickerConfirm"
          @cancel="showLanguagePicker = false"
        />
      </van-popup>
    </Teleport>
  </template>
  <el-select
    v-else
    :model-value="effectiveLocale"
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
import { computed, ref, watch } from "vue";
import { ArrowDown } from "@element-plus/icons-vue";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { useModalBack } from "@kabegame/core/composables/useModalBack";
import { SUPPORTED_LANGUAGES, resolveLanguage } from "@kabegame/i18n";
import { useUiStore } from "@kabegame/core/stores/ui";

const props = defineProps<{
  disabled?: boolean;
}>();

const { settingValue, disabled, set } = useSettingKeyState("language");

const options = computed(() =>
  SUPPORTED_LANGUAGES.map((l) => ({ label: l.label, value: l.value })),
);

const uiStore = useUiStore();

/** 与解析链一致，保证选项中始终有合法选中值 */
const effectiveLocale = computed(() =>
  resolveLanguage(settingValue.value as string | null | undefined),
);

const displayLanguageLabel = computed(() => {
  const v = effectiveLocale.value;
  const opt = options.value.find((o) => o.value === v);
  return opt?.label ?? v;
});

const languagePickerColumns = computed(() =>
  options.value.map((o) => ({ text: o.label, value: o.value })),
);

const showLanguagePicker = ref(false);
useModalBack(showLanguagePicker);

const languagePickerSelected = ref<string[]>([effectiveLocale.value]);

watch(showLanguagePicker, (open) => {
  if (open) languagePickerSelected.value = [effectiveLocale.value];
});

watch(
  () => [effectiveLocale.value, showLanguagePicker.value] as const,
  () => {
    if (showLanguagePicker.value) {
      languagePickerSelected.value = [effectiveLocale.value];
    }
  }
);

function onAndroidTriggerClick() {
  if (props.disabled || disabled.value) return;
  showLanguagePicker.value = true;
}

function onLanguagePickerConfirm({
  selectedValues,
}: {
  selectedValues: (string | number)[];
}) {
  showLanguagePicker.value = false;
  const raw = selectedValues[0];
  if (raw === null || raw === undefined) return;
  void set(String(raw));
}

function handleChange(v: string) {
  void set(v);
}
</script>

<style scoped lang="scss">
/* 与 AndroidPickerSelect 触发条一致 */
.language-setting-android.android-picker-select {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  min-height: 32px;
  padding: 6px 12px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-base);
  background: var(--el-fill-color-blank);
  cursor: pointer;
  user-select: none;

  &.is-disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
}

.android-picker-select__value {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  color: var(--anime-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.android-picker-select__arrow {
  flex-shrink: 0;
  margin-left: 8px;
  font-size: 14px;
  color: var(--anime-text-secondary);
}
</style>
