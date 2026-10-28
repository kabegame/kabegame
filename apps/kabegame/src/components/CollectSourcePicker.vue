<template>
  <OptionPickerDrawer
    :model-value="modelValue"
    :title="resolvedTitle"
    :options="sourceOptions"
    @update:model-value="$emit('update:modelValue', $event)"
    @select="handleSelect"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import { FolderOpened, Connection, Link, Picture } from "@kabegame/element-plus-icons";
import { IS_ANDROID, IS_WEB } from "@/env";
import OptionPickerDrawer from "@/components/common/OptionPickerDrawer.vue";
import type { OptionItem } from "@/components/common/OptionPickerDrawer.vue";

interface Props {
  modelValue: boolean;
  title?: string;
}

type CollectSource = "local" | "remote" | "webpage" | "wallpaper";

const props = withDefaults(defineProps<Props>(), {
  title: undefined,
});
const { t } = useI18n();
const resolvedTitle = computed(() => props.title ?? t("gallery.chooseCollectMethod"));

const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
  (e: "select", source: CollectSource): void;
}>();

const sourceOptions = computed<OptionItem[]>(() => [
  ...(!IS_WEB
    ? [
        {
          id: "local",
          title: t("gallery.local"),
          desc: t("gallery.localDesc"),
          icon: FolderOpened,
        },
      ]
    : []),
  {
    id: "remote",
    title: t("gallery.network"),
    desc: t("gallery.remoteDesc"),
    icon: Connection,
  },
  ...(!IS_WEB
    ? [
        {
          id: "webpage",
          title: t("gallery.webpage"),
          desc: t("gallery.webpageDesc"),
          icon: Link,
        },
      ]
    : []),
  ...(!IS_WEB && !IS_ANDROID
    ? [
        {
          id: "wallpaper",
          title: t("gallery.wallpaper"),
          desc: t("gallery.wallpaperDesc"),
          icon: Picture,
        },
      ]
    : []),
]);

const handleSelect = (id: string) => {
  if (id === "local" || id === "remote" || id === "webpage" || id === "wallpaper") {
    emit("select", id);
  }
};
</script>
