<template>
  <DialogRoot v-model:open="open">
    <DialogPortal :to="portalTo">
      <DialogOverlay
        data-kb-motion
        class="fixed inset-0 bg-[rgba(10,9,12,0.88)] data-[state=open]:animate-[kb-fade-in_160ms_ease-out] data-[state=closed]:animate-[kb-fade-out_120ms_ease-in]"
        :style="{ zIndex }"
      />
      <DialogContent
        data-kb-trap
        data-kb-motion
        v-bind="NO_DESCRIPTION"
        class="fixed inset-0 box-border select-none text-white outline-none data-[state=open]:animate-[kb-fade-in_160ms_ease-out] data-[state=closed]:animate-[kb-fade-out_120ms_ease-in]"
        :style="{ zIndex }"
        @pointer-down-outside="keepOpenOnForeign"
        @focus-outside="keepOpenOnForeign"
        @interact-outside="keepOpenOnForeign"
        @keydown="onKeydown"
      >
        <DialogTitle class="sr-only">{{ title || t("common.imagePreview") }}</DialogTitle>

        <!-- 舞台：点空白处关闭；滚轮缩放、拖动平移、双击在适应窗口与 2 倍之间切换 -->
        <div
          ref="stageRef"
          class="absolute inset-0 grid place-items-center overflow-hidden"
          :class="dragging ? 'cursor-grabbing' : scale > 1 ? 'cursor-grab' : ''"
          @click.self="open = false"
          @wheel.prevent="onWheel"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        >
          <img
            v-if="current"
            :key="current"
            :src="current"
            alt=""
            draggable="false"
            class="block max-h-[calc(100vh-112px)] max-w-[calc(100vw-128px)] object-contain will-change-transform"
            :class="dragging ? '' : 'transition-transform duration-150 ease-out'"
            :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }"
            @dblclick="toggleZoom"
          />
        </div>

        <div class="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between px-4 py-3">
          <span v-if="images.length > 1" class="text-[13px] tabular-nums text-white/80">
            {{ index + 1 }} / {{ images.length }}
          </span>
          <span v-else />
          <DialogClose as-child>
            <button type="button" :class="ROUND_BUTTON" class="pointer-events-auto" :aria-label="t('common.close')">
              <X />
            </button>
          </DialogClose>
        </div>

        <template v-if="images.length > 1">
          <button
            type="button"
            :class="ROUND_BUTTON"
            class="absolute left-4 top-1/2 -translate-y-1/2"
            :disabled="!canPrev"
            :aria-label="t('common.previousImage')"
            @click="go(-1)"
          >
            <ChevronLeft />
          </button>
          <button
            type="button"
            :class="ROUND_BUTTON"
            class="absolute right-4 top-1/2 -translate-y-1/2"
            :disabled="!canNext"
            :aria-label="t('common.nextImage')"
            @click="go(1)"
          >
            <ChevronRight />
          </button>
        </template>

        <div
          class="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-[rgba(255,255,255,0.1)] p-1 backdrop-blur-md"
        >
          <button type="button" :class="TOOL_BUTTON" :aria-label="t('common.zoomOut')" @click="zoomBy(1 / 1.25)">
            <ZoomOut />
          </button>
          <button
            type="button"
            class="h-8 min-w-14 cursor-pointer rounded-full border-0 bg-transparent px-2 text-[12px] tabular-nums text-white/85 outline-none hover:bg-[rgba(255,255,255,0.12)] focus-visible:ring-2 focus-visible:ring-kb-ring"
            :aria-label="t('common.resetZoom')"
            @click="resetView"
          >
            {{ Math.round(scale * 100) }}%
          </button>
          <button type="button" :class="TOOL_BUTTON" :aria-label="t('common.zoomIn')" @click="zoomBy(1.25)">
            <ZoomIn />
          </button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
/**
 * 看图灯箱（取代 el-image-viewer）：v-model:open + v-model:index，图片是一组 URL。
 * 方向键 / 两侧按钮翻页（loop 关时到头停住），滚轮以光标为中心缩放，放大后拖动平移，双击在适应窗口与 2 倍间切换，
 * 底部显示缩放比例、点它复位；Esc、右上角 ×、点图片外的空白处关闭。
 *
 * 桌面用它；触屏的看图仍用 photoswipe（捏合手势），见 PluginDocRenderer。
 */
import { computed, ref, watch } from "vue";
import { DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui";
import { ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut } from "@lucide/vue";
import { useI18n } from "@kabegame/i18n";
import { useModalBack } from "@/composables/useModalBack";
import { foreignPortalTarget, keepOpenOnForeign, useLayerZIndex, usePauseForeignTraps } from "./compat";

const props = withDefaults(defineProps<{ images: string[]; loop?: boolean; title?: string }>(), { loop: false });

const open = defineModel<boolean>("open", { default: false });
const index = defineModel<number>("index", { default: 0 });
const { t } = useI18n();
// 没有说明文字：显式声明为空，免得 Reka 在控制台警告缺少 Description
const NO_DESCRIPTION = { "aria-describedby": undefined };

useModalBack(open);
const zIndex = useLayerZIndex(open);
usePauseForeignTraps(open); // TODO:[REF_UI] P9 删

// TODO:[REF_UI] P9 删：从 EP 对话框里打开时挂进那个对话框（见 compat.ts）
const portalTo = ref<HTMLElement | undefined>();
watch(
  open,
  (value) => {
    if (value) portalTo.value = foreignPortalTarget(document.activeElement);
  },
  { immediate: true },
);

const ROUND_BUTTON =
  "grid size-10 cursor-pointer place-items-center rounded-full border-0 bg-[rgba(255,255,255,0.1)] p-0 text-white outline-none " +
  "backdrop-blur-md transition-colors hover:bg-[rgba(255,255,255,0.2)] focus-visible:ring-2 focus-visible:ring-kb-ring " +
  "disabled:cursor-default disabled:opacity-30 disabled:hover:bg-[rgba(255,255,255,0.1)] [&_svg]:size-5";
const TOOL_BUTTON =
  "grid size-8 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-white/85 outline-none " +
  "hover:bg-[rgba(255,255,255,0.12)] focus-visible:ring-2 focus-visible:ring-kb-ring [&_svg]:size-4";

const current = computed(() => props.images[index.value] ?? "");
const canPrev = computed(() => props.loop || index.value > 0);
const canNext = computed(() => props.loop || index.value < props.images.length - 1);

function go(step: number) {
  const n = props.images.length;
  if (!n) return;
  const next = index.value + step;
  if (props.loop) index.value = (next + n) % n;
  else if (next >= 0 && next < n) index.value = next;
}

// ---- 缩放与平移（以图片中心为变换原点，tx / ty 是相对居中位置的偏移） ----
const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
const scale = ref(1);
const tx = ref(0);
const ty = ref(0);
const stageRef = ref<HTMLElement | null>(null);

function resetView() {
  scale.value = 1;
  tx.value = 0;
  ty.value = 0;
}
watch([index, open], resetView);

/** 以舞台上的点 (cx, cy)（相对舞台中心）为不动点缩放 */
function zoomAt(factor: number, cx = 0, cy = 0) {
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale.value * factor));
  const k = next / scale.value;
  tx.value = cx - (cx - tx.value) * k;
  ty.value = cy - (cy - ty.value) * k;
  scale.value = next;
  if (next === 1) {
    tx.value = 0;
    ty.value = 0;
  }
}

const zoomBy = (factor: number) => zoomAt(factor);

function stagePoint(e: MouseEvent) {
  const rect = stageRef.value?.getBoundingClientRect();
  if (!rect) return { x: 0, y: 0 };
  return { x: e.clientX - rect.left - rect.width / 2, y: e.clientY - rect.top - rect.height / 2 };
}

function onWheel(e: WheelEvent) {
  const { x, y } = stagePoint(e);
  zoomAt(Math.exp(-e.deltaY * 0.0015), x, y);
}

function toggleZoom(e: MouseEvent) {
  if (scale.value > 1) resetView();
  else {
    const { x, y } = stagePoint(e);
    zoomAt(2, x, y);
  }
}

const dragging = ref(false);
let dragStart: { x: number; y: number; tx: number; ty: number } | null = null;

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0 || scale.value <= 1 || (e.target as HTMLElement).tagName !== "IMG") return;
  dragStart = { x: e.clientX, y: e.clientY, tx: tx.value, ty: ty.value };
  dragging.value = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent) {
  if (!dragStart) return;
  tx.value = dragStart.tx + e.clientX - dragStart.x;
  ty.value = dragStart.ty + e.clientY - dragStart.y;
}

function onPointerUp() {
  dragStart = null;
  dragging.value = false;
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "ArrowLeft") go(-1);
  else if (e.key === "ArrowRight") go(1);
  else if (e.key === "+" || e.key === "=") zoomBy(1.25);
  else if (e.key === "-") zoomBy(1 / 1.25);
  else if (e.key === "0") resetView();
  else return;
  e.preventDefault();
}
</script>
