<template>
  <div class="flex flex-wrap items-center gap-3">
    <el-switch
      v-model="followGlobal"
      :active-text="$t('plugins.maxConcurrentDownloadsFollowGlobal', { n: globalMax })"
    />
    <KbNumber
      v-if="!followGlobal"
      v-model="inputValue"
      type="int"
      class="!w-[160px]"
      :min="1"
      :max="10"
      @change="onCommit"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import KbNumber from "@/components/common/form/KbNumber.vue";
import { useSettingsStore } from "@/stores/settings";

/** 任务最大并发下载：null = 跟随全局 */
const model = defineModel<number | null>({ required: true });

const settingsStore = useSettingsStore();
const globalMax = computed(() => Math.max(1, Number(settingsStore.values.maxConcurrentDownloads) || 1));

/** 开关打开即跟随全局；关闭时以当前全局值（不超过 10）为初值 */
const followGlobal = computed<boolean>({
  get: () => model.value == null,
  set: (follow) => {
    model.value = follow ? null : Math.min(globalMax.value, 10);
  },
});

/** 输入框的原始值：编辑中可能是非法文本（string），提交后回到 model */
const inputValue = ref<number | string | undefined>(model.value ?? undefined);
watch(model, (v) => {
  inputValue.value = v ?? undefined;
});

/** 失焦 / 回车 / 步进：change 给出已 clamp 进 [1, 10] 的值；非法文本回退到当前值 */
function onCommit(v: number | undefined) {
  if (v === undefined) {
    inputValue.value = model.value ?? undefined;
    return;
  }
  model.value = v;
}
</script>
