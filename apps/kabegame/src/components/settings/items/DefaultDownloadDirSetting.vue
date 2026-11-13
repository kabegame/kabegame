<template>
  <div class="w-full">
    <div class="flex min-w-0 items-center gap-2">
      <Input
        v-model="localDir"
        class="min-w-0 flex-1"
        :placeholder="t('settings.defaultDownloadDirPlaceholder')"
        clearable
        :disabled="disabled || showDisabled"
        @clear="handleClear"
      />
      <Button :disabled="disabled || showDisabled" @click="handleChoose">
        <FolderOpen />
        {{ t("settings.defaultDownloadDirChoose") }}
      </Button>
    </div>

    <div class="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-kb-fg-muted">
      {{ t("settings.defaultDownloadDirEffectivePath") }}
      <button
        type="button"
        class="m-0 inline-flex min-w-0 cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-[12px] text-kb-fg [font-family:inherit] hover:underline disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="!effectiveDownloadDir"
        @click="handleOpenEffective"
      >
        <FolderOpen class="size-3.5 shrink-0 text-kb-fg-muted" />
        <span class="inline-block max-w-[420px] truncate align-bottom">
          {{ effectiveDownloadDir || t("settings.defaultDownloadDirUnknown") }}
        </span>
      </button>
      <Button v-if="settingValue" variant="ghost" size="sm" :disabled="disabled || showDisabled" @click="handleClear">
        {{ t("settings.defaultDownloadDirRestore") }}
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { FolderOpen } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import { kameMessage } from "@/utils/kameMessage";
import Button from "@/components/ui/Button.vue";
import Input from "@/components/ui/Input.vue";
import { invoke } from "../../../api";
import { open } from "@tauri-apps/plugin-dialog";
import { useSettingKeyState } from "../../../composables/useSettingKeyState";

const { t } = useI18n();
const { settingValue, disabled, showDisabled, set } = useSettingKeyState("defaultDownloadDir");

const defaultImagesDir = ref<string>("");
const effectiveDownloadDir = computed(() => {
  const custom = settingValue.value as string | null | undefined;
  return custom && custom.trim() ? custom : defaultImagesDir.value || "";
});

const localDir = ref<string>("");
watch(
  () => settingValue.value,
  (v) => {
    localDir.value = (v as any as string | null) || "";
  },
  { immediate: true },
);

onMounted(async () => {
  try {
    defaultImagesDir.value = await invoke<string>("get_default_images_dir");
  } catch {
    defaultImagesDir.value = "";
  }
});

const saveDir = async (dir: string | null) => {
  try {
    await set(dir);
  } catch (e) {
    console.error("保存默认下载目录失败:", e);
    // localDir will be reverted by watch
  }
};

const handleChoose = async () => {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t("settings.defaultDownloadDirChooseTitle"),
    });
    if (!selected || Array.isArray(selected)) return;
    localDir.value = selected;
    await saveDir(selected);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(e);
    kameMessage.error(t("settings.defaultDownloadDirChooseFailed"));
  }
};

const handleClear = async () => {
  localDir.value = "";
  await saveDir(null);
};

const handleOpenEffective = async () => {
  try {
    if (!effectiveDownloadDir.value) return;
    await invoke("open_path", { path: effectiveDownloadDir.value });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("打开目录失败:", e);
    kameMessage.error(t("settings.defaultDownloadDirOpenFailed"));
  }
};
</script>
