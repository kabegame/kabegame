<template>
  <PageHeader
    :title="$t('tasks.allFailedImages')"
    :subtitle="subtitleText"
    :show="showIds"
    :fold="foldIds"
    sticky
    @action="handleAction"
  />

  <!-- 桌面：筛选工具栏，仅在有失效图片时显示 -->
  <div v-if="!IS_ANDROID && allFailedLength > 0" class="failed-filter-toolbar">
    <el-dropdown trigger="click" @command="onDesktopFilterCommand">
      <el-button class="failed-filter-btn">
        <el-icon class="failed-filter-icon">
          <Filter />
        </el-icon>
        <span>{{ pluginFilterLabel }}</span>
        <el-icon class="el-icon--right">
          <ArrowDown />
        </el-icon>
      </el-button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item command="" :class="{ 'is-active': !filterPluginId }">
            {{ t("gallery.filterAll") }}
            <span class="plugin-count">({{ allFailedLength }})</span>
          </el-dropdown-item>
          <template v-if="pluginGroups.length">
            <el-dropdown-item
              v-for="g in pluginGroups"
              :key="g.pluginId"
              :command="g.pluginId"
              :class="{ 'is-active': filterPluginId === g.pluginId }"
            >
              {{ pluginStore.pluginLabel(g.pluginId) }}
              <span class="plugin-count">({{ g.count }})</span>
            </el-dropdown-item>
          </template>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
  </div>

  <!-- Android：fold 内点选「筛选」弹出 van-picker -->
  <Teleport v-if="IS_ANDROID" to="body">
    <van-popup v-model:show="showFilterPicker" position="bottom" round>
      <van-picker
        v-model="filterPickerSelected"
        :title="$t('gallery.filter')"
        :columns="filterPickerColumns"
        :confirm-button-text="t('common.confirm')"
        :cancel-button-text="t('common.cancel')"
        @confirm="onFilterPickerConfirm"
        @cancel="showFilterPicker = false"
      />
    </van-popup>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch, onUnmounted } from "vue";
import { useI18n } from "@kabegame/i18n";
import { ArrowDown, Filter } from "@element-plus/icons-vue";
import PageHeader from "@kabegame/core/components/common/PageHeader.vue";
import { useHeaderStore, HeaderFeatureId } from "@kabegame/core/stores/header";
import { IS_ANDROID } from "@kabegame/core/env";
import { useModalBack } from "@kabegame/core/composables/useModalBack";
import type { usePluginStore } from "@/stores/plugins";

interface PluginGroup {
  pluginId: string;
  count: number;
}

const props = withDefaults(
  defineProps<{
    subtitleText: string;
    hasPendingInFilter: boolean;
    hasIdleInFilter: boolean;
    pluginFilterLabel: string;
    pluginGroups: PluginGroup[];
    filterPluginId: string | null;
    allFailedLength: number;
    bulkRetryLoading?: boolean;
    bulkDeleteLoading?: boolean;
    pluginStore: ReturnType<typeof usePluginStore>;
  }>(),
  {
    bulkRetryLoading: false,
    bulkDeleteLoading: false,
  }
);

const emit = defineEmits<{
  cancelAll: [];
  retryAll: [];
  deleteAll: [];
  filterCommand: [pluginId: string];
  "quick-settings": [];
}>();

const { t } = useI18n();
const headerStore = useHeaderStore();
const showFilterPicker = ref(false);
useModalBack(showFilterPicker);
const filterPickerSelected = ref<string[]>([""]);

const showIds = computed(() => {
  const ids: HeaderFeatureId[] = [HeaderFeatureId.TaskDrawer];
  if (IS_ANDROID) return ids;
  ids.push(HeaderFeatureId.QuickSettings);
  if (props.hasPendingInFilter) {
    ids.push(HeaderFeatureId.FailedImagesCancelWaiting);
  }
  if (props.hasIdleInFilter) {
    ids.push(HeaderFeatureId.FailedImagesRetryAll);
    ids.push(HeaderFeatureId.FailedImagesDeleteAll);
  }
  return ids;
});

const foldIds = computed(() => {
  if (!IS_ANDROID) return [];
  const ids: HeaderFeatureId[] = [];
  if (props.hasPendingInFilter) {
    ids.push(HeaderFeatureId.FailedImagesCancelWaiting);
  }
  if (props.hasIdleInFilter) {
    ids.push(HeaderFeatureId.FailedImagesRetryAll);
    ids.push(HeaderFeatureId.FailedImagesDeleteAll);
  }
  if (props.pluginGroups.length > 0) {
    ids.push(HeaderFeatureId.FailedImagesFilter);
  }
  ids.push(HeaderFeatureId.QuickSettings);
  return ids;
});

// Android：filter fold label 覆盖
watch(
  () => [props.pluginFilterLabel, props.pluginGroups.length],
  () => {
    if (!IS_ANDROID) return;
    if (props.pluginGroups.length > 0) {
      headerStore.setFoldLabel(
        HeaderFeatureId.FailedImagesFilter,
        props.pluginFilterLabel
      );
    } else {
      headerStore.setFoldLabel(HeaderFeatureId.FailedImagesFilter, undefined);
    }
  },
  { immediate: true }
);
onUnmounted(() => {
  if (!IS_ANDROID) return;
  headerStore.setFoldLabel(HeaderFeatureId.FailedImagesFilter, undefined);
});

const filterPickerColumns = computed(() => {
  const cols: { text: string; value: string }[] = [
    { text: t("gallery.filterAll"), value: "" },
  ];
  for (const g of props.pluginGroups) {
    cols.push({
      text: props.pluginStore.pluginLabel(g.pluginId),
      value: g.pluginId,
    });
  }
  return [cols];
});

function onDesktopFilterCommand(cmd: string) {
  emit("filterCommand", cmd);
}

function onFilterPickerConfirm() {
  const val = filterPickerSelected.value[0] ?? "";
  emit("filterCommand", val);
  showFilterPicker.value = false;
}

function handleAction(payload: { id: string; data: { type: string } }) {
  switch (payload.id) {
    case HeaderFeatureId.FailedImagesCancelWaiting:
      emit("cancelAll");
      break;
    case HeaderFeatureId.FailedImagesRetryAll:
      emit("retryAll");
      break;
    case HeaderFeatureId.FailedImagesDeleteAll:
      emit("deleteAll");
      break;
    case HeaderFeatureId.FailedImagesFilter:
      if (IS_ANDROID) {
        filterPickerSelected.value = [
          props.filterPluginId ?? "",
        ];
        showFilterPicker.value = true;
      }
      break;
    case HeaderFeatureId.TaskDrawer:
      // TaskDrawer 由 header 内组件自身处理，此处不 emit
      break;
    case HeaderFeatureId.QuickSettings:
      emit("quick-settings");
      break;
    default:
      break;
  }
}
</script>

<style scoped lang="scss">
.failed-filter-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.failed-filter-btn {
  .failed-filter-icon {
    margin-right: 6px;
    font-size: 14px;
  }
}

:deep(.plugin-count) {
  margin-left: 4px;
  opacity: 0.75;
  font-size: 12px;
}
</style>
