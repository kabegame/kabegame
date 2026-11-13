<template>
  <DragFileZone class="flex w-full flex-col gap-2" :plan="planDrop" :on-drop="onDropPath">
    <KbSegmentedControl
      v-if="type === 'file_or_folder' || type === 'path'"
      class="self-start"
      :model-value="pickMode"
      :options="modeOptions"
      @update:model-value="(v) => (pickMode = v as 'file' | 'folder')"
    />

    <div v-if="valueForInput" class="flex min-w-0 items-center gap-2">
      <div class="kb-control h-8 min-w-0 flex-1 gap-1.5 px-2.5">
        <!-- rtl：路径太长时截掉开头、保留文件名 -->
        <span class="min-w-0 flex-1 truncate text-left font-mono text-[12.5px] [direction:rtl]" :title="valueForInput">
          {{ valueForInput }}
        </span>
        <button
          v-if="allowUnset"
          type="button"
          class="grid size-5 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-kb-fg-subtle hover:bg-kb-hover hover:text-kb-fg-muted"
          :aria-label="t('common.clear')"
          @click="emitUpdate('')"
        >
          <X class="size-3.5" />
        </button>
      </div>
      <Button variant="outline" size="md" @click="pick">{{ t("import.pathChange") }}</Button>
    </div>

    <button
      v-else
      type="button"
      class="box-border flex h-15 w-full cursor-pointer items-center justify-center gap-1.5 rounded-kb-md border border-dashed border-kb-line-strong bg-transparent text-[12.5px] text-kb-fg-muted [font:inherit] outline-none transition-colors duration-150 hover:border-kb-fg-subtle hover:bg-kb-hover hover:text-kb-fg focus-visible:ring-2 focus-visible:ring-kb-ring"
      @click="pick"
    >
      <FolderOpen class="size-4" />
      <span>{{ dropText }}</span>
    </button>
  </DragFileZone>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { FolderOpen, X } from "@lucide/vue";
import { open } from "@tauri-apps/plugin-dialog";
import { useI18n } from "@kabegame/i18n";
import DragFileZone from "@/components/common/DragFileZone.vue";
import Button from "@/components/ui/Button.vue";
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
