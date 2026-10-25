<template>
  <ElDialog
    :model-value="modal.isOpen.value"
    :z-index="modal.zIndex.value"
    :title="$t('gallery.wallpaperImportTitle')"
    width="640px"
    align-center
    :show-close="true"
    @update:model-value="modal.close"
    @closed="handleClosed"
  >
    <div class="flex flex-col gap-3">
      <div class="flex items-start justify-between gap-3">
        <p class="m-0 text-xs leading-relaxed text-[var(--anime-text-secondary)]">
          {{ $t("gallery.wpeScanHint") }}
        </p>
        <el-button link type="primary" size="small" class="shrink-0" :disabled="scanning" @click="refreshScan">
          <el-icon :class="{ 'is-loading': scanning }"><Refresh /></el-icon>
          <span class="ml-1">{{ $t("gallery.wpeRescan") }}</span>
        </el-button>
      </div>

      <div class="wpe-section">{{ $t("gallery.wpeSectionSources") }}</div>

      <div class="flex flex-col gap-2 max-h-[46vh] overflow-y-auto pr-1">
        <!-- 扫描中：骨架卡片，避免整块 loading 遮罩 -->
        <template v-if="scanning && !sources.length">
          <div v-for="n in 3" :key="`sk-${n}`" class="wpe-card pointer-events-none">
            <el-skeleton animated class="w-full">
              <template #template>
                <div class="flex items-center gap-3">
                  <el-skeleton-item variant="circle" class="!w-9 !h-9 shrink-0" />
                  <div class="flex-1 flex flex-col gap-2">
                    <el-skeleton-item variant="text" class="!w-1/3" />
                    <el-skeleton-item variant="text" class="!w-2/3" />
                  </div>
                </div>
              </template>
            </el-skeleton>
          </div>
        </template>

        <!-- 自动发现的来源：整张卡片可点选 -->
        <div
          v-for="source in sources"
          :key="source.kind"
          class="wpe-card cursor-pointer"
          :class="{ 'is-selected': isSelected(source) }"
          role="checkbox"
          :aria-checked="isSelected(source)"
          tabindex="0"
          @click="toggle(source)"
          @keydown.space.prevent="toggle(source)"
          @keydown.enter.prevent="toggle(source)"
        >
          <div class="wpe-icon">
            <el-icon :size="18"><component :is="iconForKind(source.kind)" /></el-icon>
          </div>
          <div class="flex-1 min-w-0 flex flex-col gap-1">
            <div class="flex items-center gap-2">
              <span class="font-semibold text-sm text-[var(--anime-text-primary)]">{{ sourceLabel(source) }}</span>
            </div>
            <span class="text-xs truncate text-[var(--el-text-color-secondary)]" :title="source.paths.join('\n')">
              {{ pathText(source) }}
            </span>
            <div class="flex flex-wrap gap-1.5 mt-0.5">
              <span v-for="chip in statChips(source)" :key="chip.tone" class="wpe-chip" :class="`is-${chip.tone}`">
                {{ chip.text }}
              </span>
            </div>
          </div>
          <div class="wpe-check">
            <el-icon v-if="isSelected(source)" :size="12"><Check /></el-icon>
          </div>
        </div>

        <!-- 没扫到时的说明（仍可手动添加文件夹） -->
        <div
          v-if="!scanning && !sources.length"
          class="flex items-start gap-2 px-3 py-2.5 rounded-lg text-xs leading-relaxed bg-[var(--el-fill-color-light)] text-[var(--el-text-color-secondary)]"
        >
          <el-icon class="mt-0.5 shrink-0" :size="14"><Warning /></el-icon>
          <span>{{ $t("gallery.wpeNoSources") }}</span>
        </div>

        <!-- 手动添加的文件夹 -->
        <div v-for="(source, idx) in extraDirs" :key="source.paths[0]" class="wpe-card is-selected">
          <div class="wpe-icon">
            <el-icon :size="18"><Folder /></el-icon>
          </div>
          <div class="flex-1 min-w-0 flex flex-col gap-1">
            <span class="font-semibold text-sm text-[var(--anime-text-primary)]">{{ $t("gallery.wpeSourceCustom") }}</span>
            <span class="text-xs truncate text-[var(--el-text-color-secondary)]" :title="source.paths[0]">
              {{ source.paths[0] }}
            </span>
            <div class="flex flex-wrap gap-1.5 mt-0.5">
              <span v-for="chip in statChips(source)" :key="chip.tone" class="wpe-chip" :class="`is-${chip.tone}`">
                {{ chip.text }}
              </span>
            </div>
          </div>
          <el-button
            link
            class="self-start"
            :aria-label="$t('common.remove')"
            :title="$t('common.remove')"
            @click="extraDirs.splice(idx, 1)"
          >
            <el-icon :size="16"><Close /></el-icon>
          </el-button>
        </div>

        <button type="button" class="wpe-add" :disabled="adding" @click="handleAddFolder">
          <el-icon :size="16" :class="{ 'is-loading': adding }"><FolderAdd /></el-icon>
          <span>{{ $t("gallery.wpeAddFolder") }}</span>
        </button>
      </div>

      <div class="wpe-section mt-1">{{ $t("gallery.webpageSectionSaveTo") }}</div>

      <el-form label-position="top" class="px-1" @submit.prevent>
        <el-form-item :label="$t('albums.outputAlbum')">
          <AlbumPicker
            v-model="outputAlbumId"
            :scope="{ excludeIds: [HIDDEN_ALBUM_ID] }"
            expand-label-dirs
            allow-create
            :placeholder="$t('albums.notSpecifiedAddToGallery')"
            :picker-title="$t('albums.outputAlbum')"
            clearable
          />
        </el-form-item>
        <el-form-item :label="$t('plugins.dryRun')" class="!mb-0">
          <div class="flex items-center gap-2">
            <el-switch v-model="isDryRun" />
            <span class="text-sm text-[var(--anime-text-secondary)]">{{ $t("plugins.dryRunDesc") }}</span>
          </div>
        </el-form-item>
      </el-form>
    </div>

    <template #footer>
      <div class="flex items-center justify-between gap-3">
        <span class="text-xs text-left text-[var(--el-text-color-secondary)]">
          {{ footerText }}
        </span>
        <div class="flex gap-3 shrink-0">
          <el-button @click="modal.close()">{{ $t("common.cancel") }}</el-button>
          <el-button type="primary" :disabled="!canSubmit || scanning" :loading="submitting" @click="handleSubmit">
            {{ $t("albums.startImport") }}
          </el-button>
        </div>
      </div>
    </template>
  </ElDialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch, type Component } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Box, Check, Close, Folder, FolderAdd, Refresh, Shop, User, Warning } from "@kabegame/element-plus-icons";
import { ElDialog } from "@kabegame/element-plus";
import { kameMessage as ElMessage } from "@/utils/kameMessage";
import { invoke } from "@/api";
import { open } from "@tauri-apps/plugin-dialog";
import { useCrawlerStore } from "@/stores/crawler";
import { HIDDEN_ALBUM_ID } from "@/services/albums";
import { useModal } from "@/composables/useModal";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";
import AlbumPicker from "@/components/albums/AlbumPicker.vue";

/** 与后端 `WpeSourceInfo` 对应。 */
interface WpeSourceInfo {
  kind: string;
  recognized?: string | null;
  paths: string[];
  total: number;
  video: number;
  /** 可导入且尚未入库。 */
  pending: number;
  imported: number;
}

interface WpeScanResult {
  platformSupported: boolean;
  sources: WpeSourceInfo[];
}

const props = defineProps<{
  modelValue: boolean;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
}>();

const { t } = useI18n();
const modal = useModal({ onClose: () => emit("update:modelValue", false) });

const crawlerStore = useCrawlerStore();
const scanning = ref(false);
const adding = ref(false);
const submitting = ref(false);
const sources = ref<WpeSourceInfo[]>([]);
const selected = reactive<Record<string, boolean>>({});
const extraDirs = ref<WpeSourceInfo[]>([]);
const outputAlbumId = ref<string | null>(null);
const isDryRun = ref(false);

// 打开即扫描：跟随 modelValue 而不是 ElDialog 的 open 事件，保证每次打开都触发。
watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      modal.open();
      void refreshScan();
    } else {
      modal.close();
    }
  },
  { immediate: true },
);

const labelForKind: Record<string, string> = {
  workshop: "gallery.wpeSourceWorkshop",
  defaultprojects: "gallery.wpeSourceDefaultProjects",
  myprojects: "gallery.wpeSourceMyProjects",
};

const iconByKind: Record<string, Component> = {
  workshop: Shop,
  defaultprojects: Box,
  myprojects: User,
};

function iconForKind(kind: string): Component {
  return iconByKind[kind] ?? Folder;
}

function sourceLabel(source: WpeSourceInfo): string {
  const key = labelForKind[source.kind];
  return key ? t(key) : source.kind;
}

function pathText(source: WpeSourceInfo): string {
  const [first, ...rest] = source.paths;
  return rest.length ? `${first}  +${rest.length}` : (first ?? "");
}

/** 未手动切换过的来源按「有待导入的壁纸」决定默认勾选。 */
function isSelected(source: WpeSourceInfo): boolean {
  return selected[source.kind] ?? source.pending > 0;
}

function toggle(source: WpeSourceInfo) {
  selected[source.kind] = !isSelected(source);
}

/** 三枚计数小标签：壁纸总数 / 待导入（视频且未入库，为 0 时置灰）/ 已导入（为 0 时不显示）。 */
function statChips(source: WpeSourceInfo): { tone: "plain" | "primary" | "muted"; text: string }[] {
  const chips: { tone: "plain" | "primary" | "muted"; text: string }[] = [
    { tone: "plain", text: t("gallery.wpeStatTotal", { n: source.total }) },
    { tone: source.pending > 0 ? "primary" : "muted", text: t("gallery.wpeStatVideo", { n: source.pending }) },
  ];
  if (source.imported > 0) chips.push({ tone: "muted", text: t("gallery.wpeStatImported", { n: source.imported }) });
  return chips;
}

const selectedSources = computed(() => sources.value.filter(isSelected));
const canSubmit = computed(() => selectedSources.value.length > 0 || extraDirs.value.length > 0);
const importableCount = computed(() =>
  [...selectedSources.value, ...extraDirs.value].reduce((sum, source) => sum + source.pending, 0),
);

const footerText = computed(() => {
  if (canSubmit.value) return t("gallery.wpeSummary", { n: importableCount.value });
  // 扫到了来源但一个待导入的都没有：说明都已入库，而不是让用户「至少选一个」。
  if (!scanning.value && sources.value.length && sources.value.every((source) => source.pending === 0)) {
    return t("gallery.wpeNothingNew");
  }
  return t("gallery.wpeNoSelection");
});

let scanSeq = 0;
async function refreshScan() {
  const seq = ++scanSeq;
  scanning.value = true;
  try {
    const result = await invoke<WpeScanResult>("wpe_scan");
    if (seq !== scanSeq) return;
    sources.value = Array.isArray(result?.sources) ? result.sources : [];
  } catch (error) {
    if (seq !== scanSeq) return;
    console.error("[WPE] 扫描壁纸来源失败:", error);
    sources.value = [];
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    if (seq === scanSeq) scanning.value = false;
  }
}

async function handleAddFolder() {
  if (await guardDesktopOnly("localImport")) return;
  try {
    const picked = await open({ directory: true, multiple: false });
    if (!picked) return;
    const path = typeof picked === "string" ? picked : picked[0];
    if (!path) return;
    if (extraDirs.value.some((item) => item.paths[0] === path)) return;
    adding.value = true;
    const info = await invoke<WpeSourceInfo>("wpe_recognize_dir", { path });
    extraDirs.value.push(info);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== "cancel" && message !== "close") {
      ElMessage.error(message.includes("未识别") ? t("gallery.wpeUnsupported") : message);
    }
  } finally {
    adding.value = false;
  }
}

function handleClosed() {
  scanSeq++;
  scanning.value = false;
  sources.value = [];
  extraDirs.value = [];
  outputAlbumId.value = null;
  isDryRun.value = false;
  for (const key of Object.keys(selected)) delete selected[key];
}

async function handleSubmit() {
  if (!canSubmit.value) {
    ElMessage.warning(t("gallery.wpeNoSelection"));
    return;
  }
  if (await guardDesktopOnly("localImport", { needSuper: true })) return;

  const sourceFlags = {
    workshop: sources.value.some((s) => s.kind === "workshop" && isSelected(s)),
    defaultprojects: sources.value.some((s) => s.kind === "defaultprojects" && isSelected(s)),
    myprojects: sources.value.some((s) => s.kind === "myprojects" && isSelected(s)),
  };
  const extraPaths = extraDirs.value.map((source) => source.paths[0]).filter(Boolean);
  const userConfig: Record<string, unknown> = { sources: sourceFlags };
  // `extraDirs` 是 list 变量：空数组会被校验拒绝，未选时省略（后端按缺失处理）。
  if (extraPaths.length > 0) userConfig.extraDirs = extraPaths;

  submitting.value = true;
  try {
    const added = await crawlerStore.addTask(
      "wpe-import",
      undefined,
      userConfig,
      outputAlbumId.value ?? undefined,
      undefined,
      undefined,
      "manual",
      undefined,
      isDryRun.value,
    );
    if (!added) {
      ElMessage.error(t("gallery.wpeTaskFailed"));
      return;
    }
    modal.close();
    ElMessage.success(t("gallery.wpeTaskAdded"));
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped lang="scss">
// 卡片选中态与计数标签依赖主题色混合，工具类表达过长，集中写在这里。
.wpe-card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
  background: var(--el-bg-color);
  transition:
    border-color 0.15s,
    background-color 0.15s,
    box-shadow 0.15s;
  outline: none;

  &:hover,
  &:focus-visible {
    border-color: var(--anime-primary-light);
  }

  &.is-selected {
    border-color: var(--anime-primary);
    background: color-mix(in srgb, var(--anime-primary) 6%, var(--el-bg-color));
    box-shadow: 0 2px 10px color-mix(in srgb, var(--anime-primary) 12%, transparent);
  }
}

.wpe-icon {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  color: var(--anime-primary);
  background: color-mix(in srgb, var(--anime-primary) 12%, transparent);
}

.wpe-check {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-top: 2px;
  border: 1.5px solid var(--el-border-color);
  border-radius: 50%;
  color: #fff;
  transition: all 0.15s;

  .is-selected & {
    border-color: var(--anime-primary);
    background: var(--anime-primary);
  }
}

.wpe-section {
  font-size: 13px;
  font-weight: 600;
  color: var(--anime-text-primary);
}

.wpe-add {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px;
  border: 1px dashed var(--el-border-color);
  border-radius: 12px;
  background: var(--el-bg-color);
  color: var(--el-text-color-secondary);
  font-size: 13px;
  cursor: pointer;
  transition:
    border-color 0.15s,
    color 0.15s;

  &:hover:not(:disabled) {
    border-color: var(--anime-primary);
    color: var(--anime-primary);
  }

  &:disabled {
    cursor: progress;
  }
}

.wpe-chip {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 18px;

  &.is-plain {
    color: var(--el-text-color-regular);
    background: var(--el-fill-color);
  }

  &.is-primary {
    color: var(--anime-primary-dark);
    background: color-mix(in srgb, var(--anime-primary) 14%, transparent);
  }

  &.is-muted {
    color: var(--el-text-color-secondary);
    background: var(--el-fill-color-lighter);
  }
}
</style>
