<template>
  <div
    ref="rootRef"
    class="pointer-events-none grid justify-items-center"
    :class="placement === 'bottom' ? 'items-end pb-[4%]' : 'place-items-center'"
    :style="rootStyle"
    data-testid="wpe-loading-overlay"
  >
    <!-- center：整块盖在缩略图上，背后（缩略图）模糊，正中一小块阶段文字 + 细进度条；bottom：失败后留在缩略图底部的红字原因，不模糊。
         不拦指针。注释放在根元素里：放在外面组件就成了多根片段，调用方给的定位类落不到根上 -->
    <div
      class="flex flex-col items-center gap-2 rounded-kb-md bg-kb-glass-strong px-4 py-3 shadow-kb-sm"
      :class="placement === 'bottom' ? 'w-[min(480px,90%)]' : 'w-[min(240px,60%)]'"
      :style="pillStyle"
    >
      <span
        class="max-w-full truncate text-[13px] leading-[1.3]"
        :class="failure ? 'text-kb-danger' : 'text-kb-fg'"
        data-testid="wpe-loading-label"
      >
        {{ label }}
      </span>
      <Progress
        v-if="placement === 'center'"
        :value="failure ? 100 : scene ? value * 100 : null"
        :tone="failure ? 'danger' : 'accent'"
        :height="3"
      />
      <span
        v-if="detail"
        class="line-clamp-2 max-w-full break-all text-center text-[11px] leading-[1.35] text-kb-danger"
        data-testid="wpe-loading-detail"
      >
        {{ detail }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * WPE 网页 / 场景壁纸的加载覆盖层（`ImageContent` 的 wallpaper 形态，壁纸显示重构步骤 3）：
 * - `center`（加载中）：实时画面揭开之前盖在缩略图上，背后模糊（用户定：只看到清晰的缩略图、没有文字，就是没加载出来），正中是阶段文字
 *   与进度条。场景有阶段与进度（`wpeSceneProgress.ts`），网页壁纸只有不定进度条与「加载中」。
 * - 失败（`failure` 给了原因）：文字与进度条变红，标题是「无法实时渲染」（超时是「加载超时」），下面一行是原因（宿主报的键，超时不列）；
 *   调用方停一下就换成 `bottom`：不模糊，红字留在缩略图底部，直到实时画面出来或换图。
 * 纯视图，进度由调用方算（`useWpeLoadProgress`）。
 *
 * 屏幕上的大小固定：预览画布按壁纸的分辨率排版再整体缩放（3840×2160 的场景缩到预览区约 0.25 倍），预览放大时还要再乘 Panzoom，
 * 跟着缩放的话文字只剩一两个像素、模糊也只剩几像素。所以量出本层实际被缩放了多少（`displayScaleOf`，含全部祖先 transform）：
 * 那一块反向缩放（center 以中心、bottom 以底边中点为原点），宽度取上限（center 240 px、bottom 480 px）与显示宽度一定比例的较小值；
 * 模糊半径除以缩放。都按屏幕像素。祖先 transform 变了哪个 observer 都不触发（同 `WpeSceneView`），按 {@link MEASURE_INTERVAL_MS} 轮询。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "@kabegame/i18n";
import { Progress } from "@/components/ui";
import { displayScaleOf } from "./wpeSceneStyle";
import type { WpeSceneProgressStage } from "./wpeSceneProgress";

const props = withDefaults(
  defineProps<{
    /** 场景：按 `value` 画进度、按 `stage` 显示阶段；否则（网页）不定进度 */
    scene: boolean;
    /** 0…1 */
    value: number;
    stage: WpeSceneProgressStage;
    /** 失败的原因（`WpeWallpaperContent` 的 `fail`）；给了就显示失败 */
    failure?: readonly string[] | null;
    placement?: "center" | "bottom";
  }>(),
  { failure: null, placement: "center" },
);

/** 那一块的宽度上限（屏幕像素）与占显示宽度的比例上限。 */
const SIZE = { center: { max: 240, ratio: 0.6 }, bottom: { max: 480, ratio: 0.9 } } as const;
/** 缩略图的模糊半径（屏幕像素）。 */
const BLUR_PX = 16;
/** 量显示缩放的间隔。 */
const MEASURE_INTERVAL_MS = 200;
/** 超时（`WpeWallpaperContent`）的原因键：标题换成「加载超时」，不再列原因。 */
const TIMEOUT_REASON = "render:timeout";

const STAGE_LABEL_KEYS: Record<WpeSceneProgressStage, string> = {
  page: "gallery.wpeLoadStagePage",
  compile: "gallery.wpeLoadStageCompile",
  decode: "gallery.wpeLoadStageDecode",
  gpu: "gallery.wpeLoadStageGpu",
  frame: "gallery.wpeLoadStageFrame",
};

const { t } = useI18n();
const timedOut = computed(() => props.failure?.includes(TIMEOUT_REASON) ?? false);
const label = computed(() => {
  if (props.failure) return t(timedOut.value ? "gallery.wpeLoadTimeout" : "gallery.wpeLoadFailed");
  return t(props.scene ? STAGE_LABEL_KEYS[props.stage] : "gallery.wpeLoadStageWeb");
});
const detail = computed(() =>
  props.failure && !timedOut.value && props.failure.length ? props.failure.join("; ") : "",
);

const rootRef = ref<HTMLElement | null>(null);
/** 量到的显示缩放与显示宽度（屏幕像素）；量不出来（还没布局）时为 null，按没缩放 */
const measured = ref<{ scale: number; width: number } | null>(null);

function measure() {
  const element = rootRef.value;
  const scale = element ? displayScaleOf(element) : null;
  if (!element || scale === null) return;
  const width = element.getBoundingClientRect().width;
  const current = measured.value;
  if (current && Math.abs(current.scale - scale) < 1e-4 && Math.abs(current.width - width) < 0.5) return;
  measured.value = { scale, width };
}

const rootStyle = computed(() => {
  if (props.placement !== "center") return undefined;
  const blur = `blur(${BLUR_PX / (measured.value?.scale ?? 1)}px)`;
  return { backdropFilter: blur, WebkitBackdropFilter: blur };
});

const pillStyle = computed(() => {
  const value = measured.value;
  if (!value) return undefined;
  const size = SIZE[props.placement];
  return {
    width: `${Math.min(size.max, value.width * size.ratio)}px`,
    transform: `scale(${1 / value.scale})`,
    transformOrigin: props.placement === "bottom" ? "bottom center" : "center",
  };
});

let timer: number | undefined;
onMounted(() => {
  measure();
  timer = window.setInterval(measure, MEASURE_INTERVAL_MS);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>
