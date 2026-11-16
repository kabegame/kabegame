<template>
  <div class="flex flex-col gap-4 [--kb-field-label-width:110px]">
    <Field :label="$t('albums.outputAlbum')" orientation="horizontal">
      <AlbumPicker
        v-model="selectedOutputAlbumId"
        :scope="{ excludeIds: [HIDDEN_ALBUM_ID] }"
        expand-label-dirs
        allow-create
        :placeholder="$t('albums.notSpecifiedAddToGallery')"
        :picker-title="$t('albums.outputAlbum')"
        clearable
      />
    </Field>
    <Field v-if="isCreatingNewOutputAlbum" :label="$t('albums.placeholderName')" orientation="horizontal" required>
      <Input
        v-model="newOutputAlbumName"
        :placeholder="$t('albums.placeholderName')"
        maxlength="50"
        @keyup.enter="handleCreateOutputAlbum"
      >
        <template #suffix>
          <span class="text-[11.5px] tabular-nums">{{ newOutputAlbumName.length }}/50</span>
        </template>
      </Input>
    </Field>
    <Field v-if="isCreatingNewOutputAlbum" :label="$t('albums.parentAlbum')" orientation="horizontal">
      <AlbumPicker
        v-model="newOutputAlbumParentId"
        :scope="{ sections: ['normal'] }"
        :placeholder="$t('albums.selectParentAlbum')"
        :picker-title="$t('albums.parentAlbum')"
      />
    </Field>

    <Field :label="$t('albums.selectPath')" orientation="horizontal">
      <div class="flex flex-wrap gap-2">
        <Button @click="handleAddFiles">
          <FileText />
          {{ $t("common.addFiles") }}
        </Button>
        <Button @click="handleAddFolder">
          <FolderOpen />
          {{ $t("common.addFolder") }}
        </Button>
      </div>
    </Field>

    <Field v-if="paths.length > 0" :label="$t('common.selectedPaths')" orientation="horizontal">
      <ul
        class="m-0 box-border max-h-[200px] list-none overflow-y-auto rounded-kb-md border border-solid border-kb-line p-0"
      >
        <li
          v-for="(label, idx) in paths"
          :key="label"
          class="flex items-center gap-2 border-0 border-b border-solid border-kb-line py-1 pl-3 pr-1 last:border-b-0"
        >
          <span class="min-w-0 flex-1 break-all text-[12.5px] leading-[1.5] text-kb-fg">{{ label }}</span>
          <Tooltip :content="$t('common.remove')">
            <Button variant="ghost-danger" size="icon-sm" :aria-label="$t('common.remove')" @click="removeItem(idx)">
              <X />
            </Button>
          </Tooltip>
        </li>
      </ul>
    </Field>

    <Field :label="$t('albums.recursiveSubdirsLabel')" orientation="horizontal">
      <div class="flex min-h-8 items-center">
        <Checkbox v-model="recursive">{{ $t("albums.recursiveSubdirs") }}</Checkbox>
      </div>
    </Field>
    <Field :label="$t('tasks.dryRunBadge')" orientation="horizontal">
      <label class="flex min-h-8 cursor-pointer items-center gap-2.5">
        <Switch v-model="isDryRun" />
        <span class="text-[12.5px] text-kb-fg-muted">{{ $t("plugins.dryRunDesc") }}</span>
      </label>
    </Field>
  </div>
</template>

<script lang="ts">
/** 递归开关跨次打开沿用上次的选择（面板每次打开重新挂载，所以放在模块里） */
let lastRecursive = true;
</script>

<script setup lang="ts">
/** 「本地 → 文件夹」：选文件 / 文件夹交给内建 local-import 任务。宿主见 CollectLocalDialog。 */
import { computed, ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { FileText, FolderOpen, X } from "@lucide/vue";
import { Button, Checkbox, Field, Input, Switch, Tooltip } from "@/components/ui";
import { kameMessage } from "@/utils/kameMessage";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useCrawlerStore } from "@/stores/crawler";
import { HIDDEN_ALBUM_ID, createAlbum } from "@/services/albums";
import { useImageTypes } from "@/composables/useImageTypes";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";
import AlbumPicker from "@/components/albums/AlbumPicker.vue";
import type { LocalImportInitialConfig } from "@/stores/collectDialogs";

const { t } = useI18n();
const props = defineProps<{
  /** 「再次执行」带来的初始参数，挂载时套用一次 */
  initialConfig?: LocalImportInitialConfig;
}>();

const emit = defineEmits<{ (e: "done"): void }>();

const crawlerStore = useCrawlerStore();
const { extensions: imageExtensions, load: loadImageTypes } = useImageTypes();

const selectedOutputAlbumId = ref<string | null>(props.initialConfig?.outputAlbumId ?? null);
const newOutputAlbumName = ref("");
const newOutputAlbumParentId = ref<string | null>(null);
const paths = ref<string[]>([...(props.initialConfig?.paths ?? [])]);
const recursive = ref(props.initialConfig?.recursive ?? lastRecursive);
watch(recursive, (value) => {
  lastRecursive = value;
});
const isDryRun = ref(props.initialConfig?.isDryRun ?? false);
const isCreatingNewOutputAlbum = computed(() => selectedOutputAlbumId.value === "__create_new__");
watch(selectedOutputAlbumId, (value) => {
  if (value !== "__create_new__") {
    newOutputAlbumName.value = "";
    newOutputAlbumParentId.value = null;
  }
});

async function handleAddFiles() {
  try {
    await loadImageTypes();
    const exts = imageExtensions.value.length
      ? imageExtensions.value
      : ["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "mp4", "mov"];
    const selected = await openFileDialog({
      directory: false,
      multiple: true,
      filters: [{ name: t("common.media"), extensions: exts }],
    });

    if (!selected) return;

    const arr = Array.isArray(selected) ? selected : [selected];
    for (const p of arr) {
      if (p && !paths.value.includes(p)) {
        paths.value.push(p);
      }
    }
  } catch (e) {
    if (e !== "cancel" && e !== "close") {
      console.error("选择文件失败:", e);
      kameMessage.error(t("albums.selectFileFailed"));
    }
  }
}

async function handleAddFolder() {
  try {
    const selected = await openFileDialog({
      directory: true,
      multiple: false,
    });

    if (!selected) return;

    const pathStr = typeof selected === "string" ? selected : selected?.[0];
    if (pathStr && !paths.value.includes(pathStr)) {
      paths.value.push(pathStr);
    }
  } catch (e) {
    if (e !== "cancel" && e !== "close") {
      console.error("选择文件夹失败:", e);
      kameMessage.error(t("albums.selectFolderFailed"));
    }
  }
}

function removeItem(idx: number) {
  paths.value.splice(idx, 1);
}

async function createOutputAlbum(showSuccess = true) {
  const name = newOutputAlbumName.value.trim();
  if (!name) {
    kameMessage.warning(t("albums.enterAlbumNameFirst"));
    return null;
  }
  try {
    const parentId = newOutputAlbumParentId.value?.trim() || null;
    const album = await createAlbum(name, { parentId, reload: false });
    newOutputAlbumName.value = "";
    newOutputAlbumParentId.value = null;
    if (showSuccess) {
      kameMessage.success(t("albums.albumCreated"));
    }
    return album;
  } catch (e) {
    console.error("创建画册失败:", e);
    kameMessage.error(t("albums.createAlbumFailed"));
    return null;
  }
}

async function handleCreateOutputAlbum() {
  const album = await createOutputAlbum();
  if (album?.id) {
    selectedOutputAlbumId.value = album.id;
  }
}

async function submit() {
  if (paths.value.length === 0) {
    kameMessage.warning(t("albums.addPathFirst"));
    return;
  }

  if (await guardDesktopOnly("localImport", { needSuper: true })) return;

  let outputAlbumId: string | undefined;
  if (selectedOutputAlbumId.value === "__create_new__") {
    const album = await createOutputAlbum(false);
    if (!album?.id) return;
    outputAlbumId = album.id;
  } else if (selectedOutputAlbumId.value) {
    outputAlbumId = selectedOutputAlbumId.value;
  }

  // 文件夹画册「再次执行」：输出画册没改才沿用 copy_to_dir 与同步目录
  const initialOutputAlbumId = props.initialConfig?.outputAlbumId ?? null;
  const preserveCopyToDir =
    props.initialConfig?.copyToDir === true &&
    typeof initialOutputAlbumId === "string" &&
    selectedOutputAlbumId.value === initialOutputAlbumId;

  crawlerStore.addTask(
    "local-import",
    preserveCopyToDir ? props.initialConfig?.outputDir : undefined,
    {
      paths: paths.value,
      recursive: recursive.value,
      ...(preserveCopyToDir ? { copy_to_dir: true } : {}),
    },
    outputAlbumId,
    undefined,
    undefined,
    "manual",
    undefined,
    isDryRun.value,
  );

  emit("done");
  kameMessage.success(t("gallery.localImportTaskAdded"));
}

const canSubmit = computed(() => paths.value.length > 0);

defineExpose({ submit, canSubmit, submitting: false });
</script>
