<template>
  <span
    class="kb-filter-dropdown inline-flex min-w-0 flex-none"
    :class="disabled ? 'cursor-not-allowed opacity-55' : ''"
    :data-state="visible ? 'open' : 'closed'"
    :data-selected="isActive || undefined"
    :aria-disabled="disabled || undefined"
  >
    <!-- 面板只写一份：popover 档放进弹层，dialog 档放进对话框主体 -->
    <DefinePanel>
      <div
        ref="panelRef"
        data-kb-filter-panel
        :class="[
          PANEL_VARS,
          'text-kb-fg outline-none',
          $slots.panel
            ? 'max-w-[calc(100vw-32px)]'
            : isDialog
              ? 'w-full'
              : 'min-w-[200px] max-w-[min(360px,calc(100vw-32px))]',
        ]"
        :tabindex="$slots.panel || searchable ? -1 : 0"
        @keydown="handlePanelKeydown"
      >
        <slot v-if="$slots.panel" name="panel" :close="close" />

        <template v-else>
          <div v-if="searchable" class="border-0 border-b border-solid border-kb-line px-2.5 pb-2 pt-2.5">
            <Input ref="searchInputRef" v-model="query" :placeholder="searchPlaceholder" clearable>
              <template #prefix><Search /></template>
            </Input>
          </div>

          <div
            class="overflow-y-auto overscroll-contain p-1.5"
            :class="isDialog ? '' : expandedValue !== null ? 'max-h-[min(72vh,560px)]' : 'max-h-[300px]'"
          >
            <div v-if="loading" class="flex min-h-[112px] items-center justify-center text-kb-fg-muted">
              <Spinner :size="20" />
            </div>

            <template v-else>
              <div class="flex flex-col gap-0.5" role="listbox">
                <button
                  v-if="clearable"
                  type="button"
                  role="option"
                  :class="optionClass(0, modelValue === null, false)"
                  :aria-selected="modelValue === null"
                  :data-highlighted="highlightedIndex === 0 || undefined"
                  data-kb-filter-index="0"
                  @mouseenter="highlightedIndex = 0"
                  @click="selectValue(null)"
                >
                  <span class="min-w-0 truncate">{{ anyLabel }}</span>
                  <span v-if="anyCount != null" :class="countClass(false)">{{ formatCount(anyCount) }}</span>
                </button>

                <template v-for="(option, index) in filteredOptions" :key="option.value">
                  <button
                    type="button"
                    role="option"
                    :class="optionClass(index + optionIndexOffset, modelValue === option.value, option.count === 0)"
                    :aria-selected="modelValue === option.value"
                    :aria-expanded="option.expandable ? expandedValue === option.value : undefined"
                    :data-highlighted="highlightedIndex === index + optionIndexOffset || undefined"
                    :data-kb-filter-index="index + optionIndexOffset"
                    @mouseenter="highlightedIndex = index + optionIndexOffset"
                    @click="activateOption(option)"
                  >
                    <span class="min-w-0 truncate" :class="option.expandable ? 'flex-1' : ''">{{ option.label }}</span>
                    <span v-if="option.count != null" :class="countClass(option.count === 0)">
                      {{ formatCount(option.count) }}
                    </span>
                    <ChevronRight
                      v-if="option.expandable"
                      class="size-3.5 flex-none text-kb-fg-muted transition-transform duration-150"
                      :class="expandedValue === option.value ? 'rotate-90' : ''"
                    />
                  </button>
                  <!-- 展开区：内容由调用侧给；close 让它在完成选择后关掉整个下拉 -->
                  <div
                    v-if="option.expandable && expandedValue === option.value"
                    data-kb-filter-option-panel
                    class="px-2.5 pb-2 pt-1.5"
                    role="group"
                    :aria-label="option.label"
                  >
                    <slot name="option-panel" :option="option" :close="close" />
                  </div>
                </template>
              </div>

              <div
                v-if="filteredOptions.length === 0"
                class="px-[11px] pb-3 pt-3.5 text-center text-[13px] text-kb-fg-muted"
              >
                {{ emptyText }}
              </div>
            </template>
          </div>
        </template>
      </div>
    </DefinePanel>

    <!-- chip：图标 + 维度名 + 限定词 + 取值 + 清除徽章 / 下拉箭头。弹层按它定位（reference），不用 Reka 的触发器 -->
    <Tooltip :content="visible ? '' : title">
      <span
        ref="chipRef"
        :class="chipClass"
        role="button"
        :tabindex="disabled ? -1 : 0"
        :aria-expanded="chipAction === 'toggle' ? undefined : visible"
        :aria-haspopup="chipAction === 'toggle' ? undefined : 'dialog'"
        :aria-label="chipLabel"
        @click="handleChipClick"
        @keydown.enter.prevent="handleChipClick"
        @keydown.space.prevent="handleChipClick"
      >
        <span v-if="$slots.icon" :class="['inline-flex size-4 flex-none [&_svg]:block [&_svg]:size-full', iconColor]">
          <slot name="icon" />
        </span>
        <template v-if="chipDisplay !== 'icon'">
          <span v-if="chipDisplay === 'full'" class="flex-none">{{ chipLabel }}</span>
          <span
            v-if="badge"
            class="inline-flex h-[18px] flex-none items-center rounded-kb-sm bg-kb-hover px-1.5 text-[11.5px] font-500 text-kb-fg-muted"
          >
            {{ badge }}
          </span>
          <span class="min-w-0 truncate" :class="isActive ? '' : 'text-kb-fg-muted'">{{ selectedLabel }}</span>
        </template>
        <!-- 清除徽章：浮在 chip 右上角，不占行内空间 -->
        <button
          v-if="isActive"
          type="button"
          class="absolute -right-[7px] -top-[7px] z-1 box-border grid size-[17px] cursor-pointer place-items-center rounded-full border-2 border-solid border-kb-surface-raised bg-kb-fg-muted p-0 text-white outline-none hover:bg-kb-fg focus-visible:bg-kb-fg"
          :aria-label="anyLabel"
          :disabled="disabled"
          @keydown.stop
          @click.stop="clearSelection"
        >
          <X class="size-[9px]" :stroke-width="3" />
        </button>
        <ChevronDown v-else-if="chipDisplay !== 'icon'" class="size-[13px] flex-none text-kb-fg-muted" />
      </span>
    </Tooltip>

    <PopoverRoot v-if="!isDialog" v-model:open="popoverOpen">
      <PopoverPortal>
        <PopoverContent
          side="bottom"
          align="start"
          :side-offset="6"
          :collision-padding="8"
          :reference="chipRef"
          class="box-border max-h-[var(--reka-popover-content-available-height)] overflow-y-auto overflow-x-hidden rounded-kb-lg bg-kb-surface-raised text-kb-fg shadow-kb-pop outline-none origin-[var(--reka-popover-content-transform-origin)] data-[state=open]:animate-[kb-pop-in_140ms_var(--kb-ease-out)] data-[state=closed]:animate-[kb-pop-out_100ms_ease-in]"
          :style="{ zIndex }"
          @open-auto-focus="onOpenAutoFocus"
          @close-auto-focus="onCloseAutoFocus"
          @pointer-down-outside="onOutside"
          @focus-outside="keepOpenOnToast"
          @interact-outside="onOutside"
        >
          <ReusePanel />
        </PopoverContent>
      </PopoverPortal>
    </PopoverRoot>

    <Dialog
      v-else-if="chipAction !== 'toggle'"
      v-model:open="visible"
      :title="chipLabel"
      :width="480"
      body-class="!px-0 !py-0 max-h-[70vh] overscroll-contain"
      @open-auto-focus="onOpenAutoFocus"
    >
      <ReusePanel />
    </Dialog>
  </span>
</template>

<script setup lang="ts">
/**
 * 过滤 chip 下拉：画廊查询行、高级查询条件行、自动任务页的筛选都用它。
 * chip 本身是触发器；面板是内置的选项列表（可搜索、带计数、可展开选项）或 #panel 自定义内容。
 * 紧凑布局下（kbFilterDropdownContextKey 的 panelMode 为 dialog）面板放进居中对话框。
 *
 * 原在 vendored element-plus 里（KbFilterDropdown，P9 已删包），P3 移到这里用 reka-ui 重写：props / 事件 / 插槽照旧，
 * 去掉了没有调用方的 clickOutsideIgnore（面板里的子层现在都是 Reka 层，本来就算层内）与 #trigger；
 * 组件名仍是 KbFilterDropdown（测试按名字找）。
 */
import { computed, inject, nextTick, ref, unref, watch } from "vue";
import { createReusableTemplate } from "@vueuse/core";
import { PopoverContent, PopoverPortal, PopoverRoot } from "reka-ui";
import { ChevronDown, ChevronRight, Search, X } from "@lucide/vue";
import { useModalBack } from "@/composables/useModalBack";
import Dialog from "./Dialog.vue";
import Input from "./Input.vue";
import Spinner from "./Spinner.vue";
import Tooltip from "./Tooltip.vue";
import { useLayerZIndex, keepOpenOnToast } from "./layer";
import {
  kbFilterDropdownContextKey,
  type KbFilterDropdownOption,
  type KbFilterDropdownOptionPanelSlotProps,
  type KbFilterDropdownPanelSlotProps,
} from "./filterDropdown";

defineOptions({ name: "KbFilterDropdown" });

const props = withDefaults(
  defineProps<{
    modelValue: string | null;
    /** 缺省 []（纯 #panel 插槽用法不需要选项列表） */
    options?: KbFilterDropdownOption[];
    /** chip 的维度名称 */
    chipLabel: string;
    /** chip 的悬停提示：value / icon 档把维度名（乃至取值）从 chip 上收走，全靠这里补回来 */
    title?: string;
    /**
     * chip 的信息密度：full 图标 + 维度名 + 徽章 + 取值（高级查询条件行）；
     * value 图标 + 徽章 + 取值（画廊工具条）；icon 只留图标（清除徽章仍在）。
     */
    chipDisplay?: "full" | "value" | "icon";
    /** dropdown 开面板选值；toggle 不开面板，直接发 toggle（二值维度，如升序 / 降序） */
    chipAction?: "dropdown" | "toggle";
    /** 选中值的展示文案覆盖（options 惰性加载时反查不到 label） */
    selectedLabel?: string;
    /** chip 内维度名与值之间的小胶囊（如搜索维度的「元数据」） */
    badge?: string;
    /** 「任意」行 / 未选中态的文案 */
    anyLabel?: string;
    anyCount?: number;
    /** false：必选的单选器（排序、每页条数）——没有「任意」行、不出清除徽章、chip 不进选中态 */
    clearable?: boolean;
    searchable?: boolean;
    searchPlaceholder?: string;
    emptyText?: string;
    loading?: boolean;
    negated?: boolean;
    disabled?: boolean;
  }>(),
  {
    options: () => [],
    chipDisplay: "full",
    chipAction: "dropdown",
    searchable: false,
    loading: false,
    negated: false,
    disabled: false,
    clearable: true,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string | null];
  open: [];
  close: [];
  /** 仅 chipAction="toggle"：chip 被点 / 回车 / 空格，值怎么翻由调用侧决定 */
  toggle: [];
}>();

const slots = defineSlots<{
  icon?(): unknown;
  panel?(props: KbFilterDropdownPanelSlotProps): unknown;
  /** 可展开选项（expandable）的展开区，只在内置列表形态下渲染 */
  "option-panel"?(props: KbFilterDropdownOptionPanelSlotProps): unknown;
}>();

// 面板中的过滤树（KbTreeRow / GalleryFacetTreeInner）读这组变量：文字、计数、悬停、选中与内置列表同一套颜色
const PANEL_VARS =
  "[--kb-tree-row-color:var(--kb-fg)] [--kb-tree-row-muted-color:var(--kb-fg-subtle)] " +
  "[--kb-tree-row-count-color:var(--kb-fg-muted)] [--kb-tree-row-hover-bg:var(--kb-hover)] " +
  "[--kb-tree-row-hover-color:var(--kb-fg)] [--kb-tree-row-active-color:var(--kb-fg)] " +
  "[--kb-tree-row-active-bg:color-mix(in_srgb,var(--kb-accent)_10%,transparent)]";

// 面板只写一份，popover 档与 dialog 档各用一次（起名是为了测试里能按名字放行）
const [DefinePanel, ReusePanel] = createReusableTemplate({ name: "KbFilterPanel" });
const context = inject(kbFilterDropdownContextKey, {});
const isDialog = computed(() => unref(context.panelMode) === "dialog");

const visible = ref(false);
const query = ref("");
const highlightedIndex = ref(0);
/** 当前展开的可展开选项；同一时间至多一个 */
const expandedValue = ref<string | null>(null);
const panelRef = ref<HTMLElement>();
const chipRef = ref<HTMLElement>();
const searchInputRef = ref<{ focus: () => void }>();

/** 弹层档的开合（dialog 档由 Dialog 自己接返回栈，这里不重复接） */
const popoverOpen = computed({
  get: () => !isDialog.value && visible.value,
  set: (value: boolean) => handleVisibleChange(value),
});
useModalBack(popoverOpen);
const zIndex = useLayerZIndex(popoverOpen);

/**
 * 开合的副作用统一挂在 visible 上：Android 返回键、对话框的 Esc / 遮罩都直接改它，同样要发 close。
 * sync 保持「改值即发事件」的时序。
 */
watch(
  visible,
  (open) => {
    if (open) {
      query.value = "";
      expandedValue.value = null; // 重新打开时收起
      syncHighlightToSelection();
      emit("open");
    } else {
      emit("close");
    }
  },
  { flush: "sync" },
);

const selectedOption = computed(() => props.options.find((option) => option.value === props.modelValue) ?? null);
const hasSelection = computed(() => props.modelValue !== null);
/** 必选模式没有「已选 / 未选」之分：不进选中态、不出清除徽章 */
const isActive = computed(() => props.clearable && hasSelection.value);
const selectedLabel = computed(() =>
  hasSelection.value
    ? (props.selectedLabel ?? selectedOption.value?.label ?? props.modelValue)
    : (props.anyLabel ?? ""),
);
/** 必选模式没有「任意」行，选项索引不整体后移一位 */
const optionIndexOffset = computed(() => (props.clearable ? 1 : 0));
const filteredOptions = computed(() => {
  const normalizedQuery = query.value.trim().toLocaleLowerCase();
  if (!normalizedQuery) return props.options;
  return props.options.filter((option) => option.label.toLocaleLowerCase().includes(normalizedQuery));
});
const navigableValues = computed<(string | null)[]>(() =>
  props.clearable
    ? [null, ...filteredOptions.value.map((option) => option.value)]
    : filteredOptions.value.map((option) => option.value),
);

watch(
  [() => props.modelValue, filteredOptions],
  () => {
    if (visible.value) syncHighlightToSelection();
  },
  { flush: "post" },
);

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) close();
  },
);

// ---- chip 外观 ----
// 没有 tailwind-merge：同一属性的几种取值按状态只给一个，不在同一元素上叠
const chipClass = computed(() => {
  const open = visible.value;
  const active = isActive.value;
  return [
    "relative box-border inline-flex h-8 min-w-0 items-center gap-1.5 whitespace-nowrap rounded-kb-md",
    "border border-solid text-[13px] font-400 leading-none outline-none select-none",
    "backdrop-blur-[10px] transition-[color,border-color,background-color,box-shadow] duration-150",
    "focus-visible:shadow-[0_0_0_2px_var(--kb-ring)]",
    props.chipDisplay === "icon" ? "w-8 justify-center px-0" : "px-2.5",
    props.disabled
      ? "pointer-events-none cursor-not-allowed border-kb-line-strong bg-kb-hover text-kb-fg-muted"
      : [
          "cursor-pointer text-kb-fg",
          open
            ? "border-kb-fg-subtle shadow-[0_0_0_3px_color-mix(in_srgb,var(--kb-fg)_6%,transparent)]"
            : active
              ? "border-[color-mix(in_srgb,var(--kb-accent)_45%,transparent)]"
              : "border-kb-line-strong hover:border-kb-fg-subtle",
          active
            ? "bg-[color-mix(in_srgb,var(--kb-accent)_8%,var(--kb-surface-raised))]"
            : "bg-kb-surface hover:bg-[color-mix(in_srgb,var(--kb-fg)_4%,var(--kb-surface-raised))]",
        ],
  ];
});
/** 图标比维度名弱一档，选中时才转强调色 */
const iconColor = computed(() => (isActive.value ? "text-kb-accent" : "text-kb-fg-muted"));

function optionClass(index: number, selected: boolean, zero: boolean) {
  const highlighted = highlightedIndex.value === index;
  return [
    "box-border flex min-h-8 w-full cursor-pointer items-center justify-between gap-[18px] rounded-kb-md border-0 px-2.5",
    "text-left text-[13px] [font-family:inherit] leading-5",
    selected
      ? "bg-[color-mix(in_srgb,var(--kb-accent)_10%,transparent)]"
      : highlighted
        ? "bg-kb-hover"
        : "bg-transparent hover:bg-kb-hover",
    // 计数为 0：整行灰字（含计数），仍可选
    zero && !selected ? "text-kb-fg-subtle" : "text-kb-fg",
    // 给测试与样式钩子留的状态类
    selected ? "is-selected" : "",
    highlighted ? "is-highlighted" : "",
  ];
}

function countClass(zero: boolean) {
  return [
    "flex-none font-mono text-[12px] font-600 leading-none",
    zero ? "text-kb-fg-subtle" : props.negated ? "text-kb-danger" : "text-kb-fg-muted",
  ];
}

// ---- 开合 ----
function handleVisibleChange(nextVisible: boolean) {
  if (props.disabled && nextVisible) return;
  if (visible.value === nextVisible) return;
  visible.value = nextVisible;
}

function handleChipClick(event: Event) {
  if (props.disabled) return;
  if (props.chipAction === "toggle") {
    event.preventDefault();
    emit("toggle");
    return;
  }
  handleVisibleChange(!visible.value);
}

function close() {
  visible.value = false;
}

/** 点在 chip 上不算外部：交给 chip 的 click 去切换，否则先被关掉、再被 click 打开 */
function isOwnChip(target: EventTarget | null | undefined) {
  return target instanceof Node && !!chipRef.value?.contains(target);
}

type OutsideEvent = Event & { detail?: { originalEvent?: Event } };

/**
 * 面板里再弹出的子层（气泡确认、编辑浮层、选择框）都是 Reka 层，Reka 按层的先后算作层内，不会触发这里。
 * 点在 chip 上不关（交给 chip 的 click 切换）；点在提示消息上不关。
 */
function onOutside(event: OutsideEvent) {
  const target = event.detail?.originalEvent?.target ?? event.target;
  if (isOwnChip(target)) event.preventDefault();
  else keepOpenOnToast(event);
}

/**
 * 面板出现后把焦点收进来，键盘能直接导航。自定义面板若已在 open 事件里自己聚焦了输入框，不抢。
 */
function onOpenAutoFocus(event: Event) {
  event.preventDefault();
  nextTick(() => {
    const panel = panelRef.value;
    if (!panel || panel.contains(document.activeElement)) return;
    if (!slots.panel && props.searchable) searchInputRef.value?.focus();
    else panel.focus();
  });
}

/** 弹层没有 Reka 的触发器（chip 外面套着提示），关闭时自己把焦点还给 chip */
function onCloseAutoFocus(event: Event) {
  event.preventDefault();
  const active = document.activeElement;
  if (!active || active === document.body || panelRef.value?.contains(active)) chipRef.value?.focus();
}

// ---- 键盘导航 ----
function syncHighlightToSelection() {
  const index = navigableValues.value.findIndex((value) => value === props.modelValue);
  highlightedIndex.value = index >= 0 ? index : 0;
}

function moveHighlight(offset: number) {
  const length = navigableValues.value.length;
  if (length === 0) return;
  highlightedIndex.value = (highlightedIndex.value + offset + length) % length;
  nextTick(() => {
    panelRef.value
      ?.querySelector<HTMLElement>(`[data-kb-filter-index="${highlightedIndex.value}"]`)
      ?.scrollIntoView({ block: "nearest" });
  });
}

function handlePanelKeydown(event: KeyboardEvent) {
  // Esc 由弹层 / 对话框自己关
  if (slots.panel || props.loading) return;
  // 展开区里的按键（取色面板的输入框等）归面板内容自己，不当成列表导航
  if (event.target instanceof Element && event.target.closest("[data-kb-filter-option-panel]")) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveHighlight(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    moveHighlight(-1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    activateHighlighted();
  } else if (event.key === " " && event.target === panelRef.value) {
    // 空格只在焦点落在面板容器上时接管：焦点在选项按钮上由原生 click 处理，在搜索框里是输入
    const option = highlightedOption();
    if (!option?.expandable) return;
    event.preventDefault();
    toggleExpanded(option.value);
  }
}

/** 键盘高亮的那一行对应的选项；高亮在「任意」行或列表为空时为 null */
function highlightedOption(): KbFilterDropdownOption | null {
  const value = navigableValues.value[highlightedIndex.value] ?? null;
  if (value === null) return null;
  return filteredOptions.value.find((option) => option.value === value) ?? null;
}

function activateHighlighted() {
  const option = highlightedOption();
  if (option) activateOption(option);
  else selectValue(navigableValues.value[highlightedIndex.value] ?? null);
}

/** 可展开的选项只切换展开，不选中、不关闭；其余选项选中并关闭 */
function activateOption(option: KbFilterDropdownOption) {
  if (option.expandable) toggleExpanded(option.value);
  else selectValue(option.value);
}

function toggleExpanded(value: string) {
  expandedValue.value = expandedValue.value === value ? null : value;
  if (expandedValue.value === null) return;
  // 展开区可能落在滚动区之外，带进视野
  nextTick(() => {
    panelRef.value?.querySelector<HTMLElement>("[data-kb-filter-option-panel]")?.scrollIntoView({ block: "nearest" });
  });
}

function selectValue(value: string | null) {
  emit("update:modelValue", value);
  close();
}

function clearSelection(event: MouseEvent) {
  event.preventDefault();
  emit("update:modelValue", null);
  close();
}

function formatCount(count: number) {
  const formatted = count.toLocaleString("en-US");
  return props.negated ? `−${formatted}` : formatted;
}
</script>
