<template>
  <div class="gallery-page-size-control">
    <DropdownMenu v-if="!uiStore.isCompact">
      <DropdownMenuTrigger as-child>
        <Button :class="btnClass">
          <ChartColumn />
          <span>{{ pageSizeLabel }}</span>
          <ChevronDown class="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <MenuRadioGroup :model-value="pageSize" :items="menuItems" @update:model-value="onDesktopSelect" />
      </DropdownMenuContent>
    </DropdownMenu>
    <Button v-else-if="androidUi === 'inline'" :class="btnClass" @click="openPicker">
      <ChartColumn />
      <span>{{ pageSizeLabel }}</span>
    </Button>

    <PickerSheet
      v-if="uiStore.isCompact"
      v-model:open="isOpen"
      v-model="pickerSelected"
      :title="$t('gallery.pageSize')"
      :columns="pickerColumns"
      @confirm="onPickerConfirm"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ChartColumn, ChevronDown } from "@lucide/vue";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  MenuRadioGroup,
  PickerSheet,
} from "@/components/ui";
import { useUiStore } from "@/stores/ui";
import { DEFAULT_GALLERY_PAGE_SIZE, GALLERY_PAGE_SIZE_OPTIONS, isGalleryPageSizeOption } from "@/utils/galleryPageSize";

const props = withDefaults(
  defineProps<{
    pageSize: number;
    /** 与画廊 / 画册工具栏按钮样式一致 */
    variant?: "gallery" | "album";
    /**
     * Android：inline=页面内按钮；header=仅弹层，由父级 ref.openPicker() 或 header fold 触发
     */
    androidUi?: "inline" | "header";
  }>(),
  {
    pageSize: DEFAULT_GALLERY_PAGE_SIZE,
    variant: "gallery",
    androidUi: "inline",
  },
);

const emit = defineEmits<{
  "update:pageSize": [value: number];
}>();

const uiStore = useUiStore();

const options = GALLERY_PAGE_SIZE_OPTIONS;
const pageSizeLabel = computed(() => String(props.pageSize));
const btnClass = computed(() => (props.variant === "album" ? "album-browse-btn" : "gallery-browse-btn"));
const menuItems = options.map((n) => ({ label: String(n), value: n }));

function onDesktopSelect(n: number | undefined) {
  if (n === undefined || !isGalleryPageSizeOption(n)) return;
  emit("update:pageSize", n);
}

const isOpen = ref(false);

const pickerColumns = computed(() => options.map((n) => ({ text: String(n), value: String(n) })));
const pickerSelected = ref<string[]>([String(DEFAULT_GALLERY_PAGE_SIZE)]);
watch(isOpen, (v) => {
  if (v) pickerSelected.value = [String(props.pageSize)];
});

function onPickerConfirm({ selectedValues }: { selectedValues: (string | number)[] }) {
  const v = selectedValues[0];
  const n = Number(v);
  if (!isGalleryPageSizeOption(n)) return;
  emit("update:pageSize", n);
}

function openPicker() {
  pickerSelected.value = [String(props.pageSize)];
  isOpen.value = true;
}

defineExpose({ openPicker });
</script>
