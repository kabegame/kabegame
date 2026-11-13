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
      <Button v-if="anyModified" variant="ghost" size="sm" @click="resetAll">
        <RotateCcw />
        <span>{{ t("gallery.wpePropsResetAll") }}</span>
      </Button>
    </template>

    <!-- 外框 / 标题栏由 CollapsibleDrawerPanel 提供；视觉对齐 ImageNativeMetadataPanel：分组卡片 + 卡片内无边框条目 -->
    <div
      class="kb-selectable flex min-h-0 flex-auto flex-col gap-3 overflow-y-auto px-3 pb-3 pt-0.5 [scrollbar-width:none]"
    >
      <!-- 恢复默认封面：设过封面才出现，作者属性为空时也在（暂停、设为壁纸封面、清空脚本存储在预览的右键菜单与工具条里） -->
      <section v-if="canRestoreCover" :class="CARD_CLASS" data-testid="wpe-controls">
        <div class="p-2">
          <Button
            data-testid="wpe-restore-cover"
            class="w-full"
            :class="coverBusy && 'pointer-events-none opacity-50'"
            :aria-busy="coverBusy"
            @click="restoreCover"
          >
            <Spinner v-if="coverBusy" :size="16" />
            <RotateCcw v-else />
            <span>{{ t("gallery.wpeRestoreCover") }}</span>
          </Button>
        </div>
      </section>

      <div v-if="loading && !view" class="flex items-center gap-2.5 px-0.5 py-1 text-[13px] text-kb-fg-muted">
        <Spinner :size="16" />
        <span>{{ t("gallery.nativeMetaLoading") }}</span>
      </div>

      <div
        v-else-if="error && !view"
        class="flex flex-col items-center gap-3 px-4 py-8 text-center text-[12.5px] text-kb-fg-muted"
        role="alert"
      >
        <span>{{ t("gallery.wpePropsLoadFailed") }}</span>
        <code
          class="max-w-full break-all rounded-kb-sm bg-kb-fill-light px-2.5 py-1.5 font-mono text-[11px] text-kb-danger"
        >
          {{ error }}
        </code>
        <Button variant="primary" size="sm" @click="reload">{{ t("common.refresh") }}</Button>
      </div>

      <div v-else-if="view && !sections.length" class="px-4 py-8 text-center text-[12.5px] text-kb-fg-subtle">
        {{ t("gallery.wpePropsEmpty") }}
      </div>

      <section v-for="section in sections" :key="section.key" :class="CARD_CLASS">
        <button
          v-if="section.group"
          type="button"
          class="flex w-full cursor-pointer items-center gap-2 border-0 bg-kb-fill-lighter px-3 py-2.5 text-left text-kb-fg [font:inherit] outline-none hover:bg-kb-fill-light focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kb-ring"
          :class="{ 'border-b border-solid border-kb-line': section.open }"
          :aria-expanded="section.open"
          @click="toggleGroup(section.key)"
        >
          <ChevronRight
            class="size-4 flex-none text-kb-fg-subtle transition-transform duration-150"
            :class="{ 'rotate-90': section.open }"
          />
          <span class="min-w-0 flex-1 truncate text-[13px] font-600" :title="wpeLabelText(section.group.label)">
            {{ wpeLabelText(section.group.label) }}
          </span>
          <span
            v-if="section.modifiedCount"
            class="size-1.5 flex-none rounded-full bg-kb-accent"
            :title="t('gallery.wpePropsModified')"
          />
          <span class="flex-none whitespace-nowrap text-[11.5px] text-kb-fg-subtle tabular-nums">
            {{ section.fieldCount }}
          </span>
        </button>

        <div v-if="section.open" class="flex flex-col p-1">
          <template v-for="item in section.items" :key="item.key">
            <div
              v-if="item.kind === 'text'"
              class="wpe-props-html px-2.5 py-2 text-[12px] leading-[1.6] text-kb-fg-muted"
              v-html="sanitizeWpeLabel(item.label)"
            />
            <div
              v-else
              class="flex gap-2 rounded-kb-sm px-2.5 py-2 hover:bg-kb-hover"
              :class="isInline(item) ? 'items-center' : 'flex-col'"
            >
              <div class="flex min-w-0 flex-1 items-center gap-1">
                <span
                  class="wpe-props-html min-w-0 flex-1 text-[13px] leading-[1.5] text-kb-fg"
                  v-html="sanitizeWpeLabel(item.label)"
                />
                <Tooltip v-if="isModified(item)" :content="t('gallery.wpePropsReset')">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    class="flex-none"
                    :aria-label="t('gallery.wpePropsReset')"
                    @click="reset(item.key)"
                  >
                    <RotateCcw />
                  </Button>
                </Tooltip>
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
import { ChevronRight, RotateCcw } from "@lucide/vue";
import { Button, Spinner, Tooltip } from "@/components/ui";
import { invoke } from "@/api";
import CollapsibleDrawerPanel from "@/components/common/CollapsibleDrawerPanel.vue";
import { useWpeWebProperties, type WpeWebPropertyItem } from "@/composables/useWpeWebProperties";
import { hasWpeUserProperties, isWpeSceneType } from "@/utils/mediaMime";
import { evaluateWpeCondition, sanitizeWpeLabel, wpeLabelText } from "@/utils/wpeProperties";
import WpePropertyField from "./WpePropertyField.vue";
import { toast } from "@/components/ui/toast";

/**
 * 网页与场景壁纸共用的属性面板（预览详情与设置页）。`imageType` 传图片的 `type`：场景壁纸（`x-wpe/scene`）不显示
 * `file` / `directory` 属性——场景渲染器不读用户选的文件，这两类的放行也只对网页壁纸生效（网页壁纸目录索引只收
 * `x-wpe/web` 行）。本机语料里场景没有这两类；场景特有的 `scenetexture` / `replacetexture` 后端解析时已跳过，面板看不到。
 *
 * 面板只管作者属性，外加「恢复默认封面」：`restorableCover` 由预览传，设过封面时显示，恢复不需要实时画面，退回预览图的
 * 场景也能恢复；设置页不传。预览的暂停、设为壁纸封面、清空脚本存储在右键菜单与工具条里（由预览弹窗处理）；
 * 桌面的暂停是设置页里单独的一项。
 */
const props = withDefaults(
  defineProps<{
    imageId: string;
    imageType?: string | null;
    collapsible?: boolean;
    fillWhenExpanded?: boolean;
    restorableCover?: boolean;
  }>(),
  {
    imageType: null,
    collapsible: true,
    fillWhenExpanded: true,
  },
);
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

/** 分组卡片与控制卡片共用的外框：中性细线 */
const CARD_CLASS = "flex-none overflow-hidden rounded-kb-md border border-solid border-kb-line";

const isScene = computed(() => isWpeSceneType(props.imageType ?? undefined));

/** `customCover` 跟着封面变化重读（`useWpeWebProperties` 听 `thumbnailPath` 补丁），右键菜单设的封面也会让它出现 */
const canRestoreCover = computed(
  () => props.restorableCover && hasWpeUserProperties(props.imageType ?? undefined) && view.value?.customCover === true,
);
/** 恢复进行中：按钮转圈，也挡住重复触发 */
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

/** 成功后重读视图：`customCover` 以后端为准，这次读取排在命令之后，不会被更早的在途读取盖掉 */
async function restoreCover() {
  if (coverBusy.value) return;
  coverBusy.value = true;
  try {
    await invoke<string>("restore_wallpaper_cover", { imageId: props.imageId });
    toast.success(t("gallery.wpeRestoreCoverDone"));
    reload();
  } catch (failure) {
    toast.error(`${t("gallery.wpeRestoreCoverFailed")}: ${String(failure)}`);
  } finally {
    coverBusy.value = false;
  }
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
  color: var(--kb-fg-subtle);
  font-size: 11.5px;
}
</style>
