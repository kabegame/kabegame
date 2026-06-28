<template>
  <div class="gallery-page-size-setting">
    <el-radio-group
      :model-value="localValue"
      :disabled="disabled"
      :loading="showDisabled"
      @change="onChange"
    >
      <el-radio v-for="n in options" :key="n" :value="n">{{ n }}</el-radio>
    </el-radio-group>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";

const options = [100, 500, 1000] as const;

const { settingValue, set, disabled, showDisabled } = useSettingKeyState("galleryPageSize");
const localValue = computed(
  () => (settingValue.value as number | undefined) ?? 100,
);

const onChange = async (v: string | number | boolean | undefined) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return;
  if (n !== 100 && n !== 500 && n !== 1000) return;
  await set(n, {
    source: location.pathname === "/settings" ? "settings_page" : "quick_settings_drawer",
  });
};
</script>

<style scoped lang="scss">
.gallery-page-size-setting {
  width: 100%;
}
</style>
