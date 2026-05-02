<template>
  <div class="rotation-target-setting">
    <AlbumPickerField
      :model-value="pickerAlbumId"
      :album-tree="albumStore.albumTree"
      :album-counts="albumStore.albumCounts"
      :prepend-options="rotationPrependOptions"
      :disabled="disabled || keyDisabled || wallpaperModeSwitching"
      :placeholder="t('settings.rotationTargetPlaceholder')"
      :picker-title="t('settings.rotationTargetTitle')"
      :clearable="false"
      @update:model-value="onPickerAlbumId"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useI18n } from "@kabegame/i18n";
import { ElMessage } from "element-plus";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import AlbumPickerField from "@kabegame/core/components/album/AlbumPickerField.vue";
import { useAlbumStore } from "@/stores/albums";
import { useUiStore } from "@kabegame/core/stores/ui";

const { t } = useI18n();

const props = defineProps<{
  disabled?: boolean;
}>();

const albumStore = useAlbumStore();
const { wallpaperModeSwitching } = useUiStore();

const { settingValue, set, disabled: keyDisabled } = useSettingKeyState("wallpaperRotationAlbumId");

/** 安卓 AndroidPickerSelect 将 value === "" 视为清空并 emit null，故「全部画廊」用哨兵，落库仍为空字符串 */
const WALLPAPER_ROTATION_ALL_GALLERY = "__kabegame_wallpaper_all_gallery__";

/** 与 CrawlerDialog 输出画册一致：树选；首项「全部画廊」对应空字符串 */
const rotationPrependOptions = computed(() => [
  { value: WALLPAPER_ROTATION_ALL_GALLERY, label: t("settings.rotationTargetAllGallery") },
]);

const pickerAlbumId = computed((): string | null => {
  const v = settingValue.value;
  if (v === null || v === undefined) return WALLPAPER_ROTATION_ALL_GALLERY;
  const s = String(v).trim();
  return s === "" ? WALLPAPER_ROTATION_ALL_GALLERY : s;
});

onMounted(() => {
  albumStore.loadAlbums();
});

const onPickerAlbumId = async (v: string | null) => {
  if (props.disabled || keyDisabled.value) return;
  try {
    if (v === null || v === undefined || v === WALLPAPER_ROTATION_ALL_GALLERY) {
      await set("");
      return;
    }
    await set(String(v));
  } catch (e: any) {
    ElMessage.error(t("settings.messageSetFailed", { msg: e?.message || String(e) }));
  }
};
</script>

<style scoped lang="scss">
.rotation-target-setting {
  width: 100%;
  min-width: 0;
}
</style>
