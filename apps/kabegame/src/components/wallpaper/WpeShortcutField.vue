<template>
  <div class="flex min-w-0 flex-col gap-2" data-testid="wpe-shortcut-field">
    <KbSelect
      :model-value="kind"
      :options="kindOptions"
      :segmented="false"
      data-testid="wpe-shortcut-kind"
      @update:model-value="onKind"
    />
    <div class="flex min-w-0 items-center gap-2">
      <KbText
        class="min-w-0 flex-1"
        :model-value="path"
        :placeholder="pathPlaceholder"
        data-testid="wpe-shortcut-path"
        @update:model-value="onPath"
      />
      <Button v-if="canBrowse" variant="outline" size="md" data-testid="wpe-shortcut-browse" @click="browse">
        {{ t("gallery.wpeShortcutBrowse") }}
      </Button>
    </div>
    <KbText
      v-if="kind === 'file'"
      :model-value="args"
      :placeholder="t('gallery.wpeShortcutArgs')"
      data-testid="wpe-shortcut-args"
      @update:model-value="onArgs"
    />
    <div class="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        :disabled="!hasValue || testing"
        :aria-busy="testing"
        data-testid="wpe-shortcut-test"
        @click="test"
      >
        <Spinner v-if="testing" :size="14" />
        <Play v-else />
        <span>{{ t("gallery.wpeShortcutTest") }}</span>
      </Button>
      <Button v-if="hasValue" variant="ghost" size="sm" data-testid="wpe-shortcut-clear" @click="clear">
        <X />
        <span>{{ t("common.clear") }}</span>
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 场景快捷方式（`usershortcut`，P11d）的编辑器：类型（文件 / 文件夹 / 网址 / 命令）、路径（文件与文件夹带浏览按钮）、文件类型的启动参数、
 * 清空与「测试」。值格式 `<类型>:<路径>[|<参数>]` 见 `utils/wpeShortcut.ts`；这里只管拆与拼，保存走面板现有的写入流程（`set`，300ms 防抖、
 * `metadataId` 补丁回来后重读）。
 *
 * 「测试」调和脚本点击同一条启动命令 `wpe_open_user_shortcut`（应用页独有的命令，由用户在这里点击，本身就是用户激活）；命令读的是
 * 已保存的值，所以点之前先等待面板把草稿写完（`save`）。
 *
 * macOS 上「文件」写成「文件或 App」（`.app` 在 macOS 上是目录，免得用户去选「文件夹」），「命令」整条交给 `/bin/sh -c`，
 * 占位例子换成 macOS 的；值格式不变。
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Play, X } from "@lucide/vue";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@/api";
import { IS_MACOS } from "@/env";
import KbSelect from "@/components/common/form/KbSelect.vue";
import KbText from "@/components/common/form/KbText.vue";
import { Button, Spinner } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { composeWpeShortcut, parseWpeShortcut, WPE_SHORTCUT_KINDS, type WpeShortcutKind } from "@/utils/wpeShortcut";

const props = defineProps<{
  /** 属性名：「测试」按它启动 */
  name: string;
  modelValue: unknown;
  /** 本组件所在壁纸的图片 id */
  imageId?: string;
  /** 把待写的草稿立刻写完并等它结束（`useWpeWebProperties` 的 `saveNow`） */
  save?: () => Promise<void>;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const { t } = useI18n();

const initial = parseWpeShortcut(props.modelValue);
const kind = ref<WpeShortcutKind>(initial.kind);
const path = ref(initial.path);
const args = ref(initial.args);
const testing = ref(false);

const composed = computed(() => composeWpeShortcut(kind.value, path.value, args.value));
const hasValue = computed(() => typeof props.modelValue === "string" && props.modelValue !== "");

/** 外部的值变了（保存后补全网址前缀、重置、换图）才重新拆；自己刚发出的值不回灌，免得空路径时丢掉选好的类型 */
watch(
  () => props.modelValue,
  (value) => {
    const text = typeof value === "string" ? value : "";
    if (text === composed.value) return;
    const parts = parseWpeShortcut(text);
    kind.value = parts.kind;
    path.value = parts.path;
    args.value = parts.args;
  },
);

const kindLabels: Record<WpeShortcutKind, string> = {
  file: IS_MACOS ? "gallery.wpeShortcutKindFileMac" : "gallery.wpeShortcutKindFile",
  directory: "gallery.wpeShortcutKindDirectory",
  web: "gallery.wpeShortcutKindWeb",
  cmd: "gallery.wpeShortcutKindCmd",
};
const kindOptions = computed(() => WPE_SHORTCUT_KINDS.map((item) => ({ name: t(kindLabels[item]), variable: item })));
const placeholders: Record<WpeShortcutKind, string> = {
  file: IS_MACOS ? "gallery.wpeShortcutPathFileMac" : "gallery.wpeShortcutPathFile",
  directory: "gallery.wpeShortcutPathDirectory",
  web: "gallery.wpeShortcutPathWeb",
  cmd: IS_MACOS ? "gallery.wpeShortcutPathCmdMac" : "gallery.wpeShortcutPathCmd",
};
const pathPlaceholder = computed(() => t(placeholders[kind.value]));
const canBrowse = computed(() => kind.value === "file" || kind.value === "directory");

function commit() {
  emit("update:modelValue", composed.value);
}
function onKind(next: unknown) {
  if (typeof next !== "string" || !WPE_SHORTCUT_KINDS.includes(next as WpeShortcutKind)) return;
  kind.value = next as WpeShortcutKind;
  commit();
}
function onPath(next: string) {
  path.value = next;
  commit();
}
function onArgs(next: string) {
  args.value = next;
  commit();
}
function clear() {
  path.value = "";
  args.value = "";
  commit();
}

/** 文件与文件夹的选取同 `KbPath`（系统对话框），只是文件不按扩展名过滤：快捷方式的目标常是程序 */
async function browse() {
  const selected = await open({ directory: kind.value === "directory", multiple: false });
  if (typeof selected === "string" && selected) onPath(selected);
}

async function test() {
  if (!hasValue.value || testing.value || !props.imageId) return;
  testing.value = true;
  try {
    await props.save?.();
    const started = await invoke<boolean>("wpe_open_user_shortcut", { imageId: props.imageId, name: props.name });
    if (started) toast.success(t("gallery.wpeShortcutTestStarted"));
    else toast.warning(t("gallery.wpeShortcutTestRejected"));
  } catch (failure) {
    toast.error(`${t("gallery.wpeShortcutTestFailed")}: ${String(failure)}`);
  } finally {
    testing.value = false;
  }
}
</script>
