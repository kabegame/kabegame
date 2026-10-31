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

      <section
        v-for="section in sections"
        :key="section.key"
        class="flex-none overflow-hidden rounded-xl border border-solid border-[color-mix(in_srgb,var(--anime-primary)_28%,transparent)] bg-[color-mix(in_srgb,var(--anime-bg-card)_50%,transparent)]"
      >
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
import { computed, reactive, toRef, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { ArrowRight, Loading, RefreshLeft } from "@kabegame/element-plus-icons";
import CollapsibleDrawerPanel from "@/components/common/CollapsibleDrawerPanel.vue";
import { useWpeWebProperties, type WpeWebPropertyItem } from "@/composables/useWpeWebProperties";
import { evaluateWpeCondition, sanitizeWpeLabel, wpeLabelText } from "@/utils/wpeProperties";
import WpePropertyField from "./WpePropertyField.vue";

const props = withDefaults(defineProps<{ imageId: string; collapsible?: boolean; fillWhenExpanded?: boolean }>(), {
  collapsible: true,
  fillWhenExpanded: true,
});
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

/** 照 WPE 分段：遇到 group 开新段；组条件为假整段隐藏，段内条目再各自按条件隐藏，全隐藏的段不显示 */
const sections = computed<Section[]>(() => {
  const all: { key: string; group: WpeWebPropertyItem | null; items: WpeWebPropertyItem[] }[] = [
    { key: "_first", group: null, items: [] },
  ];
  for (const item of view.value?.items ?? []) {
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

const anyModified = computed(() => view.value?.items.some(isModified) ?? false);

/** 开关与取色和标签同一行，其余字段放在标签下方（侧栏窄） */
function isInline(item: WpeWebPropertyItem): boolean {
  return item.kind === "bool" || item.kind === "color";
}

function toggleGroup(key: string) {
  opened[key] = !opened[key];
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
