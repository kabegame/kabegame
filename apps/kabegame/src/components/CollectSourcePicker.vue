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
import { FolderOpened, Connection, Link } from "@kabegame/element-plus-icons";
import { IS_WEB } from "@kabegame/core/env";
import OptionPickerDrawer from "@kabegame/core/components/common/OptionPickerDrawer.vue";
import type { OptionItem } from "@kabegame/core/components/common/OptionPickerDrawer.vue";

interface Props {
  modelValue: boolean;
  title?: string;
}

type CollectSource = "local" | "remote" | "webpage";

const props = withDefaults(defineProps<Props>(), {
  title: undefined,
});
const { t } = useI18n();
const resolvedTitle = computed(() => props.title ?? t('gallery.chooseCollectMethod'));

const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
  (e: "select", source: CollectSource): void;
}>();

const sourceOptions = computed<OptionItem[]>(() => [
  ...(!IS_WEB ? [{
    id: "local",
    title: t('gallery.local'),
    desc: t('gallery.localDesc'),
    icon: FolderOpened,
  }] : []),
  {
    id: "remote",
    title: t('gallery.network'),
    desc: t('gallery.remoteDesc'),
    icon: Connection,
  },
  ...(!IS_WEB ? [{
    id: "webpage",
    title: t('gallery.webpage'),
    desc: t('gallery.webpageDesc'),
    icon: Link,
  }] : []),
]);

const handleSelect = (id: string) => {
  if (id === "local" || id === "remote" || id === "webpage") {
    emit("select", id);
  }
};
</script>
