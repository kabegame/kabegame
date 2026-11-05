<template>
  <CollapsibleDrawerPanel
    class="wpe-props-panel"
    storage-key="kabegame-image-detail-wpe-props-open"
    :collapsible="collapsible"
    :fill-when-expanded="fillWhenExpanded"
    :toggle-aria-label="t('gallery.wpePropsTitle')"
  >
    <template #title>{{ t("gallery.wpePropsTitle") }}</template>
    <template #trailing>
      <el-button v-if="anyModified" text size="small" class="!px-2" @click="resetAll">
        <el-icon class="mr-1"><RefreshLeft /></el-icon>
        <span>{{ t("gallery.wpePropsResetAll") }}</span>
      </el-button>
    </template>

    <!-- 外框 / 标题栏由 CollapsibleDrawerPanel 提供；视觉对齐 ImageNativeMetadataPanel：分组卡片 + 卡片内无边框条目 -->
    <div class="kb-selectable flex min-h-0 flex-auto flex-col gap-3 overflow-y-auto px-4 py-3.5 [scrollbar-width:none]">
      <!-- 控制卡片：只在有实时实例时显示，作者属性为空时也在 -->
      <section
        v-if="paused !== undefined || canCaptureCover || canRestoreCover"
        :class="CARD_CLASS"
        data-testid="wpe-controls"
      >
        <div class="flex flex-col p-1.5">
          <div v-if="paused !== undefined" class="flex items-center gap-2 rounded-lg px-2.5 py-2">
            <span class="min-w-0 flex-1 text-[13px] leading-[1.5] text-[var(--anime-text-primary)]">
              {{ t("gallery.wpePause") }}
            </span>
            <el-switch :model-value="paused" @update:model-value="emit('update:paused', $event === true)" />
          </div>
          <div v-if="canCaptureCover || canRestoreCover" class="flex flex-wrap gap-2 px-2.5 py-2">
            <el-button
              v-if="canCaptureCover"
              size="small"
              data-testid="wpe-set-cover"
              :loading="coverBusy"
              @click="setCover"
            >
              {{ t("gallery.wpeSetCover") }}
            </el-button>
            <el-button
              v-if="canRestoreCover"
              size="small"
              class="!ml-0"
              data-testid="wpe-restore-cover"
              :disabled="coverBusy"
              @click="restoreCover"
            >
              {{ t("gallery.wpeRestoreCover") }}
            </el-button>
          </div>
          <div v-if="isScene && paused !== undefined" class="px-2.5 py-2">
            <el-button size="small" data-testid="wpe-clear-storage" @click="clearStorage">
              {{ t("gallery.wpeClearStorage") }}
            </el-button>
          </div>
        </div>
      </section>

      <div
        v-if="loading && !view"
        class="flex items-center gap-2.5 px-0.5 py-1 text-[13px] text-[var(--anime-text-secondary)]"
      >
        <el-icon class="is-loading text-[var(--anime-primary)]"><Loading /></el-icon>
        <span>{{ t("gallery.nativeMetaLoading") }}</span>
      </div>

      <div
        v-else-if="error && !view"
        class="flex flex-col items-center gap-3 px-4 py-8 text-center text-[12.5px] text-[var(--anime-text-secondary)]"
        role="alert"
      >
        <span>{{ t("gallery.wpePropsLoadFailed") }}</span>
        <code
          class="max-w-full break-all rounded-[7px] border border-solid border-[color-mix(in_srgb,var(--anime-danger)_25%,transparent)] bg-[color-mix(in_srgb,var(--anime-danger)_8%,transparent)] px-2.5 py-1.5 text-[11px] text-[var(--anime-danger)]"
        >
          {{ error }}
        </code>
        <el-button type="primary" size="small" @click="reload">{{ t("common.refresh") }}</el-button>
      </div>

      <div
        v-else-if="view && !sections.length"
        class="px-4 py-8 text-center text-[12.5px] text-[var(--anime-text-muted)]"
      >
        {{ t("gallery.wpePropsEmpty") }}
      </div>

      <section v-for="section in sections" :key="section.key" :class="CARD_CLASS">
        <button
          v-if="section.group"
          type="button"
          class="flex w-full cursor-pointer items-center gap-2 border-0 bg-[linear-gradient(135deg,color-mix(in_srgb,var(--anime-primary)_9%,transparent),color-mix(in_srgb,var(--anime-secondary)_9%,transparent))] px-3 py-2.5 text-left text-[var(--anime-text-primary)] hover:bg-[linear-gradient(135deg,color-mix(in_srgb,var(--anime-primary)_14%,transparent),color-mix(in_srgb,var(--anime-secondary)_14%,transparent))]"
          :aria-expanded="section.open"
          @click="toggleGroup(section.key)"
        >
          <el-icon
            class="flex-none text-[var(--anime-text-secondary)] transition-transform duration-150"
            :class="{ 'rotate-90': section.open }"
          >
            <ArrowRight />
          </el-icon>
          <span class="min-w-0 flex-1 truncate text-[13.5px] font-semibold" :title="wpeLabelText(section.group.label)">
            {{ wpeLabelText(section.group.label) }}
          </span>
          <span
            v-if="section.modifiedCount"
            class="h-1.5 w-1.5 flex-none rounded-full bg-[var(--anime-primary)]"
            :title="t('gallery.wpePropsModified')"
          />
          <span
            class="flex-none whitespace-nowrap rounded-[7px] bg-[color-mix(in_srgb,var(--anime-primary)_16%,transparent)] px-2 py-0.5 text-[11px] font-semibold text-[var(--anime-primary-dark)]"
          >
            {{ section.fieldCount }}
          </span>
        </button>

        <div v-if="section.open" class="flex flex-col p-1.5">
          <template v-for="item in section.items" :key="item.key">
            <div
              v-if="item.kind === 'text'"
              class="wpe-props-html px-2.5 py-2 text-[12px] leading-[1.6] text-[var(--anime-text-secondary)]"
              v-html="sanitizeWpeLabel(item.label)"
            />
            <div
              v-else
              class="flex gap-2 rounded-lg px-2.5 py-2 hover:bg-[color-mix(in_srgb,var(--anime-secondary)_7%,transparent)]"
              :class="isInline(item) ? 'items-center' : 'flex-col'"
            >
              <div class="flex min-w-0 flex-1 items-center gap-1">
                <span
                  class="wpe-props-html min-w-0 flex-1 text-[13px] leading-[1.5] text-[var(--anime-text-primary)]"
                  v-html="sanitizeWpeLabel(item.label)"
                />
                <el-button
                  v-if="isModified(item)"
                  text
                  circle
                  size="small"
                  class="flex-none !text-[var(--anime-text-secondary)] hover:!text-[var(--anime-primary-dark)]"
                  :title="t('gallery.wpePropsReset')"
                  :aria-label="t('gallery.wpePropsReset')"
                  @click="reset(item.key)"
                >
                  <el-icon><RefreshLeft /></el-icon>
                </el-button>
              </div>
              <div :class="isInline(item) ? 'flex flex-none items-center' : 'min-w-0'">
                <WpePropertyField
                  :item="item"
                  :model-value="valueOf(item.key)"
                  @update:model-value="set(item.key, $event)"
                />
              </div>
            </div>
          </template>
        </div>
      </section>
    </div>
  </CollapsibleDrawerPanel>
</template>

<script setup lang="ts">
import { computed, reactive, ref, toRef, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { ElMessage, ElMessageBox } from "@kabegame/element-plus";
import { ArrowRight, Loading, RefreshLeft } from "@kabegame/element-plus-icons";
import { invoke } from "@/api";
import CollapsibleDrawerPanel from "@/components/common/CollapsibleDrawerPanel.vue";
import { useWpeWebProperties, type WpeWebPropertyItem } from "@/composables/useWpeWebProperties";
import { hasWpeUserProperties, isWpeSceneType } from "@/utils/mediaMime";
import { evaluateWpeCondition, sanitizeWpeLabel, wpeLabelText } from "@/utils/wpeProperties";
import type { CoverRegionScope } from "./WallpaperDesktopCanvas.vue";
import WpePropertyField from "./WpePropertyField.vue";

/**
 * 网页与场景壁纸共用的属性面板。`imageType` 传图片的 `type`：场景壁纸（`x-wpe/scene`）不显示 `file` / `directory`
 * 属性——场景渲染器不读用户选的文件，这两类的放行也只对网页壁纸生效（网页壁纸目录索引只收 `x-wpe/web` 行）。
 * 本机语料里场景没有这两类；场景特有的 `scenetexture` / `replacetexture` 后端解析时已跳过，面板看不到。
 *
 * 面板是预览详情与设置页共用的，只管显示：`paused` 由父组件传入，预览控制预览这一份，设置页控制桌面。
 * undefined 表示没有实时实例，不显示暂停与清空脚本存储；清空只对场景提供（网页壁纸的 `localStorage` 没有前缀，
 * 所有网页壁纸共用一份，没法只清一张）。
 *
 * 封面只在预览里设，设置页不传这两个 prop。`coverSource` 包住一次截取：点击时才量区域，命令在它的回调里发出，隐藏与
 * 恢复都在函数内；undefined 时不显示封面按钮。`coverReady` 表示画面确定在实时渲染，为假时只能恢复、不能设为封面：
 * 场景退回预览图时截到的只是作者预览图放大。
 */
const props = withDefaults(
  defineProps<{
    imageId: string;
    imageType?: string | null;
    collapsible?: boolean;
    fillWhenExpanded?: boolean;
    paused?: boolean;
    coverSource?: CoverRegionScope;
    coverReady?: boolean;
  }>(),
  {
    imageType: null,
    collapsible: true,
    fillWhenExpanded: true,
    // 布尔 prop 缺省时 Vue 会转成 false，要写明 undefined 才能表示「没有实时实例」
    paused: undefined,
    coverSource: undefined,
  },
);
const emit = defineEmits<{ "update:paused": [value: boolean] }>();
const { t } = useI18n();
const { view, loading, error, valueOf, isModified, set, reset, resetAll, reload } = useWpeWebProperties(
  toRef(props, "imageId"),
);

/** 分组展开状态（照 WPE 默认折叠，不持久化）；换图清空 */
const opened = reactive<Record<string, boolean>>({});
watch(
  () => props.imageId,
  () => {
    for (const key of Object.keys(opened)) delete opened[key];
  },
);

type Section = {
  key: string;
  group: WpeWebPropertyItem | null;
  items: WpeWebPropertyItem[];
  open: boolean;
  /** 段内可编辑字段数（不含说明行），显示在组标题右侧 */
  fieldCount: number;
  /** 段内改过的字段数：组折叠时用小圆点提示 */
  modifiedCount: number;
};

/** 分组卡片与控制卡片共用的外框 */
const CARD_CLASS =
  "flex-none overflow-hidden rounded-xl border border-solid border-[color-mix(in_srgb,var(--anime-primary)_28%,transparent)] bg-[color-mix(in_srgb,var(--anime-bg-card)_50%,transparent)]";

const isScene = computed(() => isWpeSceneType(props.imageType ?? undefined));

const canCaptureCover = computed(
  () => props.coverSource !== undefined && props.coverReady && hasWpeUserProperties(props.imageType ?? undefined),
);
/** 恢复不需要实时画面：设过封面后退回预览图的场景也要能恢复 */
const canRestoreCover = computed(
  () =>
    props.coverSource !== undefined &&
    hasWpeUserProperties(props.imageType ?? undefined) &&
    view.value?.customCover === true,
);
/** 封面命令进行中：按钮转圈，也挡住重复触发 */
const coverBusy = ref(false);

/** 这张壁纸用得上的条目：场景去掉 `file` / `directory`（见 props 注释） */
const usableItems = computed(() => {
  const items = view.value?.items ?? [];
  return isScene.value ? items.filter((item) => item.kind !== "file" && item.kind !== "directory") : items;
});

/** 照 WPE 分段：遇到 group 开新段；组条件为假整段隐藏，段内条目再各自按条件隐藏，全隐藏的段不显示 */
const sections = computed<Section[]>(() => {
  const all: { key: string; group: WpeWebPropertyItem | null; items: WpeWebPropertyItem[] }[] = [
    { key: "_first", group: null, items: [] },
  ];
  for (const item of usableItems.value) {
    if (item.kind === "group") all.push({ key: item.key, group: item, items: [] });
    else all[all.length - 1].items.push(item);
  }
  return all
    .filter((section) => !section.group?.condition || evaluateWpeCondition(section.group.condition, valueOf))
    .map((section) => {
      const items = section.items.filter((item) => !item.condition || evaluateWpeCondition(item.condition, valueOf));
      const fields = items.filter((item) => item.kind !== "text");
      return {
        ...section,
        items,
        open: !section.group || opened[section.key] === true,
        fieldCount: fields.length,
        modifiedCount: fields.filter(isModified).length,
      };
    })
    .filter((section) => section.items.length > 0);
});

const anyModified = computed(() => usableItems.value.some(isModified));

/** 开关与取色和标签同一行，其余字段放在标签下方（侧栏窄） */
function isInline(item: WpeWebPropertyItem): boolean {
  return item.kind === "bool" || item.kind === "color";
}

function toggleGroup(key: string) {
  opened[key] = !opened[key];
}

/** 存储在宿主的 `file:` 来源里，应用页碰不到：由后端广播，同一张图的全部宿主收到后清空并重启脚本。 */
async function clearStorage() {
  try {
    await ElMessageBox.confirm(t("gallery.wpeClearStorageConfirm"), t("gallery.wpeClearStorage"), { type: "warning" });
  } catch {
    return;
  }
  try {
    await invoke("wpe_scene_clear_storage", { imageId: props.imageId });
    ElMessage.success(t("gallery.wpeClearStorageDone"));
  } catch (failure) {
    ElMessage.error(`${t("gallery.wpeClearStorageFailed")}: ${String(failure)}`);
  }
}

/** 成功后重读视图：`customCover` 以后端为准，这次读取排在命令之后，不会被更早的在途读取盖掉 */
async function runCoverCommand(command: () => Promise<unknown>, doneKey: string, failedKey: string) {
  if (coverBusy.value) return;
  coverBusy.value = true;
  try {
    await command();
    ElMessage.success(t(doneKey));
    reload();
  } catch (failure) {
    ElMessage.error(`${t(failedKey)}: ${String(failure)}`);
  } finally {
    coverBusy.value = false;
  }
}

function setCover() {
  const source = props.coverSource;
  if (!source) return;
  const imageId = props.imageId;
  void runCoverCommand(
    () => source((region) => invoke<string>("capture_wallpaper_cover", { imageId, region })),
    "gallery.wpeSetCoverDone",
    "gallery.wpeSetCoverFailed",
  );
}

function restoreCover() {
  const imageId = props.imageId;
  void runCoverCommand(
    () => invoke<string>("restore_wallpaper_cover", { imageId }),
    "gallery.wpeRestoreCoverDone",
    "gallery.wpeRestoreCoverFailed",
  );
}
</script>

<style scoped>
/* 作者文案里的 HTML（已按白名单净化）：标题降到正文字号附近，段落去掉默认外边距 */
.wpe-props-html :deep(:is(h1, h2, h3, h4, h5, h6)) {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.5;
}

.wpe-props-html :deep(:is(p, ul, ol, blockquote, pre)) {
  margin: 0;
}

.wpe-props-html :deep(small) {
  color: var(--anime-text-muted);
  font-size: 11.5px;
}
</style>
