<template>
  <el-input :model-value="valueForInput" :placeholder="placeholder" :clearable="allowUnset"
    @update:model-value="$emit('update:modelValue', $event)">
    <template v-if="type === 'file_or_folder' || type === 'path'" #append>
      <el-dropdown trigger="click" @command="handleCommand">
        <el-button>
          <el-icon>
            <FolderOpened />
          </el-icon>
          浏览
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="file">选择文件</el-dropdown-item>
            <el-dropdown-item command="folder">选择文件夹</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </template>

    <template v-else-if="type === 'file'" #append>
      <el-button @click="pickFile">
        <el-icon>
          <FolderOpened />
        </el-icon>
        选择文件
      </el-button>
    </template>

    <template v-else-if="type === 'folder'" #append>
      <el-button @click="pickFolder">
        <el-icon>
          <FolderOpened />
        </el-icon>
        选择
      </el-button>
    </template>
  </el-input>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { FolderOpened } from "@element-plus/icons-vue";
import { open } from "@tauri-apps/plugin-dialog";

const props = withDefaults(
  defineProps<{
    type: "path" | "file_or_folder" | "file" | "folder";
    modelValue: unknown;
    fileExtensions?: string[];
    placeholder?: string;
    allowUnset?: boolean;
  }>(),
  { allowUnset: false }
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const valueForInput = computed(() => {
  return typeof props.modelValue === "string" ? props.modelValue : "";
});

function normalizeExtensions(extensions?: string[]): string[] {
  if (!extensions || extensions.length === 0) return ["jpg", "jpeg", "png", "gif", "webp", "bmp", "ico", "zip"];
  const exts = extensions
    .map((e) => `${e}`.trim().replace(/^\./, "").toLowerCase())
    .filter(Boolean);
  return exts.length > 0 ? exts : ["jpg", "jpeg", "png", "gif", "webp", "bmp", "ico", "zip"];
}

async function pickFolder() {
  const selected = await open({ directory: true, multiple: false });
  if (!selected) return;
  const filePath = typeof selected === "string" ? selected : selected;
  emitUpdate(filePath);
}

async function pickFile() {
  const exts = normalizeExtensions(props.fileExtensions);
  const selected = await open({
    directory: false,
    multiple: false,
    filters: [{ name: "文件", extensions: exts }],
  });
  if (!selected) return;
  const filePath = typeof selected === "string" ? selected : selected;
  emitUpdate(filePath);
}

function emitUpdate(v: string) {
  emit("update:modelValue", v);
}

async function handleCommand(cmd: string) {
  if (cmd === "file") return await pickFile();
  if (cmd === "folder") return await pickFolder();
}
</script>
