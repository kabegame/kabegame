<template>
  <TimeFieldRoot
    v-slot="{ segments }"
    :model-value="timeValue"
    :hour-cycle="24"
    granularity="minute"
    locale="en-GB"
    :disabled="disabled"
    :id="field.id.value"
    :aria-invalid="field.invalid.value || undefined"
    :aria-describedby="field.describedBy.value"
    :class="['kb-control gap-0 px-2.5 tabular-nums', size === 'sm' ? 'h-7 text-[12.5px]' : 'h-8']"
    style="width: fit-content"
    :data-disabled="disabled || undefined"
    :data-invalid="field.invalid.value || undefined"
    @update:model-value="onUpdate"
  >
    <Clock class="mr-1.5 size-3.5 shrink-0 text-kb-fg-subtle" />
    <template v-for="item in segments" :key="item.part">
      <TimeFieldInput v-if="item.part === 'literal'" :part="item.part" class="px-px text-kb-fg-subtle">
        {{ item.value }}
      </TimeFieldInput>
      <TimeFieldInput
        v-else
        :part="item.part"
        class="rounded-[4px] px-0.5 outline-none focus:bg-kb-fill-dark data-[placeholder]:text-kb-fg-subtle"
      >
        {{ item.value }}
      </TimeFieldInput>
    </template>
  </TimeFieldRoot>
</template>

<script setup lang="ts">
/**
 * 时间输入（v-model 字符串 `HH:mm`，固定 24 小时制）：时、分两段，各自可键入或上下方向键步进。
 * 原生 type=time 随浏览器 locale 显示，CEF 下会变成 12 小时制「09:05 AM」，所以用 Reka 的 TimeField 并固定格式。
 * 清空某一段时不更新 v-model（时刻总有值）。
 */
import { computed } from "vue";
import { TimeFieldInput, TimeFieldRoot } from "reka-ui";
import { Time } from "@internationalized/date";
import { Clock } from "@lucide/vue";
import { useFieldControl } from "./field";

const props = withDefaults(defineProps<{ disabled?: boolean; invalid?: boolean; id?: string; size?: "sm" | "md" }>(), {
  size: "md",
});
const model = defineModel<string>({ required: true });
const field = useFieldControl(props);

const timeValue = computed(() => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(model.value ?? "");
  return match ? new Time(Number(match[1]), Number(match[2])) : undefined;
});

// 回调类型是 Reka 的 TimeValue（Time / CalendarDateTime / ZonedDateTime），三者都有 hour、minute
function onUpdate(value: { hour: number; minute: number } | undefined) {
  if (!value) return;
  const next = `${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`;
  if (next !== model.value) model.value = next;
}
</script>
