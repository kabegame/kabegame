<template>
  <div ref="rootRef" class="pointer-events-none" :style="rootStyle" data-testid="wpe-loading-overlay">
    <!-- center：整块盖在缩略图上，背后（缩略图）模糊，正中一小块阶段文字 + 细进度条；bottom：失败后留在缩略图底部的红字原因，不模糊。
         不拦指针。注释放在根元素里：放在外面组件就成了多根片段，调用方给的定位类落不到根上。
         那一块按根绝对定位、用 translate 对中（不用 grid 居中：它的排版宽度可能比根还宽，grid 的列会被撑开、从左边排起，中心就偏了） -->
    <div
      class="absolute left-1/2 flex flex-col items-center gap-2 rounded-kb-md bg-kb-glass-strong px-4 py-3 shadow-kb-sm"
      :class="placement === 'bottom' ? 'bottom-[4%] w-[min(480px,90%)]' : 'top-1/2 w-[min(320px,70%)]'"
      :style="pillStyle"
    >
      <span
        class="line-clamp-2 max-w-full text-center text-[13px] leading-[1.3]"
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
      <!-- 场景加载中：当前阶段的计数与总百分比（两位小数，等宽数字不跳） -->
      <span
        v-if="meta"
        class="max-w-full truncate text-[11px] leading-none tabular-nums text-kb-fg-subtle"
        data-testid="wpe-loading-meta"
      >
        {{ meta }}
      </span>
      <span
        v-if="detail"
        class="line-clamp-2 max-w-full break-all text-center text-[11px] leading-[1.35] text-kb-danger"
        data-testid="wpe-loading-detail"
      >
        {{ detail }}
      </span>
      <!-- 失败原因下面的强制渲染提示（用户定）：预览是「我就要看」链接文字（不做成按钮；根不收指针，这里单独收，预览画布上盖着
           拦指针的覆盖层，它按 data-wallpaper-clickable 把点击转交过来）；桌面点不到，只给文字指路到壁纸设置 -->
      <button
        v-if="forceRenderPrompt === 'action' && placement === 'bottom'"
        type="button"
        class="pointer-events-auto cursor-pointer border-0 bg-transparent p-0 text-[12px] leading-[1.4] text-kb-accent underline underline-offset-2 hover:opacity-80"
        data-wallpaper-clickable
        data-testid="wpe-loading-force-render"
        @click="emit('forceRender')"
      >
        {{ t("gallery.wpeForceRenderAction") }}
      </button>
      <span
        v-else-if="forceRenderPrompt === 'settings' && placement === 'bottom'"
        class="max-w-full text-center text-[12px] leading-[1.4] text-kb-fg-muted"
        data-testid="wpe-loading-force-render-hint"
      >
        {{ t("gallery.wpeForceRenderSettingsHint") }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * WPE 网页 / 场景壁纸的加载覆盖层（`ImageContent` 的 wallpaper 形态，壁纸显示重构步骤 3）：
 * - `center`（加载中）：实时画面揭开之前盖在缩略图上，背后模糊（用户定：只看到清晰的缩略图、没有文字，就是没加载出来），正中是阶段文字
 *   与进度条。场景有阶段（技术名词，用户定）、进度与一行「当前阶段的 done / total · 总百分比（两位小数）」（计数只在编译、解码、建
 *   管线这几个有计数的阶段显示，`wpeSceneProgress.ts`）；网页壁纸只有不定进度条与「加载中」。
 * - `bottom` 可在原因下面带强制渲染的提示（`forceRenderPrompt`）：`action` 是「我就要看」链接文字（预览，点了 emit `forceRender`，
 *   调用方确认后打开强制渲染）；`settings` 是一行文字「可以打开壁纸设置 -> 强制渲染」（桌面，点不到）。
 * - 失败（`failure` 给了原因）：文字与进度条变红，标题是「喵呜，这张壁纸渲染失败了呢」（超时是「加载超时」），下面一行是原因（宿主报的键，超时不列）；
 *   调用方停一下就换成 `bottom`：不模糊，红字留在缩略图底部，直到实时画面出来或换图。
 * 纯视图，进度由调用方算（`useWpeLoadProgress`）。
 *
 * 屏幕上的大小固定：预览画布按壁纸的分辨率排版再整体缩放（3840×2160 的场景缩到预览区约 0.25 倍），预览放大时还要再乘 Panzoom，
 * 跟着缩放的话文字只剩一两个像素、模糊也只剩几像素。所以量出本层实际被缩放了多少（`displayScaleOf`，含全部祖先 transform）：
 * 那一块反向缩放（center 以中心、bottom 以底边中点为原点），宽度取上限（center 320 px、bottom 480 px）与显示宽度一定比例的较小值；
 * 模糊半径除以缩放。都按屏幕像素。祖先 transform 变了哪个 observer 都不触发（同 `WpeSceneView`），按 {@link MEASURE_INTERVAL_MS} 轮询。
 * 小场景放大显示时（如 343 px 宽的场景），那一块的排版宽度比根还宽，所以按根绝对定位对中（`pillStyle`），根要由调用方定位
 * （`ImageContent` 给 `absolute inset-0`）。
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
    /** 当前阶段最近一次的真实计数（`useWpeLoadProgress` 的 `count`） */
    count?: { done: number; total: number } | null;
    /** `bottom` 原因下面的强制渲染提示：`action` 是「我就要看」链接，`settings` 是指向壁纸设置的文字；不给就没有 */
    forceRenderPrompt?: "action" | "settings" | null;
  }>(),
  { failure: null, placement: "center", count: null, forceRenderPrompt: null },
);
const emit = defineEmits<{ forceRender: [] }>();

/** 那一块的宽度上限（屏幕像素）与占显示宽度的比例上限。 */
const SIZE = { center: { max: 320, ratio: 0.7 }, bottom: { max: 480, ratio: 0.9 } } as const;
/** 有计数的阶段（其余阶段报的是 `0 / 1`，计数没有意义） */
const COUNTED_STAGES: readonly WpeSceneProgressStage[] = ["compile", "decode", "gpu"];
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
  prepare: "gallery.wpeLoadStagePrepare",
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

/** 「37 / 142 · 42.18%」：只在场景加载中；有计数的阶段才带计数 */
const meta = computed(() => {
  if (!props.scene || props.failure || props.placement !== "center") return "";
  const percent = `${(Math.min(1, Math.max(0, props.value)) * 100).toFixed(2)}%`;
  const count = props.count;
  return count && count.total > 0 && COUNTED_STAGES.includes(props.stage)
    ? `${count.done} / ${count.total} · ${percent}`
    : percent;
});

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

/**
 * 那一块的位置与大小：左边（与 center 的上边）在根的 50% 处，translate 拉回自身的一半，中心就落在根的中线上；再以中心（bottom 以底边
 * 中点）为原点反向缩放，中心不动。translate 写在 scale 前面：两者都绕同一个原点，中心点经缩放不动、再平移半个自身宽度。
 */
const pillStyle = computed(() => {
  const bottom = props.placement === "bottom";
  const shift = bottom ? "translateX(-50%)" : "translate(-50%, -50%)";
  const value = measured.value;
  if (!value) return { transform: shift };
  const size = SIZE[props.placement];
  return {
    width: `${Math.min(size.max, value.width * size.ratio)}px`,
    transform: `${shift} scale(${1 / value.scale})`,
    transformOrigin: bottom ? "bottom center" : "center",
  };
});

let timer: number | undefined;
onMounted(() => {
  measure();
  timer = window.setInterval(measure, MEASURE_INTERVAL_MS);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>
