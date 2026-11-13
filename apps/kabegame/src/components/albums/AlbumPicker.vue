<template>
  <!-- 桌面：触发框下方弹出 -->
  <Popover v-if="!uiStore.isCompact" v-model:open="popoverOpen">
    <PopoverTrigger as-child>
      <TriggerBox ref="triggerRef" />
    </PopoverTrigger>
    <PopoverContent align="start" :width="triggerWidth > 0 ? Math.max(triggerWidth, 280) : 360">
      <!-- 高度跟内容走，超过上限才在树内部滚动：对话框里的选择器不该顶到视口底 -->
      <div class="album-picker-panel flex max-h-[min(360px,50vh)] min-h-0 flex-col gap-1.5 p-0.5">
        <Input v-model="searchText" size="sm" clearable :placeholder="t('albums.treeFilterPlaceholder')">
          <template #prefix><Search /></template>
        </Input>
        <StaticOptions :options="staticOptions" @select="choose" />
        <AlbumTreeView
          v-if="visible"
          v-model:search-text="searchText"
          :selected-id="modelValue"
          :scope="scope"
          :is-selectable="isSelectable"
          :expand-label-dirs="expandLabelDirs"
          :separators="false"
          @select="choose"
        />
      </div>
    </PopoverContent>
  </Popover>

  <template v-else>
    <TriggerBox ref="triggerRef" @click="setVisible(true)" />
    <!-- 紧凑端：居中对话框，或全屏覆盖层（默认） -->
    <Dialog
      v-if="compactPresentation === 'dialog'"
      :open="visible"
      :title="resolvedTitle"
      :width="440"
      body-class="flex min-h-0 flex-col px-4 pb-4 pt-2"
      @update:open="setVisible"
    >
      <div class="album-picker-panel flex max-h-[min(520px,70vh)] min-h-0 flex-col gap-1.5">
        <Input v-model="searchText" clearable :placeholder="t('albums.treeFilterPlaceholder')">
          <template #prefix><Search /></template>
        </Input>
        <StaticOptions :options="staticOptions" @select="choose" />
        <AlbumTreeView
          v-if="visible"
          v-model:search-text="searchText"
          :selected-id="modelValue"
          :scope="scope"
          :is-selectable="isSelectable"
          :expand-label-dirs="expandLabelDirs"
          :separators="false"
          @select="choose"
        />
      </div>
    </Dialog>
    <Sheet
      v-else
      :open="visible"
      side="right"
      size="100vw"
      :title="resolvedTitle"
      body-class="flex min-h-0 flex-col gap-1.5 p-3"
      @update:open="setVisible"
    >
      <Input v-model="searchText" clearable :placeholder="t('albums.treeFilterPlaceholder')">
        <template #prefix><Search /></template>
      </Input>
      <StaticOptions :options="staticOptions" @select="choose" />
      <AlbumTreeView
        v-if="visible"
        v-model:search-text="searchText"
        :selected-id="modelValue"
        :scope="scope"
        :is-selectable="isSelectable"
        :expand-label-dirs="expandLabelDirs"
        :separators="false"
        @select="choose"
      />
    </Sheet>
  </template>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, ref, watch, type ComponentPublicInstance } from "vue";
import { useElementSize } from "@vueuse/core";
import { useI18n } from "@kabegame/i18n";
import { ChevronDown, CircleX, Search } from "@lucide/vue";
import { Dialog, Input, Popover, PopoverContent, PopoverTrigger, Sheet } from "@/components/ui";
import { useUiStore } from "@/stores/ui";
import { fetchAlbum, type AlbumNode } from "@/services/albums";
import AlbumTreeView from "./AlbumTreeView.vue";
import type { AlbumTreeViewScope } from "./types";

const props = withDefaults(
  defineProps<{
    modelValue: string | null;
    scope?: AlbumTreeViewScope;
    isSelectable?: (node: AlbumNode) => boolean;
    /** 标签目录行只展开不选择：只要叶子的选择器开启，目录需对 isSelectable 返回 true 才不被禁用折叠。 */
    expandLabelDirs?: boolean;
    prependOptions?: { value: string; label: string; desc?: string }[];
    allowCreate?: boolean;
    placeholder?: string;
    pickerTitle?: string;
    clearable?: boolean;
    disabled?: boolean;
    /** 紧凑端选择面板的呈现方式；默认保持全屏覆盖层。 */
    compactPresentation?: "overlay" | "dialog";
  }>(),
  {
    scope: () => ({}),
    prependOptions: () => [],
    allowCreate: false,
    clearable: true,
    disabled: false,
    compactPresentation: "overlay",
  },
);
const emit = defineEmits<{ "update:modelValue": [value: string | null] }>();
const { t } = useI18n();
const uiStore = useUiStore();
const visible = ref(false);
const triggerRef = ref<ComponentPublicInstance | null>(null);
const { width: triggerWidth } = useElementSize(triggerRef);
const searchText = ref("");
const selectedName = ref("");
// 弹层（Popover / Dialog / Sheet）各自接 Android 返回栈与层级，这里只管开关
const popoverOpen = computed({
  get: () => visible.value,
  set: (value: boolean) => setVisible(value),
});
const staticOptions = computed(() => [
  ...props.prependOptions,
  ...(props.allowCreate ? [{ value: "__create_new__", label: t("albums.createNewAlbum") }] : []),
]);
let selectedNameToken = 0;
watch(
  () => props.modelValue,
  async (value) => {
    const token = ++selectedNameToken;
    const preset = staticOptions.value.find((option) => option.value === value);
    if (preset) {
      selectedName.value = preset.label;
      return;
    }
    const name = value ? ((await fetchAlbum(value))?.name ?? "") : "";
    if (token === selectedNameToken) selectedName.value = name;
  },
  { immediate: true },
);
const selectedLabel = computed(() => selectedName.value);
const resolvedPlaceholder = computed(() => props.placeholder || t("common.selectPlaceholder"));
const resolvedTitle = computed(() => props.pickerTitle || props.placeholder || t("common.selectPlaceholder"));
function setVisible(value: boolean) {
  if (!props.disabled) visible.value = value;
}
function choose(value: string | null) {
  emit("update:modelValue", value);
  searchText.value = "";
  visible.value = false;
}

/** 触发框：外观同新输入框（kb-control），显示已选画册名或占位；有值且可清空时右侧是清空按钮 */
const TriggerBox = defineComponent({
  name: "AlbumPickerTrigger",
  setup() {
    return () =>
      h(
        "div",
        {
          class: [
            "kb-control h-8 cursor-pointer select-none gap-2 pl-2.5 pr-2 outline-none focus-visible:ring-2 focus-visible:ring-kb-ring",
            visible.value ? "border-kb-fg-muted" : "",
          ],
          tabindex: props.disabled ? -1 : 0,
          role: "combobox",
          "aria-expanded": visible.value,
          "aria-disabled": props.disabled || undefined,
          "data-disabled": props.disabled || undefined,
          onKeydown: (e: KeyboardEvent) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            setVisible(!visible.value);
          },
        },
        [
          h(
            "span",
            { class: ["min-w-0 flex-1 truncate", selectedLabel.value ? "" : "text-kb-fg-subtle"] },
            selectedLabel.value || resolvedPlaceholder.value,
          ),
          props.clearable && props.modelValue
            ? h(
                "button",
                {
                  type: "button",
                  tabindex: -1,
                  class:
                    "grid size-5 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-kb-fg-subtle hover:bg-kb-hover hover:text-kb-fg-muted",
                  "aria-label": t("common.clear"),
                  onClick: (e: MouseEvent) => {
                    e.stopPropagation();
                    choose(null);
                  },
                },
                [h(CircleX, { class: "size-3.5" })],
              )
            : h(ChevronDown, {
                class: [
                  "size-4 shrink-0 text-kb-fg-subtle transition-transform duration-150",
                  visible.value ? "rotate-180" : "",
                ],
              }),
        ],
      );
  },
});

const StaticOptions = defineComponent({
  props: { options: { type: Array as () => { value: string; label: string; desc?: string }[], required: true } },
  emits: ["select"],
  setup(componentProps, { emit: childEmit }) {
    return () =>
      componentProps.options.length
        ? h(
            "div",
            { class: "flex flex-col py-1" },
            componentProps.options.map((option) =>
              h(
                "button",
                {
                  type: "button",
                  class:
                    "min-h-9 cursor-pointer rounded-kb-md border-0 bg-transparent px-2.5 py-1.5 text-left [font:inherit] text-kb-fg hover:bg-kb-hover",
                  onClick: () => childEmit("select", option.value),
                },
                [
                  h("span", { class: "block text-[13px]" }, option.label),
                  option.desc ? h("span", { class: "block text-[11.5px] text-kb-fg-muted" }, option.desc) : null,
                ],
              ),
            ),
          )
        : null;
  },
});
</script>

<style scoped>
/* 弹层高度跟内容走、超过上限再在树内部滚动。
 * 树那条链上用的是 flex-1（= flex:1 1 0%），basis 为 0 时在 auto 高度的容器里
 * 撑不出任何高度，整个面板会塌成一条。这里只把 basis 改回 auto，grow/shrink
 * 原样保留：没到上限时按内容高，到了上限 min-height:0 让树的滚动区接管滚动。
 * 不要图省事写 :deep(.flex-1) —— 行里的 <span class="flex-1"/> 是把计数顶到右边的
 * 横向撑杆，basis 一改右对齐就没了。树面板的第一个子元素就是它的滚动区。 */
.album-picker-panel :deep(.album-tree-view),
.album-picker-panel :deep(.album-tree-view > *),
.album-picker-panel :deep(.kb-tree-panel > :first-child) {
  flex-basis: auto;
}
</style>
