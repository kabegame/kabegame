<template>
  <Popover v-model:open="open">
    <div
      :class="['kb-control relative', size === 'sm' ? 'h-7 text-[12.5px]' : 'h-8']"
      :data-disabled="disabled || undefined"
      :data-invalid="field.invalid.value || undefined"
    >
      <PopoverTrigger as-child>
        <button
          type="button"
          :id="field.id.value"
          :disabled="disabled"
          :title="label || placeholder"
          :aria-invalid="field.invalid.value || undefined"
          :aria-describedby="field.describedBy.value"
          class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent px-2.5 text-left text-inherit outline-none [font:inherit]"
        >
          <CalendarDays class="size-4 shrink-0 text-kb-fg-subtle" />
          <span class="min-w-0 flex-1 truncate tabular-nums" :class="label ? '' : 'text-kb-fg-subtle'">
            {{ label || placeholder }}
          </span>
        </button>
      </PopoverTrigger>
      <button
        v-if="clearable && model && !disabled"
        type="button"
        tabindex="-1"
        class="mr-1 grid size-5 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-kb-fg-subtle hover:bg-kb-hover hover:text-kb-fg-muted"
        :aria-label="t('common.clear')"
        @click="model = undefined"
      >
        <X class="size-3.5" />
      </button>
    </div>
    <PopoverContent align="start" :side-offset="4">
      <CalendarRoot
        v-slot="{ weekDays, grid }"
        :model-value="calendarValue"
        :default-placeholder="calendarValue ?? todayDate"
        :locale="calendarLocale"
        :is-date-disabled="isDisabled"
        :week-starts-on="1"
        fixed-weeks
        class="select-none p-1.5"
        @update:model-value="onPick"
      >
        <CalendarHeader class="mb-1.5 flex items-center gap-0.5">
          <CalendarPrev
            :prev-page="(d: DateValue) => d.subtract({ years: 1 })"
            :class="NAV"
            :aria-label="t('common.prevYear')"
          >
            <ChevronsLeft class="size-4" />
          </CalendarPrev>
          <CalendarPrev :class="NAV" :aria-label="t('common.prevMonth')"><ChevronLeft class="size-4" /></CalendarPrev>
          <CalendarHeading class="flex-1 text-center text-[13px] font-600 text-kb-fg" />
          <CalendarNext :class="NAV" :aria-label="t('common.nextMonth')"><ChevronRight class="size-4" /></CalendarNext>
          <CalendarNext
            :next-page="(d: DateValue) => d.add({ years: 1 })"
            :class="NAV"
            :aria-label="t('common.nextYear')"
          >
            <ChevronsRight class="size-4" />
          </CalendarNext>
        </CalendarHeader>
        <CalendarGrid v-for="month in grid" :key="month.value.toString()" class="border-collapse">
          <CalendarGridHead>
            <CalendarGridRow class="flex">
              <CalendarHeadCell
                v-for="day in weekDays"
                :key="day"
                class="w-8 pb-1 text-center text-[11.5px] font-400 text-kb-fg-subtle"
              >
                {{ day }}
              </CalendarHeadCell>
            </CalendarGridRow>
          </CalendarGridHead>
          <CalendarGridBody>
            <CalendarGridRow v-for="(week, i) in month.rows" :key="i" class="flex">
              <CalendarCell v-for="date in week" :key="date.toString()" :date="date" class="p-0">
                <CalendarCellTrigger
                  :day="date"
                  :month="month.value"
                  class="grid size-8 cursor-pointer place-items-center rounded-kb-md text-[12.5px] tabular-nums text-kb-fg outline-none transition-colors duration-100 hover:bg-kb-hover focus-visible:ring-2 focus-visible:ring-kb-ring data-[outside-view]:text-kb-fg-subtle data-[today]:font-700 data-[selected]:!bg-kb-primary data-[selected]:!text-kb-primary-fg data-[disabled]:pointer-events-none data-[disabled]:text-kb-fg-subtle data-[disabled]:opacity-40 data-[unavailable]:line-through"
                />
              </CalendarCell>
            </CalendarGridRow>
          </CalendarGridBody>
        </CalendarGrid>
        <div class="mt-1.5 flex justify-end border-0 border-t border-solid border-kb-line pt-1.5">
          <button
            type="button"
            class="h-6 cursor-pointer rounded-kb-sm border-0 bg-transparent px-2 text-[12px] text-kb-fg-muted [font:inherit] hover:bg-kb-hover hover:text-kb-fg disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="isDisabled(todayDate)"
            @click="onPick(todayDate)"
          >
            {{ t("common.today") }}
          </button>
        </div>
      </CalendarRoot>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
/**
 * 日期选择（v-model 字符串 `YYYY-MM-DD`，未选为 undefined）：按钮显示所选日期，点开是日历气泡。
 * 日历头部 «/» 跳一年、‹/› 跳一月，底部「今天」。不可选的日子用 isDateDisabled（接收 `YYYY-MM-DD`）。
 */
import { computed, ref } from "vue";
import {
  CalendarCell,
  CalendarCellTrigger,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHead,
  CalendarGridRow,
  CalendarHeadCell,
  CalendarHeader,
  CalendarHeading,
  CalendarNext,
  CalendarPrev,
  CalendarRoot,
  PopoverTrigger,
} from "reka-ui";
import { getLocalTimeZone, parseDate, today, type DateValue } from "@internationalized/date";
import { CalendarDays, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, X } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import Popover from "./Popover.vue";
import PopoverContent from "./PopoverContent.vue";
import { useFieldControl } from "./field";

const props = withDefaults(
  defineProps<{
    placeholder?: string;
    clearable?: boolean;
    disabled?: boolean;
    /** 返回 true 的日子不可选；参数是 `YYYY-MM-DD` */
    isDateDisabled?: (date: string) => boolean;
    invalid?: boolean;
    id?: string;
    size?: "sm" | "md";
  }>(),
  { size: "md" },
);

const model = defineModel<string | undefined>();
const open = ref(false);
const { t, locale } = useI18n();
const field = useFieldControl(props);

const NAV =
  "grid size-7 cursor-pointer place-items-center rounded-kb-md border-0 bg-transparent p-0 text-kb-fg-muted outline-none hover:bg-kb-hover hover:text-kb-fg focus-visible:ring-2 focus-visible:ring-kb-ring disabled:cursor-not-allowed disabled:opacity-40";

const LOCALES: Record<string, string> = { zh: "zh-CN", zhtw: "zh-TW", en: "en-US", ja: "ja-JP", ko: "ko-KR" };
const calendarLocale = computed(() => LOCALES[String(locale.value)] ?? "en-US");

const todayDate = computed(() => today(getLocalTimeZone()));

const calendarValue = computed<DateValue | undefined>(() => {
  if (!model.value || !/^\d{4}-\d{2}-\d{2}$/.test(model.value)) return undefined;
  try {
    return parseDate(model.value);
  } catch {
    return undefined;
  }
});

/** 触发器上的文字：按当前语言格式化（2026年11月13日 / Nov 13, 2026） */
const label = computed(() => {
  const v = calendarValue.value;
  if (!v) return "";
  return new Intl.DateTimeFormat(calendarLocale.value, { year: "numeric", month: "short", day: "numeric" }).format(
    v.toDate(getLocalTimeZone()),
  );
});

function isDisabled(date: DateValue): boolean {
  return props.isDateDisabled?.(date.toString()) ?? false;
}

function onPick(value: DateValue | undefined) {
  // 再点一次已选的日子时 Reka 会取消选中；日期选择里没有这种语义，忽略
  if (!value) return;
  model.value = value.toString();
  open.value = false;
}
</script>
