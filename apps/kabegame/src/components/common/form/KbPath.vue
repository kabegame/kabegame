<template>
  <DragFileZone class="var-path" :plan="planDrop" :on-drop="onDropPath">
    <KbSegmentedControl
      v-if="type === 'file_or_folder' || type === 'path'"
      class="var-path__mode"
      :model-value="pickMode"
      :options="modeOptions"
      @update:model-value="(v) => (pickMode = v as 'file' | 'folder')"
    />

    <div v-if="valueForInput" class="var-path__row">
      <div class="var-path__box">
        <span class="var-path__text" :title="valueForInput">{{ valueForInput }}</span>
        <span v-if="allowUnset" class="var-path__clear" @click="emitUpdate('')">×</span>
      </div>
      <button type="button" class="var-path__btn" @click="pick">{{ t("import.pathChange") }}</button>
    </div>

    <button v-else type="button" class="var-path__drop" @click="pick">
      <el-icon><FolderOpened /></el-icon>
      <span>{{ dropText }}</span>
    </button>
  </DragFileZone>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { FolderOpened } from "@kabegame/element-plus-icons";
import { open } from "@tauri-apps/plugin-dialog";
import { useI18n } from "@kabegame/i18n";
import DragFileZone from "@/components/common/DragFileZone.vue";
import { IS_ANDROID, IS_WEB } from "@/env";
import type { DragFileItem, DragFilePlan } from "@/utils/dragFileZones";
import KbSegmentedControl from "./KbSegmentedControl.vue";

const props = withDefaults(
  defineProps<{
    type: "path" | "file_or_folder" | "file" | "folder";
    modelValue: unknown;
    fileExtensions?: string[];
    placeholder?: string;
    allowUnset?: boolean;
  }>(),
  { allowUnset: false },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const { t } = useI18n();

const valueForInput = computed(() => {
  return typeof props.modelValue === "string" ? props.modelValue : "";
});

/** file_or_folder / path 类型二选一由本地状态决定「更换」按钮打开哪种对话框；单一类型无需选择 */
const pickMode = ref<"file" | "folder">("folder");
const modeOptions = computed(() => [
  { label: t("import.file"), value: "file" },
  { label: t("import.folder"), value: "folder" },
]);

const effectiveMode = computed<"file" | "folder">(() => {
  if (props.type === "file") return "file";
  if (props.type === "folder") return "folder";
  return pickMode.value;
});

/** 类型本身允许的拖入形态（path / file_or_folder 两种都收，与当前 pickMode 无关） */
const allowsFolder = computed(() => props.type !== "file");
const allowsFile = computed(() => props.type !== "folder");
/** 桌面才有拖入；Android / web 仍然只能点选 */
const canDrop = !IS_ANDROID && !IS_WEB;

const dropText = computed(() => {
  if (!canDrop) {
    return effectiveMode.value === "folder" ? t("import.pathPickFolder") : t("import.pathPickFile");
  }
  if (allowsFolder.value && allowsFile.value) return t("import.pathDropEither");
  return allowsFolder.value ? t("import.pathDropFolder") : t("import.pathDropFile");
});

function normalizeExtensions(extensions?: string[]): string[] {
  if (!extensions || extensions.length === 0) return ["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "zip"];
  const exts = extensions.map((e) => `${e}`.trim().replace(/^\./, "").toLowerCase()).filter(Boolean);
  return exts.length > 0 ? exts : ["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "zip"];
}

function baseName(path: string): string {
  const segments = path.replace(/\\/g, "/").split("/");
  return segments[segments.length - 1] || path;
}

function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** 单个拖入项是否符合当前变量的类型与扩展名；不符合返回 null → 提示「此处不支持」 */
function planDrop(items: DragFileItem[]): DragFilePlan | null {
  if (items.length !== 1) return null;
  const item = items[0];
  if (item.isDirectory) {
    if (!allowsFolder.value) return null;
  } else {
    if (!allowsFile.value) return null;
    if (!normalizeExtensions(props.fileExtensions).includes(extensionOf(item.path))) return null;
  }
  return {
    label: t("import.dropZone.setPath", { name: baseName(item.path) }),
    hint: item.path,
    media: [],
    folders: [],
    plugins: [],
    items: [item],
  };
}

function onDropPath(plan: DragFilePlan) {
  const item = plan.items?.[0];
  if (!item) return;
  // path / file_or_folder 的 pickMode 跟随拖入项，之后点「更换」打开对应对话框。
  if (props.type === "path" || props.type === "file_or_folder") {
    pickMode.value = item.isDirectory ? "folder" : "file";
  }
  emitUpdate(item.path);
}

async function pickFolder() {
  const selected = await open({ directory: true, multiple: false });
  if (!selected) return;
  emitUpdate(selected);
}

async function pickFile() {
  const exts = normalizeExtensions(props.fileExtensions);
  const selected = await open({
    directory: false,
    multiple: false,
    filters: [{ name: t("import.file"), extensions: exts }],
  });
  if (!selected) return;
  emitUpdate(selected);
}

function emitUpdate(v: string) {
  emit("update:modelValue", v);
}

async function pick() {
  if (effectiveMode.value === "folder") return await pickFolder();
  return await pickFile();
}
</script>

<style scoped>
.var-path {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.var-path__mode {
  align-self: flex-start;
}

.var-path__row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.var-path__box {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  height: 32px;
  min-width: 0;
  padding: 0 11px;
  border: 1px solid var(--anime-border);
  border-radius: 12px;
  background: #fff;
}

.var-path__text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
  font:
    500 12.5px/1 ui-monospace,
    "SFMono-Regular",
    Menlo,
    Consolas,
    monospace;
  color: var(--anime-text-primary);
}

.var-path__clear {
  flex: none;
  width: 17px;
  height: 17px;
  border-radius: 50%;
  background: rgba(255, 107, 157, 0.12);
  color: var(--anime-primary-dark);
  font-size: 10px;
  font-weight: 700;
  line-height: 17px;
  text-align: center;
  cursor: pointer;
}

.var-path__btn {
  appearance: none;
  flex: none;
  height: 24px;
  padding: 0 10px;
  border: none;
  border-radius: 9px;
  margin: 0;
  background: rgba(255, 107, 157, 0.08);
  color: var(--anime-text-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
}
.var-path__btn:hover {
  background: rgba(255, 107, 157, 0.16);
}

.var-path__drop {
  appearance: none;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 62px;
  border: 1px dashed var(--anime-secondary);
  border-radius: 13px;
  margin: 0;
  background: rgba(255, 107, 157, 0.04);
  color: var(--anime-text-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 12.5px;
}
.var-path__drop:hover {
  border-color: var(--anime-primary);
  color: var(--anime-primary-dark);
}
</style>
