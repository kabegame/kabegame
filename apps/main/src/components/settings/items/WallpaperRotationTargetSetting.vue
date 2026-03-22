<template>
  <div class="rotation-target-setting">
    <div class="select-row">
      <AndroidPickerSelect
        v-if="IS_ANDROID"
        :model-value="albumPickerValue"
        :options="albumPickerOptions"
        :title="t('settings.rotationTargetTitle')"
        :placeholder="t('settings.rotationTargetPlaceholder')"
        :disabled="disabled || keyDisabled || wallpaperModeSwitching"
        @update:model-value="(v) => handleAlbumChange(v ?? '')"
      />
      <el-select
        v-else
        :modelValue="settingValue"
        class="album-select"
        :loading="albumStore.loading || showDisabled"
        :disabled="disabled || keyDisabled || wallpaperModeSwitching"
        :placeholder="t('settings.rotationTargetPlaceholder')"
        style="min-width: 180px"
        @change="handleAlbumChange"
      >
        <el-option value="">
          <div class="gallery-option">
            <div class="gallery-option__title">{{ t('settings.rotationTargetAllGallery') }}</div>
            <div class="gallery-option__desc">{{ t('settings.rotationTargetAllGalleryDesc') }}</div>
          </div>
        </el-option>
        <el-option v-for="a in albumStore.albums" :key="a.id" :label="a.name" :value="a.id" />
      </el-select>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useI18n } from "@kabegame/i18n";
import { ElMessage } from "element-plus";
import { useSettingKeyState } from "@kabegame/core/composables/useSettingKeyState";
import { IS_ANDROID } from "@kabegame/core/env";
import AndroidPickerSelect from "@kabegame/core/components/AndroidPickerSelect.vue";
import { useAlbumStore } from "@/stores/albums";
import { useUiStore } from "@kabegame/core/stores/ui";

const { t } = useI18n();

const props = defineProps<{
  disabled?: boolean;
}>();

const albumStore = useAlbumStore();
const { wallpaperModeSwitching } = useUiStore();

const {
  settingValue,
  set,
  disabled: keyDisabled,
  showDisabled
} = useSettingKeyState("wallpaperRotationAlbumId");

const albumPickerValue = computed(() => (settingValue.value as string) ?? "");
const albumPickerOptions = computed(() => [
  { label: t("settings.rotationTargetAllGallery"), value: "" },
  ...albumStore.albums.map((a) => ({ label: a.name, value: a.id })),
]);

onMounted(() => {
  albumStore.loadAlbums();
});

const handleAlbumChange = async (value: string) => {
  if (props.disabled || keyDisabled.value) return;
  try {
    await set(value);
  } catch (e: any) {
    ElMessage.error(t("settings.messageSetFailed", { msg: e?.message || String(e) }));
  }
};
</script>

<style scoped lang="scss">
.rotation-target-setting {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.select-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.album-select {
  flex: 1;
}

.gallery-option {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}

.gallery-option__title {
  font-weight: 600;
}

.gallery-option__desc {
  font-size: 12px;
  color: var(--anime-text-muted);
  margin-top: 2px;
}
</style>
