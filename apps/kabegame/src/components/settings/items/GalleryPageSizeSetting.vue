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
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { IS_WEB } from "@kabegame/core/env";
import { trackEvent } from "@kabegame/core/track/umami";

const options = [100, 500, 1000] as const;
const disabled = false;
const showDisabled = false;

const settings = useSettingsStore();
const localValue = computed(
  () => (settings.values.galleryPageSize as number | undefined) ?? 100,
);

const onChange = (v: string | number | boolean | undefined) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return;
  if (n !== 100 && n !== 500 && n !== 1000) return;
  void settings.save("galleryPageSize", n).then(() => {
    if (!IS_WEB) return;
    trackEvent("setting_change", {
      key: "galleryPageSize",
      value: n,
      url: location.pathname + location.search,
      source: location.pathname === "/settings" ? "settings_page" : "quick_settings_drawer",
    });
  });
};
</script>

<style scoped lang="scss">
.gallery-page-size-setting {
  width: 100%;
}
</style>
