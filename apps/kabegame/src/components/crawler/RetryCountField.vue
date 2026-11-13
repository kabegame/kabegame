<template>
  <div class="flex flex-wrap items-center gap-3">
    <Switch v-model="enabled" :aria-label="$t('plugins.retryOnFail')" />
    <KbNumber
      v-if="enabled"
      v-model="inputValue"
      type="int"
      class="!w-[120px]"
      :min="1"
      :max="MAX_TASK_RETRY_COUNT"
      @change="onCommit"
    />
    <span class="text-[12.5px] text-kb-fg-muted">{{ $t("plugins.retryOnFailDesc") }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import KbNumber from "@/components/common/form/KbNumber.vue";
import Switch from "@/components/ui/Switch.vue";

/** 与后端 `retry::MAX_TASK_RETRY_COUNT` 一致 */
const MAX_TASK_RETRY_COUNT = 10;
/** 打开开关时的初始次数 */
const DEFAULT_RETRY_COUNT = 3;

/** 任务失败重试次数：0 = 关闭，1..10 = 最多重试次数 */
const model = defineModel<number>({ required: true });

const enabled = computed<boolean>({
  get: () => model.value > 0,
  set: (on) => {
    model.value = on ? DEFAULT_RETRY_COUNT : 0;
  },
});

/** 输入框的原始值：编辑中可能是非法文本（string），提交后回到 model */
const inputValue = ref<number | string | undefined>(model.value > 0 ? model.value : undefined);
watch(model, (v) => {
  inputValue.value = v > 0 ? v : undefined;
});

/** 失焦 / 回车 / 步进：change 给出已 clamp 进 [1, 10] 的值；非法文本回退到当前值 */
function onCommit(v: number | undefined) {
  if (v === undefined) {
    inputValue.value = model.value > 0 ? model.value : undefined;
    return;
  }
  model.value = v;
}
</script>
