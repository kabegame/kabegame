<template>
  <div class="w-full">
    <el-input :model-value="dir" :placeholder="$t('settings.wpeEngineDirPlaceholder')" readonly :disabled="disabled">
      <template #append>
        <el-button :disabled="disabled" :loading="showDisabled" @click="handleChoose">
          <el-icon>
            <FolderOpened />
          </el-icon>
          {{ $t("settings.defaultDownloadDirChoose") }}
        </el-button>
      </template>
    </el-input>
    <el-button v-if="dir" class="mt-2" link type="warning" :disabled="disabled" @click="save(null)">
      {{ $t("settings.defaultDownloadDirRestore") }}
    </el-button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import { kameMessage } from "@/utils/kameMessage";
import { FolderOpened } from "@kabegame/element-plus-icons";
import { open } from "@tauri-apps/plugin-dialog";
import { useSettingKeyState } from "../../../composables/useSettingKeyState";

const { t } = useI18n();
const { settingValue, disabled, showDisabled, set } = useSettingKeyState("wpeEngineDir");

const dir = computed(() => settingValue.value ?? "");

const save = async (value: string | null) => {
  try {
    await set(value);
  } catch {
    // 后端只会因为选的文件夹不是 WPE 目录而拒绝
    kameMessage.error(t("settings.wpeEngineDirInvalid"));
  }
};

const handleChoose = async () => {
  const selected = await open({
    directory: true,
    multiple: false,
    title: t("settings.wpeEngineDirChooseTitle"),
  });
  if (selected && !Array.isArray(selected)) await save(selected);
};
</script>
