<template>
  <Dialog v-model:open="open" :title="$t('gallery.wallpaperImportTitle')" :width="640">
    <div class="flex flex-col gap-3">
      <div class="flex items-start justify-between gap-3">
        <p class="m-0 text-[12.5px] leading-[1.6] text-kb-fg-muted">
          {{ $t("gallery.wpeScanHint") }}
        </p>
        <Button variant="ghost" size="sm" :disabled="scanning" @click="refreshScan">
          <RefreshCw :class="{ 'animate-spin': scanning }" />
          {{ $t("gallery.wpeRescan") }}
        </Button>
      </div>

      <SectionTitle>{{ $t("gallery.wpeSectionSources") }}</SectionTitle>

      <div class="flex max-h-[46vh] flex-col gap-2 overflow-y-auto pr-1">
        <!-- 扫描中：骨架卡片，避免整块 loading 遮罩 -->
        <template v-if="scanning && !sources.length">
          <div v-for="n in 3" :key="`sk-${n}`" :class="CARD_CLASS" class="pointer-events-none border-kb-line">
            <Skeleton class="size-9 shrink-0" />
            <div class="flex flex-1 flex-col gap-2 py-0.5">
              <Skeleton class="h-3.5 w-1/3" />
              <Skeleton class="h-3 w-2/3" />
            </div>
          </div>
        </template>

        <!-- 自动发现的来源：整张卡片可点选 -->
        <div
          v-for="source in sources"
          :key="source.kind"
          :class="[CARD_CLASS, isSelected(source) ? CARD_SELECTED_CLASS : CARD_IDLE_CLASS]"
          class="cursor-pointer"
          role="checkbox"
          :aria-checked="isSelected(source)"
          tabindex="0"
          @click="toggle(source)"
          @keydown.space.prevent="toggle(source)"
          @keydown.enter.prevent="toggle(source)"
        >
          <span :class="ICON_CLASS">
            <component :is="iconForKind(source.kind)" />
          </span>
          <div class="flex min-w-0 flex-1 flex-col gap-1">
            <span class="text-[13.5px] font-600 leading-5 text-kb-fg">{{ sourceLabel(source) }}</span>
            <span class="truncate text-[12px] text-kb-fg-muted" :title="source.paths.join('\n')">
              {{ pathText(source) }}
            </span>
            <div class="mt-0.5 flex flex-wrap gap-1.5">
              <span v-for="chip in statChips(source)" :key="chip.tone" :class="[CHIP_CLASS, CHIP_TONES[chip.tone]]">
                {{ chip.text }}
              </span>
            </div>
          </div>
          <span
            class="mt-0.5 box-border grid size-[18px] shrink-0 place-items-center rounded-full border-[1.5px] border-solid transition-colors duration-150"
            :class="isSelected(source) ? 'border-kb-accent bg-kb-accent text-white' : 'border-kb-line-strong'"
            aria-hidden="true"
          >
            <Check v-if="isSelected(source)" class="size-3" :stroke-width="3" />
          </span>
        </div>

        <!-- 没扫到时的说明（仍可手动添加文件夹） -->
        <Alert v-if="!scanning && !sources.length" tone="warning">
          {{ $t("gallery.wpeNoSources") }}
        </Alert>

        <!-- 手动添加的文件夹 -->
        <div v-for="(source, idx) in extraDirs" :key="source.paths[0]" :class="[CARD_CLASS, CARD_SELECTED_CLASS]">
          <span :class="ICON_CLASS">
            <Folder />
          </span>
          <div class="flex min-w-0 flex-1 flex-col gap-1">
            <span class="text-[13.5px] font-600 leading-5 text-kb-fg">{{ $t("gallery.wpeSourceCustom") }}</span>
            <span class="truncate text-[12px] text-kb-fg-muted" :title="source.paths[0]">
              {{ source.paths[0] }}
            </span>
            <div class="mt-0.5 flex flex-wrap gap-1.5">
              <span v-for="chip in statChips(source)" :key="chip.tone" :class="[CHIP_CLASS, CHIP_TONES[chip.tone]]">
                {{ chip.text }}
              </span>
            </div>
          </div>
          <Tooltip :content="$t('common.remove')">
            <Button
              variant="ghost"
              size="icon-sm"
              class="-mr-1 -mt-0.5"
              :aria-label="$t('common.remove')"
              @click="extraDirs.splice(idx, 1)"
            >
              <X />
            </Button>
          </Tooltip>
        </div>

        <button
          type="button"
          class="box-border flex w-full shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-kb-lg border border-dashed border-kb-line-strong bg-transparent p-2.5 [font:inherit] text-[13px] text-kb-fg-muted outline-none transition-colors duration-150 hover:border-kb-fg-subtle hover:text-kb-fg focus-visible:ring-2 focus-visible:ring-kb-ring disabled:cursor-progress [&_svg]:size-4"
          :disabled="adding"
          @click="handleAddFolder"
        >
          <Spinner v-if="adding" :size="16" />
          <FolderPlus v-else />
          <span>{{ $t("gallery.wpeAddFolder") }}</span>
        </button>
      </div>

      <SectionTitle class="mt-1">{{ $t("gallery.webpageSectionSaveTo") }}</SectionTitle>

      <Field :label="$t('albums.outputAlbum')">
        <AlbumPicker
          v-model="outputAlbumId"
          :scope="{ excludeIds: [HIDDEN_ALBUM_ID] }"
          expand-label-dirs
          allow-create
          :placeholder="$t('albums.notSpecifiedAddToGallery')"
          :picker-title="$t('albums.outputAlbum')"
          clearable
        />
      </Field>
      <Field :label="$t('plugins.dryRun')">
        <label class="flex min-h-8 cursor-pointer items-center gap-2.5">
          <Switch v-model="isDryRun" />
          <span class="text-[12.5px] text-kb-fg-muted">{{ $t("plugins.dryRunDesc") }}</span>
        </label>
      </Field>
    </div>

    <template #footer>
      <span class="mr-auto text-[12px] text-kb-fg-muted">{{ footerText }}</span>
      <Button @click="open = false">{{ $t("common.cancel") }}</Button>
      <Button variant="primary" :disabled="!canSubmit || scanning || submitting" @click="handleSubmit">
        <Spinner v-if="submitting" :size="14" />
        {{ $t("albums.startImport") }}
      </Button>
    </template>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch, type Component } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Box, Check, Folder, FolderPlus, RefreshCw, Store, User, X } from "@lucide/vue";
import { Alert, Button, Dialog, Field, Skeleton, Spinner, Switch, Tooltip } from "@/components/ui";
import { kameMessage } from "@/utils/kameMessage";
import { invoke } from "@/api";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useCrawlerStore } from "@/stores/crawler";
import { HIDDEN_ALBUM_ID } from "@/services/albums";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";
import AlbumPicker from "@/components/albums/AlbumPicker.vue";
import SectionTitle from "@/components/ui/SectionTitle.vue";

/** 与后端 `WpeSourceInfo` 对应。 */
interface WpeSourceInfo {
  kind: string;
  paths: string[];
  total: number;
  /** 入口存在的视频壁纸数量。 */
  video: number;
  /** 入口存在的网页壁纸数量。 */
  web: number;
  /** 入口存在（散文件或 `scene.pkg`）的场景壁纸数量。 */
  scene: number;
  /** 已支持的类型（视频 / 网页 / 场景）中尚未入库的数量。 */
  pending: number;
  imported: number;
}

interface WpeScanResult {
  sources: WpeSourceInfo[];
}

const props = defineProps<{
  modelValue: boolean;
}>();

const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
}>();

const { t } = useI18n();
/** 开关只跟随 v-model；层级与 Android 返回栈由 Dialog 自己接 */
const open = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit("update:modelValue", v),
});

// 卡片与计数标签的类：中性外框，强调色只用于选中与「待导入」计数
const CARD_CLASS =
  "box-border flex items-start gap-3 rounded-kb-lg border border-solid px-3 py-2.5 outline-none transition-[border-color,background-color] duration-150 focus-visible:ring-2 focus-visible:ring-kb-ring";
const CARD_IDLE_CLASS = "border-kb-line-strong bg-kb-surface-raised hover:border-kb-fg-subtle hover:bg-kb-hover";
const CARD_SELECTED_CLASS = "border-kb-accent bg-[color-mix(in_srgb,var(--kb-accent)_5%,var(--kb-surface-raised))]";
const ICON_CLASS =
  "grid size-9 shrink-0 place-items-center rounded-kb-md bg-kb-fill text-kb-fg-muted [&_svg]:size-[18px]";
const CHIP_CLASS = "rounded-full px-2 text-[11px] leading-[18px]";
const CHIP_TONES: Record<"plain" | "primary" | "muted", string> = {
  plain: "bg-kb-fill text-kb-fg-muted",
  primary: "bg-[color-mix(in_srgb,var(--kb-accent)_12%,transparent)] text-kb-accent font-500",
  muted: "bg-kb-fill-light text-kb-fg-subtle",
};

const crawlerStore = useCrawlerStore();
const scanning = ref(false);
const adding = ref(false);
const submitting = ref(false);
const sources = ref<WpeSourceInfo[]>([]);
const selected = reactive<Record<string, boolean>>({});
const extraDirs = ref<WpeSourceInfo[]>([]);
const outputAlbumId = ref<string | null>(null);
const isDryRun = ref(false);

const labelForKind: Record<string, string> = {
  workshop: "gallery.wpeSourceWorkshop",
  defaultprojects: "gallery.wpeSourceDefaultProjects",
  myprojects: "gallery.wpeSourceMyProjects",
};

const iconByKind: Record<string, Component> = {
  workshop: Store,
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

/**
 * 计数小标签：壁纸总数 / 待导入（已支持类型且未入库，为 0 时置灰）/ 按类型分布（为 0 的类型省略，
 * 都为 0 时不显示）/ 已导入（为 0 时不显示）。
 */
function statChips(source: WpeSourceInfo): { tone: "plain" | "primary" | "muted"; text: string }[] {
  const chips: { tone: "plain" | "primary" | "muted"; text: string }[] = [
    { tone: "plain", text: t("gallery.wpeStatTotal", { n: source.total }) },
    { tone: source.pending > 0 ? "primary" : "muted", text: t("gallery.wpeStatImportable", { n: source.pending }) },
  ];
  const kinds = [
    { n: source.video ?? 0, kind: t("gallery.wpeKindVideo") },
    { n: source.web ?? 0, kind: t("gallery.wpeKindWeb") },
    { n: source.scene ?? 0, kind: t("gallery.wpeKindScene") },
  ]
    .filter((item) => item.n > 0)
    .map((item) => t("gallery.wpeStatKinds", item));
  if (kinds.length) chips.push({ tone: "plain", text: kinds.join(" · ") });
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
    kameMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    if (seq === scanSeq) scanning.value = false;
  }
}

async function handleAddFolder() {
  if (await guardDesktopOnly("localImport")) return;
  try {
    const picked = await openFileDialog({ directory: true, multiple: false });
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
      kameMessage.error(message.includes("未识别") ? t("gallery.wpeUnsupported") : message);
    }
  } finally {
    adding.value = false;
  }
}

function resetState() {
  sources.value = [];
  extraDirs.value = [];
  outputAlbumId.value = null;
  isDryRun.value = false;
  for (const key of Object.keys(selected)) delete selected[key];
}

async function handleSubmit() {
  if (!canSubmit.value) {
    kameMessage.warning(t("gallery.wpeNoSelection"));
    return;
  }
  if (await guardDesktopOnly("localImport", { needSuper: true })) return;

  const sourceFlags = {
    workshop: sources.value.some((s) => s.kind === "workshop" && isSelected(s)),
    defaultprojects: sources.value.some((s) => s.kind === "defaultprojects" && isSelected(s)),
    myprojects: sources.value.some((s) => s.kind === "myprojects" && isSelected(s)),
  };
  const extraPaths = extraDirs.value.map((source) => source.paths[0]).filter(Boolean);
  // checkbox 校验不接受全 false，缺失又会合并默认的全选：没勾自动来源时传 null，只导入手选文件夹。
  const hasAutoSource = Object.values(sourceFlags).some(Boolean);
  const userConfig: Record<string, unknown> = { sources: hasAutoSource ? sourceFlags : null };
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
      kameMessage.error(t("gallery.wpeTaskFailed"));
      return;
    }
    open.value = false;
    kameMessage.success(t("gallery.wpeTaskAdded"));
  } finally {
    submitting.value = false;
  }
}

// 打开即扫描（每次打开先清掉上次的结果与选择）；关闭时作废还在路上的扫描。
watch(
  () => props.modelValue,
  (visible) => {
    if (visible) {
      resetState();
      void refreshScan();
    } else {
      scanSeq++;
      scanning.value = false;
    }
  },
  { immediate: true },
);
</script>
