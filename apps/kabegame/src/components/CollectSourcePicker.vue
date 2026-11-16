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
/** 紧凑档「开始收集」的选择层：本地 / 网络两组（Web 没有本地，那时调用方直接打开网络、不弹这一层） */
import { computed } from "vue";
import { useI18n } from "@kabegame/i18n";
import { FolderOpen, Globe } from "@lucide/vue";
import OptionPickerDrawer from "@/components/common/OptionPickerDrawer.vue";
import type { OptionItem } from "@/components/common/OptionPickerDrawer.vue";
import { LOCAL_SOURCES, type CollectGroup } from "@/stores/collectDialogs";

interface Props {
  modelValue: boolean;
  title?: string;
}

const props = withDefaults(defineProps<Props>(), {
  title: undefined,
});
const { t } = useI18n();
const resolvedTitle = computed(() => props.title ?? t("gallery.chooseCollectMethod"));

const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
  (e: "select", group: CollectGroup): void;
}>();

const sourceOptions = computed<OptionItem[]>(() => [
  ...(LOCAL_SOURCES.length
    ? [
        {
          id: "local",
          title: t("gallery.local"),
          desc: t("gallery.localDesc"),
          icon: FolderOpen,
        },
      ]
    : []),
  {
    id: "network",
    title: t("gallery.network"),
    desc: t("gallery.remoteDesc"),
    icon: Globe,
  },
]);

const handleSelect = (id: string) => {
  if (id === "local" || id === "network") {
    emit("select", id);
  }
};
</script>
