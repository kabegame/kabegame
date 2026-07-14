<template>
  <div class="image-content relative w-full h-full overflow-hidden" :class="{ 'is-compact': isCompact }">
    <!-- 彻底加载失败 -->
    <div v-if="isLost" class="ic-lost absolute inset-0 flex items-center justify-center">
      <ImageNotFound show-image class="text-black" />
    </div>

    <template v-else>
      <!-- 骨架覆盖层：delayed 防止快速解码时闪烁 -->
      <div v-if="showLoading" class="ic-loading-overlay absolute inset-0 z-3 pointer-events-none">
        <el-skeleton :rows="0" animated class="absolute inset-0">
          <template #template>
            <el-skeleton-item
              :variant="isVideo ? 'rect' : 'image'"
              :style="{ width: '100%', height: '100%' }"
            />
          </template>
        </el-skeleton>
      </div>

      <!-- 图片：双图层（缩略层打底；prefer=original 或缩略链死亡时叠加原图层） -->
      <template v-if="mode === 'image'">
        <img
          v-if="!thumbSlot.dead"
          :key="`thumb:${thumbSlot.src}`"
          :src="thumbSlot.src"
          loading="lazy"
          decoding="async"
          class="ic-img thumbnail-layer z-1"
          :alt="image.id"
          draggable="false"
          @load="onLoad"
          @error="onImgError(thumbSlot, $event)"
          @dragstart.prevent
        />
        <img
          v-if="origEngaged && !origSlot.dead"
          :key="`orig:${origSlot.src}`"
          :src="origSlot.src"
          loading="lazy"
          decoding="async"
          class="ic-img original-layer z-2"
          :alt="image.id"
          draggable="false"
          @load="onLoad"
          @error="onImgError(origSlot, $event)"
          @dragstart.prevent
        />
      </template>

      <!-- 安卓视频缩略：单张 GIF <img>（无鼠标悬浮，用动图预览而非静帧 <video>），与 <video> 互斥 -->
      <img
        v-else-if="mode === 'gif'"
        :key="`gif:${thumbSlot.src}`"
        :src="thumbSlot.src"
        loading="lazy"
        decoding="async"
        class="ic-img"
        :alt="image.id"
        draggable="false"
        @load="onLoad"
        @error="onImgError(thumbSlot, $event)"
        @dragstart.prevent
      />

      <!-- 视频 -->
      <video
        v-else
        :key="`video:${videoSlot.src}`"
        ref="videoEl"
        :src="videoSlot.src"
        class="ic-img ic-video"
        draggable="false"
        :muted="videoMuted"
        :loop="videoLoop"
        :controls="nativeVideoControls"
        poster=""
        preload="auto"
        playsinline
        webkit-playsinline="true"
        disablepictureinpicture="true"
        disableremoteplayback=""
        @loadeddata="onLoad"
        @canplay="onLoad"
        @error="onVideoError"
        @dragstart.prevent
        @mousedown.prevent
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch, watchEffect } from "vue";
import { storeToRefs } from "pinia";
import type { ImageInfo, ImagePrefer, ImageSourceTag } from "../../types/image";
import ImageNotFound from "../common/ImageNotFound.vue";
import { isVideoMediaType } from "../../utils/mediaMime";
import { useUiStore } from "../../stores/ui";
import { useLoadingDelay } from "../../composables/useLoadingDelay";
import { fileToUrl, thumbnailToUrl, compatibleToUrl } from "../../httpServer";
import { IS_ANDROID } from "../../env";

/**
 * 资源开始加载
 * prefer |  thumbnail     |      origin     |
 * type   | image          |      video      |
 * img/video+thumb | init(0) ─→ thumb-fail(1) ─┬──(有comp)-→ comp-fail(2) ┐
 *                   (单层)                    |                          ↓
 *                                             └───→ (无comp)─────────→ local-fail(3) ───→ failed
 * img+orig  | init(0) ─→ thumb-fail(1) ──→ thumbnail hidden ───────────────────────────┐
 *             (thumb层)                                                                |
 *             init(0) ────────┬──(有comp)-→ comp-fail(2) ┐                             |
 *             (orig层)        |                          ↓                             ↓
 *                             └───→ (无comp)────────→ local-fail(3) ─ local hidden─→ failed
 * video+orig | init(0) ──┬──(有comp)-→ comp-fail(2) ┐
 *              (单层)    |                          ↓
 *                        └───→ (无comp)─────────→ local-fail(3) ───→ thumb-fail(1) -> failed
 * 上层能知道当前哪一步fail,比如thumb-fail则可能显示一个蓝色感叹号，comp-fail需要一个黄色感叹号，local-fail需要一个红色感叹号。
 * 不一定一次性探测出所有fail,但如果到了最终的fail状态，最多的情况下三个感叹号全亮
 * 图片种类  |小图片                                |  中图片                                  |   大图片
 * ----------|--------------------------------------|------------------------------------------|--------------
 * 路径状况  | 路径三条路径都相同，或者只有本地路径 | 兼容路径和本地路径相同，或者兼容路径为空 | 三个路径都不同
 * fail状态  | 直接跳到local-fail，没有其他fail状态 | 有thumb-fail,可能有local-fail            | 三个fail都可能出现
 * 视频则只有一个独占播放位，安卓视频的thumb则是一个gif，和图片分开。
 *
 * 实现：上面的每一行都是一条「有序回退链」。每个渲染槽（slot）持有一条链，
 * error 事件把当前环的失败等级记入 failedSources 并前进到下一环，链走空即 dead——
 * 除 reset 外没有其他状态迁移；来自已卸载元素的迟到 load/error 事件（stale）一律忽略。
 * 路径相同的环在建链时归并到更权威的等级（local > comp > thumb），
 * 小图/中图因此天然跳过不存在的 fail 等级。
 *
 * [已知问题] 翻页高峰：播放位耗尽（media slot exhaustion）
 * 现象：翻页后新页最后一张视频出现 failed 状态，但文件真实存在且 HTTP 服务返回 200；
 *       切换到其他视频再切回恢复正常。video.error.code = 4（MEDIA_ERR_SRC_NOT_SUPPORTED），
 *       networkState = 3（NETWORK_NO_SOURCE），readyState = 0，message 为空字符串。
 * 原因：翻页瞬间旧页与新页的 <video preload="auto"> 同时存在于 DOM，
 *       数量超出 CEF/Chromium renderer 进程的媒体播放位上限，新元素被拒绝解码。
 * 行为：临时性，旧元素被 GC 释放播放位后自行恢复；isConnected 守卫阻止了迟到的
 *       stale error 事件永久烧毁链环，但若 exhaustion error 在元素仍 connected 时
 *       到达（链的最后一环），仍会短暂显示 failed 状态直到下次导航。
 *       调试会话 video-pageflip-001 实测 52 次 exhaustion 事件。
 * 潜在修复方向（尚未实施）：
 *   1. 链最后一环失败时启动延迟重试（~500 ms），等旧槽释放后再尝试一次；
 *   2. 懒加载视频元素（poster 占位，hover/click 时再挂载 <video>），
 *      从根本上减少同时存活的媒体元素数量。
 */

// ---- Path → URL helpers (pure) ----
const normalizeDesktopPath = (path: string | undefined): string =>
  (path || "").trimStart().replace(/^\\\\\?\\/, "").trim();

interface Props {
  image: ImageInfo;
  prefer: ImagePrefer;
  videoPlaying?: boolean;
  nativeVideoControls?: boolean;
  videoMuted?: boolean;
  videoLoop?: boolean;
  resetVideoOnPause?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  videoPlaying: false,
  nativeVideoControls: false,
  videoMuted: false,
  videoLoop: true,
  resetVideoOnPause: false,
});

const emit = defineEmits<{
  ready: [];
  error: [];
  videoPlayFail: [];
}>();

const { isCompact } = storeToRefs(useUiStore());
const { showLoading, startLoading, finishLoading } = useLoadingDelay(300);

// ---- Media type / 渲染形态（三者互斥） ----
const isVideo = computed(() => isVideoMediaType(props.image.type));
const mode = computed<"image" | "gif" | "video">(() => {
  if (!isVideo.value) return "image";
  return IS_ANDROID && props.prefer === "thumbnail" ? "gif" : "video";
});

// ---- 资源三元组（按 path 归一） ----
// 兼容路径与本地路径相同视为无兼容副本，对应状态图中小图/中图的路径退化。
const localPath = computed(() => normalizeDesktopPath(props.image.localPath));
const compPath = computed(() => {
  const path = normalizeDesktopPath(props.image.compatiblePath);
  return path === localPath.value ? "" : path;
});
const thumbPath = computed(() => {
  const path = normalizeDesktopPath(props.image.thumbnailPath);
  if (path) return path;
  // 安卓无独立缩略图时以原始文件充当缩略位（视频 GIF 位 / 图片缩略层）
  if (IS_ANDROID && (isVideo.value || props.prefer !== "original")) return localPath.value;
  return "";
});

interface Source {
  tag: ImageSourceTag;
  url: string;
}

// path 归并到最权威的等级：local > comp > thumb
const sourceOf = (path: string): Source => {
  if (path === localPath.value) return { tag: "local", url: fileToUrl(path) };
  if (path === compPath.value) return { tag: "comp", url: compatibleToUrl(path) };
  return { tag: "thumb", url: thumbnailToUrl(path) };
};

const buildChain = (...paths: string[]): Source[] => {
  const seen = new Set<string>();
  const chain: Source[] = [];
  for (const path of paths) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    chain.push(sourceOf(path));
  }
  return chain;
};

// ---- 加载状态机 ----
// 三级失败标记：状态机的对外输出，供上层点亮蓝(thumb)/黄(comp)/红(local)感叹号。
const failedSources = ref<ImageSourceTag[]>([]);
const markFailed = (tag: ImageSourceTag) => {
  if (!failedSources.value.includes(tag)) failedSources.value = [...failedSources.value, tag];
};

// 渲染槽：一条有序回退链上的游标。error 记失败等级并前进，链走空即 dead。
function useSlot(chain: () => Source[]) {
  const index = ref(0);
  const exhausted = ref(false);
  return reactive({
    src: computed(() => chain()[index.value]?.url ?? ""),
    dead: computed(() => exhausted.value || chain().length === 0),
    onError() {
      const current = chain()[index.value];
      if (current) markFailed(current.tag);
      if (index.value + 1 < chain().length) index.value += 1;
      else exhausted.value = true;
    },
    reset() {
      index.value = 0;
      exhausted.value = false;
    },
  });
}

// 图片缩略层（gif 形态复用同一槽）；原图层 comp → local；视频链方向由 prefer 决定。
const thumbSlot = useSlot(() => buildChain(thumbPath.value));
const origSlot = useSlot(() => buildChain(compPath.value, localPath.value));
const videoSlot = useSlot(() =>
  props.prefer === "original"
    ? buildChain(compPath.value, localPath.value, thumbPath.value)
    : buildChain(thumbPath.value, compPath.value, localPath.value)
);

// stale 守卫：已被 key 换掉的旧元素卸载后仍可能派发迟到的 load/error 事件，
// 其 handler 闭包指向存活实例的槽，会烧掉不相干的链环——一律忽略。
const isStaleMediaEvent = (e: Event): boolean => !(e.target as Element | null)?.isConnected;

const onImgError = (slot: typeof thumbSlot, e: Event) => {
  if (isStaleMediaEvent(e)) return;
  console.error('[image-error]', e);
  slot.onError();
};

// 原图层介入时机：偏好原图，或缩略链死亡后作为回退（对应 img+thumb 行的单层链）
const origEngaged = computed(() => props.prefer === "original" || thumbSlot.dead);

const videoEl = ref<HTMLVideoElement | null>(null);

// ---- 终态 ----
const isLost = computed(() => {
  switch (mode.value) {
    case "video":
      return videoSlot.dead;
    case "gif":
      return thumbSlot.dead;
    case "image":
      // 安卓：原图层死亡即视为丢失（缩略图可能仍在，但源文件已不可达）
      return IS_ANDROID
        ? origEngaged.value && origSlot.dead
        : thumbSlot.dead && origSlot.dead;
  }
});

// ---- Reset on image identity change (NOT on prefer — preserves hover no-flash) ----
// When ImageItem flips effectivePrefer thumbnail→original, the two URLs don't change, so this
// watch doesn't fire, showLoading stays false, and the already-cached thumbnail layer is instant.
watch(
  () => props.image.id,
  () => {
    thumbSlot.reset();
    origSlot.reset();
    videoSlot.reset();
    failedSources.value = [];
    if (isLost.value) finishLoading(); // 一条可加载的链都没有
    else startLoading();
  },
  { immediate: true }
);

watch(
  isLost,
  (lost) => {
    if (lost) {
      finishLoading();
      emit("error");
    }
  },
  { immediate: true }
);

// ---- Handlers ----
const onLoad = (e: Event) => {
  if (isStaleMediaEvent(e)) return;
  finishLoading();
  emit("ready");
};

const onVideoError = (e: Event) => {
  if (isStaleMediaEvent(e)) return;
  console.error('[video-error]', e);
  videoSlot.onError();
};

// ---- Video playback control ----
// Android 也由本 watchEffect 驱动 play/pause：wry 的 RustWebView 已设
// mediaPlaybackRequiresUserGesture=false，无手势 play() 合法。Android WebView 对
// 「从未播放且无 poster」的 <video> 会渲染巨大播放键占位（灰底黑色圆形播放图标），
// 因此不播放 ≠ 显示首帧——App 背景壁纸与 PhotoSwipe 预览都必须真正 play()。
watchEffect(() => {
  const el = videoEl.value;
  if (!el || mode.value !== "video" || props.nativeVideoControls) return;
  if (props.videoPlaying) {
    void el.play().catch(() => {
      emit("videoPlayFail");
    });
  } else {
    el.pause();
    if (props.resetVideoOnPause) {
      try { el.currentTime = 0; } catch { /* some platforms throw on currentTime write */ }
    }
  }
});

defineExpose({ videoEl, failedSources, isLost });
</script>
