<template>
  <Sheet v-model:open="open" side="bottom" :title="title" hide-close body-class="px-2 pb-3">
    <template #actions>
      <Button variant="primary" size="sm" @click="confirm">{{ confirmText ?? t("common.confirm") }}</Button>
    </template>
    <!-- 颜色、字号经 Vant 的 CSS 变量取 token，不写 .van-* 覆盖 -->
    <VanPicker
      ref="pickerRef"
      v-model="model"
      :columns="columns"
      :show-toolbar="false"
      class="[--van-picker-background:transparent] [--van-picker-option-text-color:var(--kb-fg)] [--van-picker-option-font-size:16px] [--van-picker-option-height:44px] [--van-picker-mask-color:linear-gradient(180deg,rgba(255,255,255,0.92),rgba(255,255,255,0.4)),linear-gradient(0deg,rgba(255,255,255,0.92),rgba(255,255,255,0.4))]"
      @confirm="onConfirm"
    />
  </Sheet>
</template>

<script setup lang="ts" generic="V extends string | number">
/**
 * 底部滚轮选择：Sheet（底部）里放一个 van-picker。标题在 Sheet 顶部，右侧是「确定」；
 * 取消就是关闭（点遮罩、Esc、Android 返回键）。v-model:open 控制开合，v-model 是各列选中的值，
 * 确定时发 confirm（参数同 van-picker 的 confirm）并关闭。
 *
 * TODO:[REF_UI] P9：van-picker 去留待定（待定 6）——滚轮选择没有无头对应物，暂时保留 Vant。
 */
import { ref } from "vue";
// TODO:[REF_UI] P9：van-picker 去留待定（待定 6）
import {
  Picker as VanPicker,
  type PickerColumn,
  type PickerConfirmEventParams,
  type PickerInstance,
  type PickerOption,
} from "vant";
import { useI18n } from "@kabegame/i18n";
import Button from "./Button.vue";
import Sheet from "./Sheet.vue";

defineProps<{
  title?: string;
  /** 单列给选项数组，多列给列数组；级联给带 children 的选项（同 van-picker） */
  columns: (PickerColumn | PickerOption)[];
  confirmText?: string;
}>();

const emit = defineEmits<{ confirm: [params: PickerConfirmEventParams] }>();
const { t } = useI18n();

const open = defineModel<boolean>("open", { default: false });
const model = defineModel<V[]>({ default: () => [] });
const pickerRef = ref<PickerInstance | null>(null);

// 滚轮还在惯性滚动时点确定：picker.confirm() 先停住再按停住的位置发 confirm
function confirm() {
  pickerRef.value?.confirm();
}

function onConfirm(params: PickerConfirmEventParams) {
  open.value = false;
  emit("confirm", params);
}
</script>
