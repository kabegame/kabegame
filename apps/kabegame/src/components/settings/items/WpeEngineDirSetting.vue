<template>
  <div class="w-full">
    <div class="flex min-w-0 items-center gap-2">
      <Input
        :model-value="dir"
        class="min-w-0 flex-1"
        :placeholder="$t('settings.wpeEngineDirPlaceholder')"
        :title="dir || undefined"
        readonly
        :disabled="disabled"
      />
      <Button :disabled="disabled || showDisabled" @click="handleChoose">
        <FolderOpen />
        {{ $t("settings.defaultDownloadDirChoose") }}
      </Button>
    </div>
    <Button v-if="dir" class="mt-2" variant="ghost" size="sm" :disabled="disabled" @click="save(null)">
      {{ $t("settings.defaultDownloadDirRestore") }}
    </Button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import { kameMessage } from "@/utils/kameMessage";
import { FolderOpen } from "@lucide/vue";
import Button from "@/components/ui/Button.vue";
import Input from "@/components/ui/Input.vue";
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
