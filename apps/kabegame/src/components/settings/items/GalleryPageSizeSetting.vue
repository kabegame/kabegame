<template>
  <!-- 与其他设置一致用方框分段切换；不套外层容器，否则会破坏 SettingRow 的右对齐 -->
  <SegmentedControl
    :model-value="localValue"
    :options="segmentOptions"
    :disabled="disabled || showDisabled"
    @update:model-value="onChange"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import SegmentedControl from "@kabegame/core/components/settings/controls/SegmentedControl.vue";

const options = [100, 500, 1000] as const;

const { settingValue, set, disabled, showDisabled } = useSettingKeyState("galleryPageSize");
// SegmentedControl 以字符串比对选中项，这里统一用字符串，落库前再转回数字
const localValue = computed(
  () => String((settingValue.value as number | undefined) ?? 100),
);
const segmentOptions = computed(() =>
  options.map((n) => ({ label: String(n), value: String(n) })),
);

const onChange = async (v: string) => {
  const n = Number(v);
  if (n !== 100 && n !== 500 && n !== 1000) return;
  await set(n, {
    source: location.pathname === "/settings" ? "settings_page" : "settings_dialog",
  });
};
</script>
