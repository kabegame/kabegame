<template>
  <OptionPickerDrawer
    :model-value="modelValue"
    :title="title"
    :options="sourceOptions"
    @update:model-value="$emit('update:modelValue', $event)"
    @select="handleSelect"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { FolderOpened, Connection } from "@element-plus/icons-vue";
import OptionPickerDrawer from "@/components/common/OptionPickerDrawer.vue";
import type { OptionItem } from "@/components/common/OptionPickerDrawer.vue";

interface Props {
  modelValue: boolean;
  title?: string;
}

const props = withDefaults(defineProps<Props>(), {
  title: "选择收集方式",
});

const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
  (e: "select", source: "local" | "remote"): void;
}>();

const sourceOptions = computed<OptionItem[]>(() => [
  {
    id: "local",
    title: "本地",
    desc: "从本机选择图片、文件夹或压缩文件导入",
    icon: FolderOpened,
  },
  {
    id: "remote",
    title: "远程",
    desc: "使用插件从网络收集图片",
    icon: Connection,
  },
]);

const handleSelect = (id: string) => {
  if (id === "local" || id === "remote") {
    emit("select", id);
  }
};
</script>
