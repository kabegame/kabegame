<template>
  <div class="task-filter-control">
    <el-dropdown v-if="!IS_ANDROID" trigger="click" @command="onDesktopCommand">
      <el-button :class="btnClass">
        <el-icon :class="iconClass">
          <Filter />
        </el-icon>
        <span>{{ currentLabel }}</span>
        <el-icon class="el-icon--right">
          <ArrowDown />
        </el-icon>
      </el-button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item
            v-for="opt in options"
            :key="opt.value"
            :command="opt.value"
            :class="{ 'is-active': modelValue === opt.value }"
          >
            {{ opt.label }}
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
        <Filter />
      </el-icon>
      <span>{{ currentLabel }}</span>
    </el-button>

    <Teleport v-if="IS_ANDROID" to="body">
      <van-popup v-model:show="showPicker" position="bottom" round>
        <van-picker
          v-model="pickerSelected"
          :title="$t('tasks.filterMode')"
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
import { ArrowDown, Filter } from "@element-plus/icons-vue";
import { IS_ANDROID } from "@kabegame/core/env";
import { useModalBack } from "@kabegame/core/composables/useModalBack";

const props = withDefaults(
  defineProps<{
    modelValue: "success" | "failed";
    /** 失败数量（用于显示在失败选项文案中） */
    failedCount?: number;
    variant?: "gallery" | "album";
    androidUi?: "inline" | "header";
  }>(),
  {
    failedCount: 0,
    variant: "gallery",
    androidUi: "inline",
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: "success" | "failed"];
}>();

const { t } = useI18n();
const options = computed(() => [
  { value: "success" as const, label: t("tasks.filterSuccess") },
  { value: "failed" as const, label: `${t("tasks.filterFailed")} (${props.failedCount})` },
]);

const currentLabel = computed(
  () => options.value.find((o) => o.value === props.modelValue)?.label ?? props.modelValue,
);

const btnClass = computed(() =>
  props.variant === "album" ? "album-browse-btn" : "gallery-browse-btn",
);
const iconClass = computed(() =>
  props.variant === "album" ? "album-browse-icon" : "gallery-browse-icon",
);

function onDesktopCommand(cmd: string) {
  if (cmd === "success" || cmd === "failed") {
    emit("update:modelValue", cmd);
  }
}

const showPicker = ref(false);
useModalBack(showPicker);

const pickerColumns = computed(() =>
  options.value.map((o) => ({ text: o.label, value: o.value })),
);
const pickerSelected = ref<string[]>(["success"]);
watch(showPicker, (open) => {
  if (open) pickerSelected.value = [props.modelValue];
});

function onPickerConfirm() {
  showPicker.value = false;
  const v = pickerSelected.value[0];
  if (v === "success" || v === "failed") {
    emit("update:modelValue", v);
  }
}

function openPicker() {
  pickerSelected.value = [props.modelValue];
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
