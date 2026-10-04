<template>
  <el-popover
    v-if="!uiStore.isCompact"
    :visible="visible"
    trigger="click"
    placement="bottom-start"
    :width="triggerWidth || 360"
    :z-index="modal.zIndex.value"
    :disabled="disabled"
    :persistent="false"
    @update:visible="setVisible"
  >
    <template #reference>
      <div ref="triggerRef" class="el-select el-select--default" :class="{ 'is-disabled': disabled }">
        <div
          class="el-select__wrapper"
          :class="{ 'is-focused': visible, 'is-hovering': hovering, 'is-disabled': disabled }"
          tabindex="0"
          role="combobox"
          :aria-expanded="visible"
          @mouseenter="hovering = true"
          @mouseleave="hovering = false"
          @keydown.enter.prevent="setVisible(!visible)"
        >
          <div class="el-select__selection">
            <div class="el-select__selected-item el-select__placeholder" :class="{ 'is-transparent': !selectedLabel }">
              <span>{{ selectedLabel || resolvedPlaceholder }}</span>
            </div>
          </div>
          <div class="el-select__suffix">
            <el-icon
              v-if="clearable && modelValue"
              class="el-select__caret el-select__icon el-select__clear"
              @click.stop="choose(null)"
            >
              <CircleClose />
            </el-icon>
            <el-icon v-else class="el-select__caret el-select__icon" :class="{ 'is-reverse': visible }">
              <ArrowDown />
            </el-icon>
          </div>
        </div>
      </div>
    </template>
    <!-- 高度跟内容走，超过上限才在树内部滚动：对话框里的选择器不该顶到视口底 -->
    <div class="album-picker-panel flex max-h-[min(360px,50vh)] min-h-0 flex-col gap-1.5">
      <el-input v-model="searchText" clearable :placeholder="t('albums.treeFilterPlaceholder')" />
      <StaticOptions :options="staticOptions" @select="choose" />
      <AlbumTreeView
        v-if="visible"
        v-model:search-text="searchText"
        :selected-id="modelValue"
        :scope="scope"
        :is-selectable="isSelectable"
        @select="choose"
      />
    </div>
  </el-popover>

  <template v-else>
    <div ref="triggerRef" class="el-select el-select--default" :class="{ 'is-disabled': disabled }">
      <div
        class="el-select__wrapper"
        :class="{ 'is-focused': visible, 'is-hovering': hovering, 'is-disabled': disabled }"
        tabindex="0"
        role="combobox"
        :aria-expanded="visible"
        @mouseenter="hovering = true"
        @mouseleave="hovering = false"
        @keydown.enter.prevent="setVisible(!visible)"
        @click="setVisible(true)"
      >
        <div class="el-select__selection">
          <div class="el-select__selected-item el-select__placeholder" :class="{ 'is-transparent': !selectedLabel }">
            <span>{{ selectedLabel || resolvedPlaceholder }}</span>
          </div>
        </div>
        <div class="el-select__suffix">
          <el-icon
            v-if="clearable && modelValue"
            class="el-select__caret el-select__icon el-select__clear"
            @click.stop="choose(null)"
          >
            <CircleClose />
          </el-icon>
          <el-icon v-else class="el-select__caret el-select__icon" :class="{ 'is-reverse': visible }">
            <ArrowDown />
          </el-icon>
        </div>
      </div>
    </div>
    <Teleport to="body">
      <div
        v-if="visible"
        class="fixed inset-0 flex flex-col bg-[var(--anime-surface,#fff)]"
        :style="{ zIndex: modal.zIndex.value }"
      >
        <header class="flex h-14 flex-none items-center gap-3 border-b border-[rgba(120,140,180,0.18)] px-4">
          <button class="border-0 bg-transparent p-1" type="button" @click="setVisible(false)">
            <el-icon><ArrowLeft /></el-icon>
          </button>
          <strong class="min-w-0 flex-1 truncate">{{ resolvedTitle }}</strong>
        </header>
        <div class="flex min-h-0 flex-1 flex-col p-3">
          <el-input v-model="searchText" clearable :placeholder="t('albums.treeFilterPlaceholder')" />
          <StaticOptions :options="staticOptions" @select="choose" />
          <AlbumTreeView
            v-model:search-text="searchText"
            :selected-id="modelValue"
            :scope="scope"
            :is-selectable="isSelectable"
            @select="choose"
          />
        </div>
      </div>
    </Teleport>
  </template>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, ref, watch } from "vue";
import { useElementSize } from "@vueuse/core";
import { useI18n } from "@kabegame/i18n";
import { ArrowDown, ArrowLeft, CircleClose } from "@kabegame/element-plus-icons";
import { useUiStore } from "@/stores/ui";
import { useModal } from "@/composables/useModal";
import { useModalBack } from "@/composables/useModalBack";
import { fetchAlbum, type AlbumNode } from "@/services/albums";
import AlbumTreeView from "./AlbumTreeView.vue";
import type { AlbumTreeViewScope } from "./types";

const props = withDefaults(
  defineProps<{
    modelValue: string | null;
    scope?: AlbumTreeViewScope;
    isSelectable?: (node: AlbumNode) => boolean;
    prependOptions?: { value: string; label: string; desc?: string }[];
    allowCreate?: boolean;
    placeholder?: string;
    pickerTitle?: string;
    clearable?: boolean;
    disabled?: boolean;
  }>(),
  { scope: () => ({}), prependOptions: () => [], allowCreate: false, clearable: true, disabled: false },
);
const emit = defineEmits<{ "update:modelValue": [value: string | null] }>();
const { t } = useI18n();
const uiStore = useUiStore();
const visible = ref(false);
const hovering = ref(false);
const triggerRef = ref<HTMLElement | null>(null);
const { width: triggerWidth } = useElementSize(triggerRef);
const searchText = ref("");
const selectedName = ref("");
const modal = useModal({
  onClose: () => {
    visible.value = false;
  },
});
useModalBack(visible);
watch(visible, (value) => (value ? modal.open() : modal.close()));
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
                  class: "min-h-9 rounded-md border-0 bg-transparent px-2 text-left hover:bg-[rgba(255,107,157,0.07)]",
                  onClick: () => childEmit("select", option.value),
                },
                [
                  h("span", { class: "block text-[13px]" }, option.label),
                  option.desc
                    ? h("span", { class: "block text-[11px] text-[var(--anime-text-muted)]" }, option.desc)
                    : null,
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
 * 原样保留：没到上限时按内容高，到了上限 min-height:0 让 el-scrollbar 接管滚动。
 * 不要图省事写 :deep(.flex-1) —— 行里的 <span class="flex-1"/> 是把计数顶到右边的
 * 横向撑杆，basis 一改右对齐就没了。 */
.album-picker-panel :deep(.album-tree-view),
.album-picker-panel :deep(.album-tree-view > *),
.album-picker-panel :deep(.kb-tree-panel > .el-scrollbar) {
  flex-basis: auto;
}
</style>
