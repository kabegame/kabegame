<template>
  <el-popover v-if="!uiStore.isCompact" :visible="visible" trigger="click" placement="bottom-start"
    :width="triggerWidth || 360" :z-index="modal.zIndex.value" :disabled="disabled" :persistent="false" @update:visible="setVisible">
    <template #reference><button ref="triggerRef" class="flex min-h-[var(--el-component-size,32px)] w-full cursor-pointer items-center gap-2 rounded-[var(--el-border-radius-base,4px)] border border-[var(--el-border-color)] bg-[var(--el-fill-color-blank)] px-[11px] text-[var(--anime-text-primary)] disabled:cursor-not-allowed disabled:opacity-60" :disabled="disabled" type="button">
      <span class="min-w-0 flex-1 truncate text-left" :class="selectedLabel ? '' : 'text-[var(--anime-text-muted)]'">{{ selectedLabel || resolvedPlaceholder }}</span>
      <span v-if="clearable && modelValue" role="button" tabindex="0" @click.stop="choose(null)" @keydown.enter.stop="choose(null)"><el-icon><Close /></el-icon></span>
      <el-icon><ArrowDown /></el-icon>
    </button></template>
    <div class="flex h-[min(520px,70vh)] min-h-0 flex-col">
      <el-input v-model="searchText" clearable :placeholder="t('albums.treeFilterPlaceholder')" />
      <StaticOptions :options="staticOptions" @select="choose" />
      <AlbumTreeView v-if="visible" v-model:search-text="searchText" :selected-id="modelValue"
        :scope="scope" :is-selectable="isSelectable" @select="choose" />
    </div>
  </el-popover>

  <template v-else>
    <button class="flex min-h-[var(--el-component-size,32px)] w-full cursor-pointer items-center gap-2 rounded-[var(--el-border-radius-base,4px)] border border-[var(--el-border-color)] bg-[var(--el-fill-color-blank)] px-[11px] text-[var(--anime-text-primary)] disabled:cursor-not-allowed disabled:opacity-60" :disabled="disabled" type="button" @click="setVisible(true)">
      <span class="min-w-0 flex-1 truncate text-left" :class="selectedLabel ? '' : 'text-[var(--anime-text-muted)]'">{{ selectedLabel || resolvedPlaceholder }}</span>
      <span v-if="clearable && modelValue" role="button" tabindex="0" @click.stop="choose(null)" @keydown.enter.stop="choose(null)"><el-icon><Close /></el-icon></span>
      <el-icon><ArrowDown /></el-icon>
    </button>
    <Teleport to="body">
      <div v-if="visible" class="fixed inset-0 flex flex-col bg-[var(--anime-surface,#fff)]" :style="{ zIndex: modal.zIndex.value }">
        <header class="flex h-14 flex-none items-center gap-3 border-b border-[rgba(120,140,180,0.18)] px-4">
          <button class="border-0 bg-transparent p-1" type="button" @click="setVisible(false)"><el-icon><ArrowLeft /></el-icon></button>
          <strong class="min-w-0 flex-1 truncate">{{ resolvedTitle }}</strong>
        </header>
        <div class="flex min-h-0 flex-1 flex-col p-3">
          <el-input v-model="searchText" clearable :placeholder="t('albums.treeFilterPlaceholder')" />
          <StaticOptions :options="staticOptions" @select="choose" />
          <AlbumTreeView v-model:search-text="searchText" :selected-id="modelValue" :scope="scope"
            :is-selectable="isSelectable" @select="choose" />
        </div>
      </div>
    </Teleport>
  </template>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, ref, watch } from "vue";
import { useElementSize } from "@vueuse/core";
import { useI18n } from "@kabegame/i18n";
import { ArrowDown, ArrowLeft, Close } from "@kabegame/element-plus-icons";
import { useUiStore } from "@kabegame/core/stores/ui";
import { useModal } from "@kabegame/core/composables/useModal";
import { useModalBack } from "@kabegame/core/composables/useModalBack";
import { fetchAlbum, type AlbumNode } from "@/services/albums";
import AlbumTreeView from "./AlbumTreeView.vue";
import type { AlbumTreeViewScope } from "./types";

const props = withDefaults(defineProps<{
  modelValue: string | null; scope?: AlbumTreeViewScope; isSelectable?: (node: AlbumNode) => boolean;
  prependOptions?: { value: string; label: string; desc?: string }[]; allowCreate?: boolean;
  placeholder?: string; pickerTitle?: string; clearable?: boolean; disabled?: boolean;
}>(), { scope: () => ({}), prependOptions: () => [], allowCreate: false, clearable: true, disabled: false });
const emit = defineEmits<{ "update:modelValue": [value: string | null] }>();
const { t } = useI18n();
const uiStore = useUiStore();
const visible = ref(false);
const triggerRef = ref<HTMLElement | null>(null);
const { width: triggerWidth } = useElementSize(triggerRef);
const searchText = ref("");
const selectedName = ref("");
const modal = useModal({ onClose: () => { visible.value = false; } });
useModalBack(visible);
watch(visible, (value) => value ? modal.open() : modal.close());
const staticOptions = computed(() => [
  ...props.prependOptions,
  ...(props.allowCreate ? [{ value: "__create_new__", label: t("albums.createNewAlbum") }] : []),
]);
let selectedNameToken = 0;
watch(() => props.modelValue, async (value) => {
  const token = ++selectedNameToken;
  const preset = staticOptions.value.find((option) => option.value === value);
  if (preset) { selectedName.value = preset.label; return; }
  const name = value ? (await fetchAlbum(value))?.name ?? "" : "";
  if (token === selectedNameToken) selectedName.value = name;
}, { immediate: true });
const selectedLabel = computed(() => selectedName.value);
const resolvedPlaceholder = computed(() => props.placeholder || t("common.selectPlaceholder"));
const resolvedTitle = computed(() => props.pickerTitle || props.placeholder || t("common.selectPlaceholder"));
function setVisible(value: boolean) { if (!props.disabled) visible.value = value; }
function choose(value: string | null) { emit("update:modelValue", value); searchText.value = ""; visible.value = false; }

const StaticOptions = defineComponent({
  props: { options: { type: Array as () => { value: string; label: string; desc?: string }[], required: true } },
  emits: ["select"],
  setup(componentProps, { emit: childEmit }) {
    return () => componentProps.options.length
      ? h("div", { class: "flex flex-col py-1" }, componentProps.options.map((option) =>
          h("button", { type: "button", class: "min-h-9 rounded-md border-0 bg-transparent px-2 text-left hover:bg-[rgba(255,107,157,0.07)]",
            onClick: () => childEmit("select", option.value) }, [
            h("span", { class: "block text-[13px]" }, option.label),
            option.desc ? h("span", { class: "block text-[11px] text-[var(--anime-text-muted)]" }, option.desc) : null,
          ])))
      : null;
  },
});
</script>
