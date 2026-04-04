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
import { FolderOpened, Connection } from "@element-plus/icons-vue";
import OptionPickerDrawer from "@/components/common/OptionPickerDrawer.vue";
import type { OptionItem } from "@/components/common/OptionPickerDrawer.vue";

interface Props {
  modelValue: boolean;
  title?: string;
}

const props = withDefaults(defineProps<Props>(), {
  title: undefined,
});
const { t } = useI18n();
const resolvedTitle = computed(() => props.title ?? t('gallery.chooseCollectMethod'));

const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
  (e: "select", source: "local" | "remote"): void;
}>();

const sourceOptions = computed<OptionItem[]>(() => [
  {
    id: "local",
    title: t('gallery.local'),
    desc: t('gallery.localDesc'),
    icon: FolderOpened,
  },
  {
    id: "remote",
    title: t('gallery.network'),
    desc: t('gallery.remoteDesc'),
    icon: Connection,
  },
]);

const handleSelect = (id: string) => {
  if (id === "local" || id === "remote") {
    emit("select", id);
  }
};
</script>
