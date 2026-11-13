<template>
  <PopoverRoot :open="shown" @update:open="(value: boolean) => (shown = value)">
    <PopoverAnchor as-child>
      <div
        ref="anchorRef"
        :class="anchorClass ?? ['kb-control', size === 'lg' ? 'h-10' : 'h-8']"
        :data-open="shown || undefined"
        :data-disabled="disabled || undefined"
        @mousedown="focusFromFrame"
      >
        <slot name="prefix" />
        <input
          ref="inputRef"
          v-model="model"
          v-bind="$attrs"
          role="combobox"
          aria-autocomplete="list"
          autocomplete="off"
          spellcheck="false"
          :aria-expanded="shown"
          :aria-controls="listId"
          :aria-activedescendant="active >= 0 && shown ? optionId(active) : undefined"
          :placeholder="placeholder"
          :disabled="disabled"
          :class="
            inputClass ??
            'h-full min-w-0 flex-1 border-0 bg-transparent px-2.5 py-0 text-inherit outline-none [font:inherit] placeholder:text-kb-fg-subtle'
          "
          @focus="open = true"
          @click="open = true"
          @input="onInput"
          @keydown="onKeydown"
          @blur="open = false"
        />
        <button
          v-if="clearable && model && !disabled"
          type="button"
          tabindex="-1"
          class="mr-1 grid size-5 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-kb-fg-subtle hover:bg-kb-hover hover:text-kb-fg-muted"
          :aria-label="t('common.clear')"
          @click="clear"
        >
          <X class="size-3.5" />
        </button>
        <slot name="suffix" />
      </div>
    </PopoverAnchor>
    <PopoverPortal :to="portalTo">
      <PopoverContent
        side="bottom"
        align="start"
        :side-offset="sideOffset"
        :collision-padding="8"
        :reference="anchorRef ?? undefined"
        :class="
          contentClass ??
          'kb-menu-panel max-h-[min(var(--reka-popover-content-available-height),320px)] overflow-y-auto'
        "
        :style="{ zIndex, width: 'var(--reka-popover-trigger-width)' }"
        @open-auto-focus.prevent
        @close-auto-focus.prevent
        @interact-outside="onInteractOutside"
        @mousedown.prevent
      >
        <div :id="listId" role="listbox">
          <div
            v-for="(item, index) in items"
            :id="optionId(index)"
            :key="itemKey(item, index)"
            role="option"
            :aria-selected="index === active"
            :data-highlighted="index === active || undefined"
            :class="itemClass ?? 'kb-menu-item'"
            @pointermove="active = index"
            @click="choose(item)"
          >
            <slot name="item" :item="item" :active="index === active">{{ String(item) }}</slot>
          </div>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<script setup lang="ts" generic="T">
/**
 * 自由输入的补全（地址栏这类）：v-model 是输入框里的文字，`items` 是调用方按文字算好的候选。
 * 和 Combobox 的区别：值就是文字本身，候选只是捷径——
 * - 打字时不自动高亮第一条，回车提交的是输入的原文（emit `submit`）；
 * - 用方向键选中某条后回车、或点某条，才 emit `select`（候选的取值由调用方决定，组件不改 v-model）；
 * - 焦点始终留在输入框里（候选是 aria-activedescendant，面板上按下不夺焦点），输入框失焦即收起。
 *
 * 外观：默认是 `kb-control` 外框 + 菜单面板。`anchorClass` / `contentClass` / `itemClass` / `inputClass`
 * 给了就整体替换默认类（没有 tailwind-merge，叠加覆盖不可靠），适合地址栏这种特殊造型。
 * 外框带 `data-open`，造型里可以用 `data-[open]:` 写面板展开时的样子。
 */
import { computed, ref, watch } from "vue";
import { PopoverAnchor, PopoverContent, PopoverPortal, PopoverRoot, useId } from "reka-ui";
import { X } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import { useModalBack } from "@/composables/useModalBack";
import { foreignPortalTarget, keepOpenOnForeign, useLayerZIndex, usePauseForeignTraps } from "./compat";

defineOptions({ inheritAttrs: false });

const props = withDefaults(
  defineProps<{
    items: T[];
    itemKey?: (item: T, index: number) => string | number;
    placeholder?: string;
    disabled?: boolean;
    clearable?: boolean;
    size?: "md" | "lg";
    sideOffset?: number;
    anchorClass?: string | string[];
    contentClass?: string;
    itemClass?: string;
    inputClass?: string;
  }>(),
  { itemKey: (_item: unknown, index: number) => index, size: "md", sideOffset: 4 },
);

const emit = defineEmits<{
  /** 用方向键选中后回车，或点了某条候选 */
  select: [item: T];
  /** 没有选中候选时回车：提交输入的原文 */
  submit: [text: string];
}>();

const model = defineModel<string>({ default: "" });
/** 想要展开（聚焦、点击、打字）；真正显示还要有候选 */
const open = defineModel<boolean>("open", { default: false });
const shown = computed({
  get: () => open.value && props.items.length > 0,
  set: (value: boolean) => (open.value = value),
});
const { t } = useI18n();
const anchorRef = ref<HTMLElement | null>(null);
const inputRef = ref<HTMLInputElement | null>(null);
/** 键盘高亮的候选；-1 表示没有（回车提交原文） */
const active = ref(-1);
const listId = useId(undefined, "kb-ac");
const optionId = (index: number) => `${listId}-${index}`;

useModalBack(shown);
const zIndex = useLayerZIndex(shown);
usePauseForeignTraps(shown); // TODO:[REF_UI] P9 删
// TODO:[REF_UI] P9 删：输入框在 EP 对话框里时挂进那个对话框（见 compat.ts）
const portalTo = ref<HTMLElement | undefined>();
watch(shown, (value) => {
  if (value) portalTo.value = foreignPortalTarget(anchorRef.value);
  else active.value = -1;
});
// 候选换了一批，旧的高亮下标不再对应同一条
watch(
  () => props.items,
  () => (active.value = -1),
);

function onInput() {
  open.value = true;
  active.value = -1;
}

function move(step: 1 | -1) {
  const count = props.items.length;
  if (!count) return;
  if (!shown.value) {
    open.value = true;
    return;
  }
  active.value = active.value < 0 ? (step > 0 ? 0 : count - 1) : (active.value + step + count) % count;
  document.getElementById(optionId(active.value))?.scrollIntoView({ block: "nearest" });
}

function onKeydown(e: KeyboardEvent) {
  if (e.isComposing) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    move(e.key === "ArrowDown" ? 1 : -1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    const item = shown.value && active.value >= 0 ? props.items[active.value] : undefined;
    open.value = false;
    if (item !== undefined) emit("select", item);
    else emit("submit", model.value);
  } else if (e.key === "Tab") {
    open.value = false;
  }
}

function choose(item: T) {
  open.value = false;
  emit("select", item);
}

function clear() {
  model.value = "";
  active.value = -1;
  inputRef.value?.focus();
}

// 点在输入框 / 外框上不算「层外」（否则按下即关、聚焦又开）
function onInteractOutside(e: Parameters<typeof keepOpenOnForeign>[0]) {
  const target = e.detail?.originalEvent?.target;
  if (target instanceof Node && anchorRef.value?.contains(target)) e.preventDefault();
  else keepOpenOnForeign(e);
}

// 点外框空白处（前后缀之间）也聚焦输入框；前后缀里的按钮照常
function focusFromFrame(e: MouseEvent) {
  const target = e.target as Element;
  if (target === inputRef.value || target.closest("button, a, [role=combobox], [data-kb-autocomplete-keep]")) return;
  e.preventDefault();
  inputRef.value?.focus();
}

defineExpose({
  focus: () => inputRef.value?.focus(),
  close: () => (open.value = false),
});
</script>
