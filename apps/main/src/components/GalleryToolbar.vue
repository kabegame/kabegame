<template>
  <PageHeader title="画廊" :show="showIds" :fold="foldIds" @action="handleAction" sticky>
    <template #subtitle>
      <span>{{ totalCountText }}</span>
    </template>
  </PageHeader>

  <!-- Android：fold 中点击「按时间排序」后弹出的 van-picker -->
  <Teleport v-if="IS_ANDROID" to="body">
    <van-popup v-model:show="showSortPicker" position="bottom" round>
      <van-picker
        v-model="sortPickerSelected"
        title="按时间排序"
        :columns="sortPickerColumns"
        @confirm="onSortPickerConfirm"
        @cancel="showSortPicker = false"
      />
    </van-popup>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import { useHeaderStore, HeaderFeatureId } from "@kabegame/core/stores/header";
import { IS_ANDROID } from "@kabegame/core/env";
import { useModalBack } from "@kabegame/core/composables/useModalBack";

interface Props {
  isLoadingAll?: boolean;
  totalCount?: number;
  bigPageEnabled?: boolean;
  currentPosition?: number; // 当前位置（分页启用时使用）
  monthOptions?: string[];
  monthLoading?: boolean;
  selectedRange?: [string, string] | null; // YYYY-MM-DD
  /** 当前画廊 provider 路径，如 全部、全部/倒序、按时间/2024-01 */
  providerRootPath?: string;
}

const props = withDefaults(defineProps<Props>(), {
  isLoadingAll: false,
  totalCount: 0,
  bigPageEnabled: false,
  currentPosition: 1,
  monthOptions: () => [],
  monthLoading: false,
  selectedRange: null,
  providerRootPath: "",
});

const router = useRouter();
const isAllAsc = computed(() => props.providerRootPath === "全部");
const isAllDesc = computed(() => props.providerRootPath.includes("/desc"));
const sortOrder = computed(() =>
  props.providerRootPath.includes("/desc") ? "desc" : "asc"
);
const sortOptionLabelAsc = "按时间正序";
const sortOptionLabelDesc = "按时间倒序";
function onSortOrderChange(value: string) {
  const basePath = props.providerRootPath.replace("/desc", "") || "all";
  if (value === "desc") {
    router.push({ path: "/gallery", query: { path: `${basePath}/desc/1` } });
  } else {
    router.push({ path: "/gallery", query: { path: `${basePath}/1` } });
  }
}

// Android：fold 中「按时间排序」点击后弹出的 picker
const showSortPicker = ref(false);
useModalBack(showSortPicker);
const sortPickerColumns = [{ text: "按时间正序", value: "asc" }, { text: "按时间倒序", value: "desc" }];
const sortPickerSelected = ref<string[]>(["asc"]);
watch(showSortPicker, (open) => {
  if (open) sortPickerSelected.value = [sortOrder.value];
});
function onSortPickerConfirm() {
  showSortPicker.value = false;
  const v = sortPickerSelected.value[0];
  if (v === "asc" || v === "desc") onSortOrderChange(v);
}

const totalCountText = computed(() => {
  if (props.totalCount === 0) {
    return "暂无图片";
  }
  // 如果启用了分页，显示当前位置
  if (props.bigPageEnabled && props.currentPosition !== undefined) {
    return `第 ${props.currentPosition} / ${props.totalCount}`;
  }
  // 否则显示原来的格式
  return `共 ${props.totalCount} 张图片`;
});

const emit = defineEmits<{
  refresh: [];
  showHelp: [];
  showQuickSettings: [];
  showCrawlerDialog: [];
  showLocalImport: [];
  openCollectMenu: [];
  "update:selectedRange": [value: [string, string] | null];
}>();

const showIds = computed(() => {
  if (IS_ANDROID) {
    return [HeaderFeatureId.Collect, HeaderFeatureId.TaskDrawer];
  }
  return [HeaderFeatureId.GallerySort, HeaderFeatureId.Refresh, HeaderFeatureId.Help, HeaderFeatureId.QuickSettings, HeaderFeatureId.Organize, HeaderFeatureId.TaskDrawer, HeaderFeatureId.Collect];
});

const foldIds = computed(() => {
  if (!IS_ANDROID) return [];
  return [HeaderFeatureId.GallerySort];
});

const headerStore = useHeaderStore();
watch(
  [sortOrder],
  () => {
    if (!IS_ANDROID) return;
    headerStore.setFoldLabel(
      HeaderFeatureId.GallerySort,
      sortOrder.value === "desc" ? sortOptionLabelDesc : sortOptionLabelAsc
    );
  },
  { immediate: true }
);
onUnmounted(() => {
  if (IS_ANDROID) headerStore.setFoldLabel(HeaderFeatureId.GallerySort, undefined);
});

// 处理action事件
const handleAction = (payload: { id: string; data: { type: string; value?: string } }) => {
  switch (payload.id) {
    case HeaderFeatureId.Refresh:
      emit("refresh");
      break;
    case HeaderFeatureId.Collect:
      if (payload.data.type === "openMenu") {
        emit("openCollectMenu");
      } else if (payload.data.type === "select") {
        if (payload.data.value === "local") {
          emit("showLocalImport");
        } else if (payload.data.value === "network") {
          emit("showCrawlerDialog");
        }
      }
      break;
    case HeaderFeatureId.Help:
      emit("showHelp");
      break;
    case HeaderFeatureId.QuickSettings:
      emit("showQuickSettings");
      break;
    case HeaderFeatureId.GallerySort:
      showSortPicker.value = true;
      break;
    case HeaderFeatureId.Organize:
      // 整理由 header 的 OrganizeHeaderControl 处理，此处不会触发（Organize 在 show 中）
      break;
  }
};
</script>

<style scoped lang="scss">
.date-range-filter {
  width: 260px;
  margin-left: 8px;
}

.add-task-btn {
  box-shadow: var(--anime-shadow);

  &:hover {
    transform: translateY(-2px);
    box-shadow: var(--anime-shadow-hover);
  }
}
</style>
