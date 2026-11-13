<template>
  <div class="flex min-w-0 items-center gap-2">
    <Input
      class="min-w-0 flex-1"
      :model-value="modelValue || ''"
      :placeholder="placeholder"
      clearable
      @update:model-value="onInput"
    />
    <Button variant="outline" size="md" class="shrink-0" @click="pickDir">
      <FolderOpen />
      {{ $t("common.chooseFolder") }}
    </Button>
  </div>
</template>

<script setup lang="ts">
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "@lucide/vue";
import Button from "@/components/ui/Button.vue";
import Input from "@/components/ui/Input.vue";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";

withDefaults(
  defineProps<{
    modelValue?: string;
    placeholder?: string;
  }>(),
  { placeholder: "" },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const onInput = (v: string) => {
  emit("update:modelValue", v ?? "");
};

const pickDir = async () => {
  if (await guardDesktopOnly("openLocal")) return;
  try {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      emit("update:modelValue", selected);
    }
  } catch (e) {
    console.error("选择目录失败:", e);
  }
};
</script>
