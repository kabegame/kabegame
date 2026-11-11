<template>
  <!-- 排序下拉里「颜色」一行的展开区：色桶色块 + 末尾的「其它颜色」。
       只报「用户要按哪个颜色排序」，用色桶段还是现算段由外面的 colorSortFor 定。
       宽度固定为取色面板的宽度：取色面板展开前后色块不跳动。 -->
  <div class="flex w-[300px] max-w-full flex-col gap-2">
    <div class="grid grid-cols-6 gap-1.5">
      <div v-for="bucket in buckets" :key="bucket.hex" class="group relative">
        <button
          type="button"
          :class="[SWATCH_CLASS, selected === bucket.hex ? SWATCH_SELECTED_CLASS : '']"
          :style="{ backgroundColor: `#${bucket.hex}` }"
          :title="labelOf(bucket.hex)"
          :aria-label="labelOf(bucket.hex)"
          :aria-pressed="selected === bucket.hex"
          :data-color="bucket.hex"
          @click="emit('select', bucket.hex)"
        >
          <el-icon v-if="selected === bucket.hex" :class="checkClass(bucket.hex)"><Check /></el-icon>
        </button>
        <!-- 用户保存的色桶可以删：悬停出角标（触屏没有悬停，常显）。popper 挂 layer 类，点它不关排序下拉 -->
        <el-popconfirm
          v-if="!bucket.key"
          placement="bottom"
          :title="t('gallery.colorBucketDeleteConfirm')"
          :confirm-button-text="t('common.confirm')"
          :cancel-button-text="t('common.cancel')"
          confirm-button-type="danger"
          :popper-class="COLOR_BUCKET_LAYER_CLASS"
          :visible="deleteConfirmHex === bucket.hex"
          @update:visible="(v: boolean) => setDeleteConfirm(bucket.hex, v)"
          @confirm="removeBucket(bucket.hex)"
        >
          <template #reference>
            <button
              type="button"
              class="absolute -right-1.5 -top-1.5 h-4 w-4 flex cursor-pointer items-center justify-center border border-[var(--anime-border)] rounded-full border-solid bg-[var(--anime-bg-card)] p-0 text-[9px] text-[var(--anime-text-secondary)] transition-opacity focus-visible:opacity-100 group-hover:opacity-100 hover:text-[var(--anime-danger)]"
              :class="uiStore.isCompact || deleteConfirmHex === bucket.hex ? 'opacity-100' : 'opacity-0'"
              :title="t('gallery.colorBucketDelete')"
              :aria-label="t('gallery.colorBucketDelete')"
              :disabled="deletingHex === bucket.hex"
              :data-delete-color="bucket.hex"
            >
              <el-icon><Close /></el-icon>
            </button>
          </template>
        </el-popconfirm>
      </div>

      <!-- 其它颜色：当前排序的颜色不在色桶里时显示成那个颜色并带选中描边，否则是带「＋」的空块 -->
      <button
        type="button"
        :class="[
          SWATCH_CLASS,
          otherColor ? SWATCH_SELECTED_CLASS : 'border-dashed bg-transparent text-[var(--anime-text-secondary)]',
        ]"
        :style="otherColor ? { backgroundColor: `#${otherColor}` } : undefined"
        :title="otherTitle"
        :aria-label="otherTitle"
        :aria-expanded="pickerOpen"
        data-color-other
        @click="togglePicker"
      >
        <el-icon v-if="otherColor" :class="checkClass(otherColor)"><Check /></el-icon>
        <el-icon v-else><Plus /></el-icon>
      </button>
    </div>

    <div v-if="pickerOpen" class="flex flex-col gap-2">
      <!-- 取色面板内部是定宽的；极窄的屏上让它自己横向滚动，不撑破对话框 -->
      <div class="max-w-full overflow-x-auto">
        <el-color-picker-panel
          v-model="pickerColor"
          :border="false"
          :show-alpha="false"
          :disabled="saving"
          style="padding: 0"
        />
      </div>
      <p class="m-0 text-[11px] text-[var(--anime-text-secondary)] leading-snug" data-color-hint>{{ hintText }}</p>
      <div class="flex justify-end gap-2">
        <el-button size="small" :disabled="!pickedHex || saving" data-color-sort @click="sortByPicked">
          {{ t("gallery.colorSortByThis") }}
        </el-button>
        <el-button
          size="small"
          type="primary"
          :loading="saving"
          :disabled="!pickedHex || saving || !!saveBlockedReason"
          :title="saveBlockedReason ?? undefined"
          data-color-save
          @click="saveAsBucket"
        >
          {{ t("gallery.colorSaveAsBucket") }}
        </el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Check, Close, Plus } from "@kabegame/element-plus-icons";
import { COLOR_BUCKET_LAYER_CLASS } from "@/components/gallery/colorBucketLayer";
import { useModalBack } from "@/composables/useModalBack";
import {
  addColorBucket,
  ColorBucketError,
  deleteColorBucket,
  MAX_CUSTOM_COLOR_BUCKETS,
  normalizeColorHex,
  type ColorBucket,
} from "@/services/colorBuckets";
import { useUiStore } from "@/stores/ui";
import { colorLabel } from "@/utils/galleryFilterLabels";
import { kameMessage as ElMessage } from "@/utils/kameMessage";
import { logger } from "@/utils/logger";
import { isLightColor } from "@/utils/palette";

const props = defineProps<{
  /** 当前排序的颜色（六位小写十六进制）；不是颜色排序时不传。 */
  selected?: string;
  /** 色桶列表：基本色桶在前，用户保存的在后（`color_buckets://` 的顺序）。 */
  buckets: readonly ColorBucket[];
}>();

const emit = defineEmits<{
  /** 用户要按这个颜色排序。 */
  select: [hex: string];
}>();

const { t } = useI18n();
const uiStore = useUiStore();

// 色块始终带细边框：白色等浅色块不会融进面板背景。
const SWATCH_CLASS =
  "h-7 w-full flex cursor-pointer items-center justify-center border border-[var(--anime-border)] rounded-md border-solid p-0 text-xs";
const SWATCH_SELECTED_CLASS = "outline outline-2 outline-offset-1 outline-[var(--anime-primary)]";
/** 取色面板的初值：没有当前颜色可沿用时用它。 */
const DEFAULT_PICKER_COLOR = "#4080ff";

const bucketHexes = computed(() => new Set(props.buckets.map((bucket) => bucket.hex)));
const customCount = computed(() => props.buckets.filter((bucket) => !bucket.key).length);

function labelOf(hex: string) {
  return colorLabel(hex, props.buckets, t);
}

/** 对勾压在色块上：浅色块用深色对勾。 */
function checkClass(hex: string) {
  return isLightColor(hex) ? "text-black/70" : "text-white";
}

// ---------- 其它颜色 ----------
/** 当前排序的颜色不在色桶里：它就是「其它颜色」那一块。 */
const otherColor = computed(() => (props.selected && !bucketHexes.value.has(props.selected) ? props.selected : null));
const otherTitle = computed(() =>
  otherColor.value ? `${t("gallery.colorOther")} · #${otherColor.value}` : t("gallery.colorOther"),
);

const pickerOpen = ref(false);
const pickerColor = ref<string | null>(DEFAULT_PICKER_COLOR);
const pickedHex = computed(() => normalizeColorHex(pickerColor.value));

function togglePicker() {
  pickerOpen.value = !pickerOpen.value;
  // 每次打开从当前排序的颜色起步
  if (pickerOpen.value) pickerColor.value = props.selected ? `#${props.selected}` : DEFAULT_PICKER_COLOR;
}

function sortByPicked() {
  if (pickedHex.value && !saving.value) emit("select", pickedHex.value);
}

// ---------- 保存为色桶 ----------
const saving = ref(false);
/** 「保存为色桶」不可用的原因；可用时为 null。 */
const saveBlockedReason = computed(() => {
  if (pickedHex.value && bucketHexes.value.has(pickedHex.value)) return t("gallery.colorBucketExists");
  if (customCount.value >= MAX_CUSTOM_COLOR_BUCKETS) return t("gallery.colorBucketLimit");
  return null;
});
const hintText = computed(() => saveBlockedReason.value ?? t("gallery.colorAnyHint"));

function errorText(error: unknown) {
  return t(error instanceof ColorBucketError ? error.messageKey : "common.operationFailed");
}

async function saveAsBucket() {
  const hex = pickedHex.value;
  if (!hex || saving.value || saveBlockedReason.value) return;
  // 全库距离在同一个事务里补算，图库很大时要几秒：期间两个按钮都禁用
  saving.value = true;
  try {
    await addColorBucket(hex);
    emit("select", hex);
  } catch (error) {
    // 别处刚把它存成了色桶：用户要的结果已经有了，照常按它排序
    if (error instanceof ColorBucketError && error.code === "exists") {
      emit("select", hex);
      return;
    }
    logger.warn("保存色桶失败:", error);
    ElMessage.error(errorText(error));
  } finally {
    saving.value = false;
  }
}

// ---------- 删除用户保存的色桶 ----------
// 确认框受控，同一时刻只开一个。
const deleteConfirmHex = ref<string | null>(null);
function setDeleteConfirm(hex: string, visible: boolean) {
  if (visible) deleteConfirmHex.value = hex;
  else if (deleteConfirmHex.value === hex) deleteConfirmHex.value = null;
}
useModalBack(
  computed({
    get: () => deleteConfirmHex.value !== null,
    set: (open) => {
      if (!open) deleteConfirmHex.value = null;
    },
  }),
);

const deletingHex = ref<string | null>(null);
async function removeBucket(hex: string) {
  deleteConfirmHex.value = null;
  if (deletingHex.value) return;
  deletingHex.value = hex;
  try {
    // 写完不刷新：色桶列表等 color-buckets-change 事件；正按它排序的视图由查询行校正成现算段
    await deleteColorBucket(hex);
  } catch (error) {
    logger.warn("删除色桶失败:", error);
    ElMessage.error(errorText(error));
  } finally {
    deletingHex.value = null;
  }
}
</script>
