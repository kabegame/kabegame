<template>
  <!-- 紧凑端从底部滑出，桌面是对话框；内容同一份 -->
  <component
    :is="uiStore.isCompact ? Sheet : Dialog"
    v-model:open="visible"
    :title="$t('gallery.organizeGallery')"
    v-bind="uiStore.isCompact ? { side: 'bottom', bodyClass: 'px-4 py-1' } : { width: 480 }"
  >
    <div class="flex flex-col">
      <div
        v-for="item in optionItems"
        :key="item.key"
        class="border-0 border-b border-solid border-kb-line py-3.5 last:border-b-0"
      >
        <!-- 整行（标题、说明）都能点着勾选；分段控件放在 label 外，点它不会顺带切换勾选 -->
        <Checkbox v-model="options[item.key]" class="w-full">
          <span class="block text-[13.5px] font-500 leading-5">{{ item.title }}</span>
          <span class="mt-0.5 block text-[12.5px] leading-[1.5] text-kb-fg-muted">{{ item.desc }}</span>
          <span v-if="item.slowHint" class="mt-1 block text-[12px] leading-[1.45] text-kb-fg-subtle">
            {{ item.slowHint }}
          </span>
        </Checkbox>
        <SegmentedControl
          v-if="item.key === 'dedupe' && options.dedupe"
          v-model="options.dedupeKeepNew"
          class="ml-6 mt-2"
          size="sm"
          :options="[
            { label: $t('gallery.dedupeKeepNew'), value: true },
            { label: $t('gallery.dedupeKeepOld'), value: false },
          ]"
        />
      </div>
    </div>
    <div v-if="showRangeSlider" class="mt-1 border-0 border-t border-solid border-kb-line pb-1 pt-3.5">
      <div class="text-[13.5px] font-500 leading-5 text-kb-fg">{{ $t("gallery.organizeRange") }}</div>
      <div class="mb-3 mt-0.5 text-[12.5px] leading-[1.5] text-kb-fg-muted">
        {{ $t("gallery.organizeRangeDesc", { total: totalCount }) }}
      </div>
      <RangeSlider
        v-model="rangeValue"
        :min="0"
        :max="totalCount"
        :step="1000"
        :label="$t('gallery.organizeRange')"
        @commit="onRangeChange"
      />
      <div class="mt-1.5 flex justify-between text-[11.5px] tabular-nums text-kb-fg-subtle">
        <span>{{ rangeValue[0].toLocaleString() }}</span>
        <span>{{ rangeValue[1].toLocaleString() }}</span>
      </div>
    </div>
    <template #footer>
      <Button @click="visible = false">{{ $t("common.cancel") }}</Button>
      <Button variant="primary" :disabled="loading" @click="handleConfirm">
        <Spinner v-if="loading" :size="14" />
        {{ $t("gallery.startOrganize") }}
      </Button>
    </template>
  </component>
</template>

<script setup lang="ts">
import { ref, reactive, watch, computed } from "vue";
import { invoke } from "@/api/rpc";
import { Button, Checkbox, Dialog, RangeSlider, SegmentedControl, Sheet, Spinner } from "@/components/ui";
import { useI18n } from "@kabegame/i18n";
import { useApp } from "@/stores/app";
import { guardDesktopOnly } from "@/utils/desktopOnlyGuard";
import { useUiStore } from "@/stores/ui";

interface Props {
  modelValue: boolean;
  loading?: boolean;
}

interface OrganizeOptions {
  dedupe: boolean;
  dedupeKeepNew: boolean;
  removeMissing: boolean;
  removeUnrecognized: boolean;
  regenThumbnails: boolean;
  regenCompatible: boolean;
  backfillNativeMetadata: boolean;
  recomputePalette: boolean;
  deleteSourceFiles: boolean;
  rangeStart: number | null;
  rangeEnd: number | null;
}

const props = withDefaults(defineProps<Props>(), {
  loading: false,
});

const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  confirm: [options: OrganizeOptions];
}>();

const visible = ref(false);
const totalCount = ref(0);
const rangeValue = ref<[number, number]>([0, 0]);
const appStore = useApp();
const uiStore = useUiStore();
const { t } = useI18n();

const options = reactive({
  dedupe: true, // 默认开启去重
  dedupeKeepNew: true, // 默认保留最新（最大 id）
  removeMissing: true, // 默认开启清除失效
  removeUnrecognized: false,
  regenThumbnails: true, // 默认开启补充缩略图
  regenCompatible: false, // 默认关闭（重量级操作，用户按需选择）
  backfillNativeMetadata: false, // 默认关闭（需逐个读取并解析文件）
  recomputePalette: false, // 默认关闭（需逐张解码图片与视频）
  deleteSourceFiles: false,
});

const showRangeSlider = computed(() => totalCount.value > 4000);

type OptionKey = Exclude<keyof typeof options, "dedupeKeepNew">;

/** 选项行：紧凑端（Android）与桌面的说明文案有几项不同（桌面版带「源文件」等字样） */
const optionItems = computed(() => {
  const compact = uiStore.isCompact;
  const desc = (key: string, hasDesktop: boolean) => t(`gallery.${key}${hasDesktop && !compact ? "Desktop" : ""}`);
  const rows: { key: OptionKey; title: string; desc: string; slowHint?: string }[] = [
    { key: "dedupe", title: t("gallery.dedupe"), desc: desc("dedupeDesc", true) },
    { key: "removeMissing", title: t("gallery.removeMissing"), desc: desc("removeMissingDesc", true) },
    {
      key: "removeUnrecognized",
      title: t("gallery.removeUnrecognized"),
      desc: desc("removeUnrecognizedDesc", true),
      slowHint: t("gallery.removeUnrecognizedSlowHint"),
    },
    { key: "regenThumbnails", title: t("gallery.regenThumbnails"), desc: t("gallery.regenThumbnailsDesc") },
    {
      key: "regenCompatible",
      title: t("gallery.regenCompatible"),
      desc: t("gallery.regenCompatibleDesc"),
      slowHint: t("gallery.regenCompatibleSlowHint"),
    },
    {
      key: "backfillNativeMetadata",
      title: t("gallery.organizeBackfillNativeMetadata"),
      desc: desc("organizeBackfillNativeMetadataDesc", true),
      slowHint: t("gallery.organizeBackfillNativeMetadataSlowHint"),
    },
    {
      key: "recomputePalette",
      title: t("gallery.organizeRecomputePalette"),
      desc: t("gallery.organizeRecomputePaletteDesc"),
      slowHint: t("gallery.organizeRecomputePaletteSlowHint"),
    },
    { key: "deleteSourceFiles", title: t("gallery.deleteSourceFiles"), desc: desc("deleteSourceFilesDesc", true) },
  ];
  return rows;
});

function clampRangePair(val: [number, number]): [number, number] {
  const max = totalCount.value;
  if (max <= 0) {
    return [0, 0];
  }
  let [a, b] = val;
  a = Math.max(0, Math.min(a, max));
  b = Math.max(0, Math.min(b, max));
  if (b < a) {
    [a, b] = [b, a];
  }
  const minSpan = Math.min(1000, max);
  if (b - a < minSpan) {
    b = Math.min(a + minSpan, max);
    if (b - a < minSpan) {
      a = Math.max(0, b - minSpan);
    }
  }
  return [a, b];
}

function onRangeChange(val: [number, number]) {
  rangeValue.value = clampRangePair(val);
}

// 同步 visible 与 modelValue
watch(
  () => props.modelValue,
  async (newVal) => {
    visible.value = newVal;
    if (newVal) {
      try {
        const n = await invoke<number>("get_organize_total_count");
        totalCount.value = n;
        rangeValue.value = clampRangePair([0, n]);
      } catch {
        totalCount.value = 0;
        rangeValue.value = [0, 0];
      }
    }
  },
);

watch(visible, (newVal) => {
  emit("update:modelValue", newVal);
});

const handleConfirm = async () => {
  if (!appStore.isSuper) {
    await guardDesktopOnly("organize");
    return;
  }
  const payload: OrganizeOptions = {
    dedupe: options.dedupe,
    dedupeKeepNew: options.dedupeKeepNew,
    removeMissing: options.removeMissing,
    removeUnrecognized: options.removeUnrecognized,
    regenThumbnails: options.regenThumbnails,
    regenCompatible: options.regenCompatible,
    backfillNativeMetadata: options.backfillNativeMetadata,
    recomputePalette: options.recomputePalette,
    deleteSourceFiles: options.deleteSourceFiles,
    rangeStart: null,
    rangeEnd: null,
  };
  if (showRangeSlider.value) {
    const [a, b] = clampRangePair(rangeValue.value);
    const full = a === 0 && b === totalCount.value;
    if (!full) {
      payload.rangeStart = a;
      payload.rangeEnd = b;
    }
  }
  emit("confirm", payload);
};
</script>
