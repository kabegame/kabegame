<template>
  <div class="gallery-page-size-control">
    <el-dropdown v-if="!IS_ANDROID" trigger="click" @command="onDesktopCommand">
      <el-button :class="btnClass">
        <el-icon :class="iconClass">
          <Histogram />
        </el-icon>
        <span>{{ pageSizeLabel }}</span>
        <el-icon class="el-icon--right">
          <ArrowDown />
        </el-icon>
      </el-button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item
            v-for="n in options"
            :key="n"
            :command="String(n)"
            :class="{ 'is-active': pageSize === n }"
          >
            {{ n }}
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
    <el-button
      v-else-if="androidUi === 'inline'"
      :class="btnClass"
      @click="openPicker"
    >
      <el-icon :class="iconClass">
        <Histogram />
      </el-icon>
      <span>{{ pageSizeLabel }}</span>
    </el-button>

    <Teleport v-if="IS_ANDROID" to="body">
      <van-popup v-model:show="showPicker" position="bottom" round>
        <van-picker
          v-model="pickerSelected"
          :title="$t('gallery.pageSize')"
          :columns="pickerColumns"
          :confirm-button-text="t('common.confirm')"
          :cancel-button-text="t('common.cancel')"
          @confirm="onPickerConfirm"
          @cancel="showPicker = false"
        />
      </van-popup>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "@kabegame/i18n";
import { ArrowDown, Histogram } from "@element-plus/icons-vue";
import { useSettingsStore } from "@kabegame/core/stores/settings";
import { IS_ANDROID } from "@kabegame/core/env";
import { useModalBack } from "@kabegame/core/composables/useModalBack";

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
    pageSize: 100,
    variant: "gallery",
    androidUi: "inline",
  },
);

const { t } = useI18n();
const settingsStore = useSettingsStore();
const options = [100, 500, 1000] as const;
const pageSizeLabel = computed(() => String(props.pageSize));
const btnClass = computed(() =>
  props.variant === "album" ? "album-browse-btn" : "gallery-browse-btn",
);
const iconClass = computed(() =>
  props.variant === "album" ? "album-browse-icon" : "gallery-browse-icon",
);

async function onDesktopCommand(cmd: string) {
  const n = Number(cmd);
  if (n !== 100 && n !== 500 && n !== 1000) return;
  await settingsStore.save("galleryPageSize", n);
}

const showPicker = ref(false);
useModalBack(showPicker);

const pickerColumns = computed(() =>
  options.map((n) => ({ text: String(n), value: String(n) })),
);
const pickerSelected = ref<string[]>(["100"]);
watch(showPicker, (open) => {
  if (open) pickerSelected.value = [String(props.pageSize)];
});

async function onPickerConfirm() {
  showPicker.value = false;
  const v = pickerSelected.value[0];
  const n = Number(v);
  if (n !== 100 && n !== 500 && n !== 1000) return;
  await settingsStore.save("galleryPageSize", n);
}

function openPicker() {
  pickerSelected.value = [String(props.pageSize)];
  showPicker.value = true;
}

defineExpose({ openPicker });
</script>

<style scoped lang="scss">
.gallery-browse-btn {
  .gallery-browse-icon {
    margin-right: 6px;
    font-size: 14px;
  }
}

.album-browse-btn {
  .album-browse-icon {
    margin-right: 6px;
    font-size: 14px;
  }
}
</style>
