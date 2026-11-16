<template>
  <div
    ref="rootEl"
    class="image-content relative w-full h-full overflow-hidden"
    :class="{ 'is-compact': isCompact }"
    :style="rootStyle"
  >
    <!-- 彻底加载失败（壁纸变体同预览：桌面也换上丢失图） -->
    <div v-if="isLost" class="ic-lost absolute inset-0 flex items-center justify-center">
      <ImageNotFound show-image class="text-black" />
    </div>

    <template v-else>
      <!-- 骨架覆盖层：delayed 防止快速解码时闪烁（壁纸变体同预览：桌面的新层在骨架出来时就开始过渡） -->
      <!-- 不用 ui/Skeleton：它带圆角，网格格子是直角铺满的 -->
      <div
        v-if="showLoading"
        data-kb-motion
        class="ic-loading-overlay absolute inset-0 z-3 pointer-events-none grid place-items-center bg-kb-fill animate-[kb-pulse_1.6s_ease-in-out_infinite]"
        aria-hidden="true"
      >
        <Film v-if="isVideo" class="size-7 text-kb-fg-subtle opacity-60" />
        <ImageIcon v-else class="size-7 text-kb-fg-subtle opacity-60" />
      </div>

      <!-- 图片：双图层（缩略层打底；prefer=original 或缩略链死亡时叠加原图层） -->
      <template v-if="mode === 'image'">
        <img
          v-if="!thumbSlot.dead"
          :key="`thumb:${thumbSlot.src}`"
          :src="thumbSlot.src"
          :loading="imgLoading"
          decoding="async"
          class="ic-img thumbnail-layer z-1"
          :style="{ objectFit: fit }"
          :alt="image.id"
          :draggable="dragEnabled"
          @load="onLoad"
          @error="onImgError(thumbSlot, $event)"
          @dragstart="onDragStart(thumbSlot, $event)"
        />
        <img
          v-if="origEngaged && !origSlot.dead"
          :key="`orig:${origSlot.src}`"
          :src="origSlot.src"
          :loading="imgLoading"
          decoding="async"
          class="ic-img original-layer z-2"
          :style="{ objectFit: fit }"
          :alt="image.id"
          :draggable="dragEnabled"
          @load="onLoad"
          @error="onImgError(origSlot, $event)"
          @dragstart="onDragStart(origSlot, $event)"
        />
      </template>

      <!-- 安卓视频缩略：单张 GIF <img>（无鼠标悬浮，用动图预览而非静帧 <video>），与 <video> 互斥 -->
      <img
        v-else-if="mode === 'gif'"
        :key="`gif:${thumbSlot.src}`"
        :src="thumbSlot.src"
        :loading="imgLoading"
        decoding="async"
        class="ic-img"
        :style="{ objectFit: fit }"
        :alt="image.id"
        :draggable="dragEnabled"
        @load="onLoad"
        @error="onImgError(thumbSlot, $event)"
        @dragstart="onDragStart(thumbSlot, $event)"
      />

      <!-- 视频的封面形态（桌面网格）：缩略图是图（首帧静图，旧 Android 的 gif 动图、WPE 作者的 preview.*）就用 <img> 打底，
           播放时（悬浮 / 点角标）才在上面挂原视频（见下方 <video> 的 posterVideo），停了就卸载 -->
      <img
        v-else-if="mode === 'poster'"
        v-show="!thumbSlot.dead"
        :key="`poster:${thumbSlot.src}`"
        :src="thumbSlot.src"
        :loading="imgLoading"
        decoding="async"
        class="ic-img thumbnail-layer z-1"
        :style="{ objectFit: fit }"
        :alt="image.id"
        :draggable="dragEnabled"
        @load="onLoad"
        @error="onImgError(thumbSlot, $event)"
        @dragstart="onDragStart(thumbSlot, $event)"
      />

      <!-- 非视频 WPE 壁纸（web / scene）的原图形态，同图片「原图出来前缩略图能看」：缩略层打底（作者 preview.* 或自定义封面），
           实时画面（WpeWallpaperContent）叠在上面，出来且满 WALLPAPER_MIN_LOADING_MS 才揭开；实时画面显示不了就当原图加载
           失败，缩略层是最终画面。Android / Web 不跑实时画面（没有 `wpe` feature），只有缩略层 -->
      <template v-else-if="mode === 'wallpaper'">
        <img
          v-if="!thumbSlot.dead"
          :key="`thumb:${thumbSlot.src}`"
          :src="thumbSlot.src"
          decoding="async"
          class="ic-img thumbnail-layer z-1"
          :style="{ objectFit: fit }"
          :alt="image.id"
          :draggable="dragEnabled"
          @load="onLoad"
          @error="onImgError(thumbSlot, $event)"
          @dragstart="onDragStart(thumbSlot, $event)"
        />
        <WpeWallpaperContent
          v-if="WPE_LIVE"
          ref="wallpaperContentRef"
          :key="`wallpaper:${image.id}`"
          class="ic-wallpaper absolute inset-0 z-2 transition-opacity duration-300"
          :class="wallpaperShown ? 'opacity-100' : 'opacity-0'"
          :image-id="image.id"
          :target="wallpaperTarget ?? undefined"
          :style-mode="wallpaperStyleMode"
          :volume="videoMuted ? 0 : (playback?.volume ?? 1)"
          :paused="!videoPlaying"
          :interactive="interactive"
          :scene-settings="playback?.sceneSettings"
          @live="onWallpaperLive"
          @fail="onWallpaperFail"
          @error="onWallpaperError"
          @progress="reportLoad"
          @contextmenu="emit('wallpaperContextmenu', $event)"
        />
        <!-- 加载进度（步骤 3）：挂上就显示，实时画面出来或确定显示不了时走满、停一下再淡出 -->
        <Transition leave-active-class="transition-opacity duration-300" leave-to-class="opacity-0">
          <WpeLoadingOverlay
            v-if="wallpaperLoading"
            class="absolute inset-0 z-4"
            :scene="isWpeScene"
            :value="loadValue"
            :stage="loadStage"
            :count="loadCount"
            :failure="loadFailure"
          />
        </Transition>
        <!-- 显示不了：覆盖层收起后，红字原因留在缩略图底部（用户定），直到实时画面出来或换图 -->
        <Transition enter-active-class="transition-opacity duration-300" enter-from-class="opacity-0">
          <WpeLoadingOverlay
            v-if="wallpaperFailureCaption"
            class="absolute inset-0 z-4"
            placement="bottom"
            :scene="isWpeScene"
            :value="1"
            :stage="loadStage"
            :failure="loadFailure"
          />
        </Transition>
      </template>
    </template>

    <!-- 视频：视频形态独占；封面形态里只在播放或缩略图坏了时挂在缩略层上面，出第一帧前透明（不闪黑） -->
    <template v-if="!isLost && videoMounted">
      <video
        :key="`video:${videoSlot.src}`"
        :ref="setVideoEl"
        :src="videoSlot.src"
        class="ic-img ic-video"
        :class="mode === 'poster' && ['z-2', posterVideoShown ? 'opacity-100' : 'opacity-0']"
        :style="videoStyle"
        :draggable="dragEnabled"
        :muted="isWallpaperVariant || videoMuted"
        :loop="videoLoop"
        :controls="nativeVideoControls"
        poster=""
        preload="auto"
        playsinline
        webkit-playsinline="true"
        disablepictureinpicture="true"
        disableremoteplayback=""
        @loadeddata="onVideoLoad"
        @canplay="onVideoLoad"
        @error="onVideoError"
        @dragstart="onDragStart(videoSlot, $event)"
        @mousedown="onVideoMouseDown"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  reactive,
  ref,
  shallowRef,
  watch,
  watchEffect,
  type ComponentPublicInstance,
} from "vue";
import { storeToRefs } from "pinia";
import type { ImageInfo, ImagePrefer, ImageSourceTag } from "../../types/image";
import { Film, Image as ImageIcon } from "@lucide/vue";
import ImageNotFound from "../common/ImageNotFound.vue";
import WpeWallpaperContent from "../wallpaper/WpeWallpaperContent.vue";
import WpeLoadingOverlay from "../wallpaper/WpeLoadingOverlay.vue";
import { useWpeLoadProgress } from "../../composables/useWpeLoadProgress";
import type { ViewportPoint } from "../wallpaper/wpeContextMenu";
import type { Mode, WallpaperPlayback, WallpaperTarget, WpeVideoProps } from "../wallpaper/types";
import {
  displayImageMimeType,
  isVideoMediaType,
  isWpeMediaType,
  isWpeSceneType,
  isWpeVideoType,
  isWpeWallpaperContentType,
} from "../../utils/mediaMime";
import { beginInternalDrag, DRAG_IMAGE_ID_MIME } from "../../utils/dragExport";
// #region debug-drag
import { sendDebugEvent } from "../../debugIngest";
// #endregion debug-drag
import { useUiStore } from "../../stores/ui";
import { useLoadingDelay } from "../../composables/useLoadingDelay";
import { compatibleToUrl, fileNameFromUrlOrPath, fileToUrl, thumbnailToUrl } from "../../utils/fileUrl";
import { resetVideoElement } from "../../utils/videoElement";
import { IS_ANDROID, IS_WEB } from "../../env";
import { invoke } from "../../api/rpc";
import { clampWallpaperVolume } from "../wallpaper/wpeWebVolume";
import { wpeVideoPresentation, type MediaFit } from "../wallpaper/wpeVideoStyle";

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
 * 视频则只有一个独占播放位；桌面缩略位的缩略图是图（首帧静图 / WPE 预览）时走 poster 形态：缩略层打底，播放时才挂视频（只走 comp → local）。安卓视频的thumb则是一个gif，和图片分开。
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
 *       现在旧元素在换源与卸载时立即释放（见 setVideoEl），不再等 GC；
 *       翻页高峰是否仍会耗尽未重新实测。
 * 潜在修复方向（尚未实施）：
 *   1. 链最后一环失败时启动延迟重试（~500 ms），等旧槽释放后再尝试一次；
 *   2. 懒加载视频元素（poster 占位，hover/click 时再挂载 <video>），
 *      从根本上减少同时存活的媒体元素数量。
 */

// ---- Path → URL helpers (pure) ----
/** 网页 / 场景壁纸的实时画面只在桌面跑（`wpe` feature）：Android / Web 的 wallpaper 形态只有缩略层。 */
const WPE_LIVE = !IS_ANDROID && !IS_WEB;
/** wallpaper 形态的加载态至少这么久才揭开实时画面：实时画面出得很快时不闪一下缩略图。 */
const WALLPAPER_MIN_LOADING_MS = 300;
/** 进度条走满后停这么久再淡出（实时画面出来、或确定显示不了时）。 */
const WALLPAPER_PROGRESS_HOLD_MS = 200;

const normalizeDesktopPath = (path: string | undefined): string =>
  (path || "")
    .trimStart()
    .replace(/^\\\\\?\\/, "")
    .trim();

interface Props {
  image: ImageInfo;
  prefer: ImagePrefer;
  videoPlaying?: boolean;
  nativeVideoControls?: boolean;
  videoMuted?: boolean;
  videoLoop?: boolean;
  resetVideoOnPause?: boolean;
  /**
   * 媒体填充方式（object-fit），由上层解析后传入，本组件不读设置。
   * 网格缩略图跟随 `imageFit` 设置（fit→contain / fill→cover）；预览等全屏场景固定 `contain`；桌面（`Wallpaper.vue`）按壁纸样式给
   * （填充 cover、适应 contain、拉伸 fill、居中 none）。
   */
  fit?: MediaFit;
  /**
   * `wallpaper`：桌面壁纸窗口（`Wallpaper.vue`）用。加载与报错的显示同预览（骨架、先缩略图后原图、丢失图），不能拖出，图片立即加载；
   * `ready` 每张一次、意思是「有东西可看了」：画面出来（缩略图或原图、视频首帧、网页 / 场景的缩略图或实时画面）、骨架出来、或丢失，
   * 先到的那个，桌面据此开始过渡；视频静音起播、成功后按 `playback` 的音量出声，倍速取 `playback.playbackRate`。
   */
  variant?: "default" | "wallpaper";
  /** `x-wpe/video` 的作者播放属性（桌面给后端算好的目标里的）；不给时按图片 id 取壁纸目标里的（只在桌面端） */
  wpeVideo?: WpeVideoProps | null;
  /** wallpaper 形态：后端算好的壁纸目标（桌面给），原样交给 `WpeWallpaperContent`；不给时它按图片 id 取 */
  wallpaperTarget?: WallpaperTarget | null;
  /**
   * 是否允许浏览器原生拖拽媒体（拖出到外部 + 拖拽残影），图片与视频一致生效。
   * 默认放开（同浏览器默认行为）；只有当宿主自己要用指针做手势时才关掉，
   * 例如预览的 panzoom 在已缩放状态下要靠拖动平移画面（见 `usePanzoomPreview` 的 canPan）。
   */
  nativeDrag?: boolean;
  /** 只对 `wallpaper` 形态生效：壁纸页面是否接收指针事件（预览为 true）。 */
  interactive?: boolean;
  /**
   * 只对 `wallpaper` 形态生效：音量与场景设置（调用方算好，本组件不读设置；图库用 `useWpePreviewPlayback`）。不给时音量 1、
   * 场景设置跟随 WPE。暂停看 `videoPlaying`，`videoMuted` 时音量按 0。
   */
  playback?: WallpaperPlayback;
}

const props = withDefaults(defineProps<Props>(), {
  videoPlaying: false,
  nativeVideoControls: false,
  videoMuted: false,
  videoLoop: true,
  resetVideoOnPause: false,
  fit: "contain",
  nativeDrag: true,
  interactive: false,
  playback: undefined,
  variant: "default",
  wpeVideo: undefined,
  wallpaperTarget: null,
});

/** 拖拽落盘的建议文件名：跟随当前实际加载的 source，退回 displayName / id。 */
const dragFileName = (sourceUrl: string): string => {
  const base = fileNameFromUrlOrPath(sourceUrl);
  if (base.includes(".")) return base;
  return props.image.displayName || base || props.image.id;
};

/**
 * 原生拖拽起手。两条路径互斥，不共用载荷：
 *
 * - **桌面三平台（Windows / macOS / Linux）** 只写自定义 mime 里的 image id，浏览器进程
 *   据此查库换成库内原文件（CEF 补丁 03，见 `cocs/tauri/LINUX_REAL_FILE_DRAG_OUT.md`；
 *   Windows 落地为 `CF_HDROP`）。这里**不写** URL：注入文件成功时 Chromium 会把
 *   url_infos / text / file_contents / html / download_metadata 一并清掉，写了也留不下；
 *   Windows 上 `DownloadURL` 还会多出一份延迟渲染的 `CF_HDROP` 与真实文件抢格式。
 *   自定义 mime 走 `DropData::custom_data`，不被 Chromium 的拖拽数据过滤器改写；
 *   只提议 id 而不传路径，即使前端被注入也只能导出图库中已有的普通文件。
 *   `effectAllowed` 定成 `copy`：Blink 默认 `uninitialized` 会把 move 一并放开，资源管理器
 *   对同卷 `CF_HDROP`、Linux 文件管理器对同文件系统都默认移动，库内文件会被挪走。
 * - **Web 版** 保留 `DownloadURL` + `text/uri-list` + `text/plain`：真实浏览器里
 *   `DownloadURL` 是有效的拖出下载手段，URL 是 HTTP / CDN。地址按触发 dragstart 的元素
 *   所属渲染槽**当前所在的源**（local / comp / thumb）生成，原图缺失并已回退到兼容副本或
 *   缩略图时，拖出内容与用户此刻看到的内容一致。Android 没有原生拖出，dragstart 不会发生。
 *
 * nativeDrag 关闭时把 dragstart 掐掉：`draggable=false` 之外的第二道闸。
 */
const onDragStart = (slot: MediaSlot, event: DragEvent) => {
  // #region debug-drag
  void sendDebugEvent(
    "img_dragstart",
    { nativeDrag: props.nativeDrag, id: props.image.id },
    { sessionId: "drag-internal" },
  );
  // #endregion debug-drag
  if (!dragEnabled.value) {
    event.preventDefault();
    return;
  }
  beginInternalDrag();
  const dt = event.dataTransfer;
  if (!dt) return;
  if (IS_WEB) {
    // Web 版：真实浏览器里 DownloadURL 是有效的拖出下载手段，URL 是 HTTP / CDN。
    const target = event.target;
    const currentSrc =
      target instanceof HTMLImageElement || target instanceof HTMLVideoElement ? target.currentSrc : "";
    const url = currentSrc || slot.source?.url || "";
    if (!url) return;
    // filename 段不能含冒号（DownloadURL 以冒号分段）
    const name = dragFileName(url).replace(/:/g, "_");
    dt.setData("DownloadURL", `${displayImageMimeType(props.image.type)}:${name}:${url}`);
    dt.setData("text/uri-list", url);
    dt.setData("text/plain", url);
    return;
  }
  // 桌面三平台走真实文件拖出：只提议 image id，由 browser process 侧授权后注入本地路径
  // （见 cocs/tauri/LINUX_REAL_FILE_DRAG_OUT.md）。只允许复制，库内文件不能被目标端移走。
  dt.effectAllowed = "copy";
  if (props.image.id) dt.setData(DRAG_IMAGE_ID_MIME, props.image.id);
};

/**
 * 视频历史上用 `@mousedown.prevent` 一并掐掉拖拽/选中，但 Chromium 里 mousedown 被
 * preventDefault 会抑制原生拖拽起手，故改为仅在 nativeDrag 关闭时保留旧行为。
 */
const onVideoMouseDown = (event: MouseEvent) => {
  if (!dragEnabled.value) event.preventDefault();
};

const emit = defineEmits<{
  ready: [];
  error: [];
  videoPlayFail: [];
  /** wallpaper 形态：实时画面是否已揭开（满最短加载时间且在实时渲染）；退回缩略图、切图时为假 */
  wallpaperLive: [live: boolean];
  /** wallpaper 形态：实时画面显示不了的原因（桌面的调试面板用） */
  wallpaperFail: [reasons: string[]];
  /** wallpaper 形态：网页 / 场景壁纸里点了右键，坐标是本页面视口（见 `wpeContextMenu.ts`） */
  wallpaperContextmenu: [point: ViewportPoint];
  /** 壁纸变体：当前画面换了（缩略层、原图层、视频出来），`displaySource()` 可能变了（桌面平铺重取图源） */
  displayChange: [];
}>();

const { isCompact } = storeToRefs(useUiStore());
const { showLoading, startLoading, finishLoading } = useLoadingDelay(300);

// ---- Media type / 渲染形态（三者互斥） ----
const isVideo = computed(() => isVideoMediaType(props.image.type));
const isWpe = computed(() => isWpeMediaType(props.image.type));
const isWpeVideo = computed(() => isWpeVideoType(props.image.type));
/** 非视频 WPE（web / scene）：原图形态是缩略层打底 + 壁纸组件的实时画面，不走原图链。 */
const isWpeWallpaperContent = computed(() => isWpeWallpaperContentType(props.image.type));
/** 目录型壁纸没有可拖出的真实媒体文件（local_path 是目录），关闭原生拖拽。 */
const dragEnabled = computed(() => props.nativeDrag && !isWpe.value && props.variant !== "wallpaper");
const isWallpaperVariant = computed(() => props.variant === "wallpaper");
/**
 * 壁纸变体的图片立即加载：桌面的新层在 `ready` 之前不可见（opacity 0），懒加载在当前层是播放中的视频时会一直不开始
 * （实测 8 s 以上，换别的东西才被带起来），新层等不到 `ready`、看上去就是没换。网格等其它用法照旧懒加载。
 */
const imgLoading = computed(() => (isWallpaperVariant.value ? "eager" : "lazy"));
/** 壁纸变体的 ready 已发（每张一次，`emitReady`）；重置时清（声明在重置的 watch 之前） */
let readySent = false;
/**
 * 渲染形态：
 * - `image`：图片（缩略层 + 原图层）；非视频 WPE 的缩略位也是它。
 * - `poster`：桌面视频的缩略位，缩略图是图（首帧静图、WPE 视频的作者 preview.*）：`<img>` 打底，
 *   播放时（`videoPlaying`）才在上面挂原视频，停了就卸载，网格里不常驻 `<video>`。
 * - `gif`：Android 普通视频的缩略位，单张 GIF 动图（网格没有悬浮，不挂视频）。
 * - `video`：原图位（预览、背景、桌面），或缩略图本身就是视频（旧版本的 mp4 短片、没有独立缩略图）。
 * - `wallpaper`：非视频 WPE 的原图形态（实时画面）。
 */
const mode = computed<"image" | "poster" | "gif" | "video" | "wallpaper">(() => {
  // 非视频 WPE：缩略位仍是作者 preview.*；原图形态在它上面叠壁纸组件的实时画面。
  if (isWpeWallpaperContent.value) {
    return props.prefer === "thumbnail" ? "image" : "wallpaper";
  }
  if (!isVideo.value && !isWpeVideo.value) return "image";
  if (props.prefer !== "thumbnail") return "video";
  // 目录型视频壁纸没有预览图时 thumbnail_path 回落成目录本身，只能放入口视频
  if (isWpeVideo.value) return hasWpePreview.value ? "poster" : "video";
  if (IS_ANDROID) return "gif";
  return thumbPath.value && !thumbIsClip.value ? "poster" : "video";
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

/** WPE 预览是否真的独立于壁纸目录（缺 preview 时 thumbnail_path 会回落成目录本身）。 */
const hasWpePreview = computed(() => !!thumbPath.value && thumbPath.value !== localPath.value);

/**
 * 桌面普通视频的缩略图本身是不是视频：旧版本的缩略图是 2.5 秒的 mp4 短片（直接当视频放），没有独立缩略图时缩略位就是
 * 原视频；现在是首帧 JPEG，当图显示。回填作业跑完之前两种并存，按缩略图本身决定放什么。
 */
const thumbIsClip = computed(
  () => !!thumbPath.value && (thumbPath.value === localPath.value || /\.mp4$/i.test(thumbPath.value)),
);

interface Source {
  tag: ImageSourceTag;
  /** 显示用 URL：桌面 CEF 为 `file://`，Android / Web 为本地 HTTP 或 CDN。 */
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
    // 目录型壁纸的 local 是目录、不可播放；播放只走 compatible_path（入口视频本身或兼容副本）。
    if (!path || seen.has(path) || (isWpe.value && path === localPath.value)) continue;
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
    /** 当前所在的源；链走空时为 undefined。 */
    source: computed<Source | undefined>(() => chain()[index.value]),
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

// 图片缩略层（poster / gif 形态复用同一槽）；原图层 comp → local。
// 视频链：poster 形态叠的是原视频（comp → local）；视频形态按 prefer 定方向，缩略图是图时不进链（放不了）。
const thumbSlot = useSlot(() => buildChain(thumbPath.value));
const origSlot = useSlot(() => buildChain(compPath.value, localPath.value));
const videoSlot = useSlot(() => {
  if (mode.value === "poster") return buildChain(compPath.value, localPath.value);
  const clip = thumbIsClip.value ? thumbPath.value : "";
  return props.prefer === "original"
    ? buildChain(compPath.value, localPath.value, clip)
    : buildChain(clip, compPath.value, localPath.value);
});

/** 挂 `<video>`：视频形态一直挂；poster 形态只在播放时挂（缩略层坏了也挂，停在首帧当缩略图用）。 */
const videoMounted = computed(() => {
  if (mode.value === "video") return true;
  if (mode.value !== "poster") return false;
  return (props.videoPlaying || thumbSlot.dead) && !videoSlot.dead;
});
/** poster 形态的视频出了第一帧才盖上缩略层（之前透明，不闪黑）；卸载时复位。 */
const posterVideoReady = ref(false);
const posterVideoShown = computed(() => posterVideoReady.value || thumbSlot.dead);
watch(videoMounted, (mounted) => {
  if (!mounted) posterVideoReady.value = false;
});

type MediaSlot = typeof thumbSlot;

// stale 守卫：已被 key 换掉的旧元素卸载后仍可能派发迟到的 load/error 事件，
// 其 handler 闭包指向存活实例的槽，会烧掉不相干的链环——一律忽略。
const isStaleMediaEvent = (e: Event): boolean => !(e.target as Element | null)?.isConnected;

const onImgError = (slot: typeof thumbSlot, e: Event) => {
  if (isStaleMediaEvent(e)) return;
  console.error("[image-error]", e);
  slot.onError();
};

// 原图层介入时机：偏好原图，或缩略链死亡后作为回退（对应 img+thumb 行的单层链）
const origEngaged = computed(() => props.prefer === "original" || thumbSlot.dead);

const videoEl = ref<HTMLVideoElement | null>(null);
// 换源（:key 换掉元素）、切出视频形态、卸载时立即释放旧 <video>：只从 DOM 移除的元素要等 GC 才释放播放器，
// 期间占着媒体播放位，也作为暂停的播放器留在系统媒体会话里（预览切走后系统媒体浮窗仍停在旧视频）。
// 用函数 ref：Vue 卸载元素时同步传 null（旧元素随即移除）；watch 可能来不及观察到被换掉的元素
const setVideoEl = (el: Element | ComponentPublicInstance | null) => {
  const next = el instanceof HTMLVideoElement ? el : null;
  if (videoEl.value && videoEl.value !== next) resetVideoElement(videoEl.value);
  videoEl.value = next;
};
onBeforeUnmount(() => setVideoEl(null));

// ---- wallpaper 形态 ----
/** 壁纸目标取不到（行已删 / IPC 失败）：致命，显示丢失态。 */
const wallpaperFatal = ref(false);
/** 实时画面显示不了（编译相关的退回、超时、网页导航被拦）：当原图加载失败，缩略层是最终画面。之后还可能重新 live。 */
const wallpaperFailed = ref(false);
/** 实时画面在渲染（`WpeWallpaperContent` 的 live）。 */
const wallpaperLive = ref(false);
/** 最短加载时间已过；实时画面要等它才揭开。 */
const wallpaperMinElapsed = ref(false);
let wallpaperMinTimer: number | undefined;
/** 实时画面揭开：盖住缩略层。 */
const wallpaperShown = computed(() => WPE_LIVE && wallpaperLive.value && wallpaperMinElapsed.value);
/** wallpaper 形态的 ready 每张只发一次：缩略层加载完与实时画面揭开，先到的那个。 */
let wallpaperReadySent = false;
const isWpeScene = computed(() => isWpeSceneType(props.image.type));
/** 进度覆盖层收起了：实时画面出来或确定显示不了之后，条走满、停 WALLPAPER_PROGRESS_HOLD_MS 再淡出。 */
const loadSettled = ref(false);
/** 显示不了的原因（`fail(reasons)`）：覆盖层先变红，收起后留在缩略图底部。 */
const loadFailure = ref<string[] | null>(null);
let loadSettleTimer: number | undefined;

function resetWallpaper() {
  wallpaperFatal.value = false;
  wallpaperFailed.value = false;
  wallpaperLive.value = false;
  wallpaperReadySent = false;
  window.clearTimeout(wallpaperMinTimer);
  wallpaperMinElapsed.value = false;
  window.clearTimeout(loadSettleTimer);
  loadSettleTimer = undefined;
  loadSettled.value = false;
  loadFailure.value = null;
  startLoad();
  if (mode.value !== "wallpaper") return;
  wallpaperMinTimer = window.setTimeout(() => {
    wallpaperMinElapsed.value = true;
  }, WALLPAPER_MIN_LOADING_MS);
}
onBeforeUnmount(() => {
  window.clearTimeout(wallpaperMinTimer);
  window.clearTimeout(loadSettleTimer);
});

/** 进度条走满，停一下再收起覆盖层（已经收起或正在等的不再排） */
function settleLoad() {
  completeLoad();
  if (loadSettled.value || loadSettleTimer !== undefined) return;
  loadSettleTimer = window.setTimeout(() => {
    loadSettleTimer = undefined;
    loadSettled.value = true;
  }, WALLPAPER_PROGRESS_HOLD_MS);
}

// ---- 终态 ----
const isLost = computed(() => {
  switch (mode.value) {
    case "wallpaper":
      // 目录消失、目标取不到直接丢失；否则同图片：缩略层与「原图」（实时画面）都显示不了才丢失
      if (props.image.localExists === false || wallpaperFatal.value) return true;
      return thumbSlot.dead && (!WPE_LIVE || (wallpaperFailed.value && !wallpaperLive.value));
    case "video":
      return videoSlot.dead;
    case "gif":
      return thumbSlot.dead;
    case "poster":
      // 缩略层与原视频都放不了才丢失；原视频坏了而缩略层在，靠角标提示
      return thumbSlot.dead && videoSlot.dead;
    case "image":
      // 安卓：原图层死亡即视为丢失（缩略图可能仍在，但源文件已不可达）
      return IS_ANDROID ? origEngaged.value && origSlot.dead : thumbSlot.dead && origSlot.dead;
  }
});

/** wallpaper 形态的进度覆盖层显示中：跑实时画面、没丢失、还没收起（`settleLoad`） */
const wallpaperLoading = computed(() => WPE_LIVE && mode.value === "wallpaper" && !isLost.value && !loadSettled.value);
/** 失败原因留在缩略图底部：覆盖层收起之后、实时画面出来之前 */
const wallpaperFailureCaption = computed(
  () =>
    WPE_LIVE &&
    mode.value === "wallpaper" &&
    !isLost.value &&
    wallpaperFailed.value &&
    loadSettled.value &&
    loadFailure.value !== null,
);
const {
  value: loadValue,
  stage: loadStage,
  count: loadCount,
  start: startLoad,
  report: reportLoad,
  complete: completeLoad,
} = useWpeLoadProgress(wallpaperLoading);

// ---- Reset on image identity or resource path change (NOT on prefer — preserves hover no-flash) ----
// When ImageItem flips effectivePrefer thumbnail→original, the two URLs don't change, so this
// watch doesn't fire, showLoading stays false, and the already-cached thumbnail layer is instant.
// wallpaper 形态只跟图片 id 走：实时画面（`WpeWallpaperContent`，按 id 挂载）同一张只报一次 live，换封面会改 `thumbnailPath`，
// 这里若跟着重置，揭开的实时画面就被收回、再也等不到 live。换封面只换缩略层（下面的 watch）。
// 网格里 WPE 固定用缩略形态，prefer 不会在两种形态间切换。
// video 形态同理：缩略图不是视频时不在播放链里，预览里「设为封面」换了 `thumbnailPath` 也不重置正在播的视频
// （`<video>` 的 src 没变、不会重新加载，重置了加载遮罩就一直盖着）。
const resetKey = computed(() => {
  if (mode.value === "wallpaper") return `wallpaper|${props.image.id}`;
  const thumb = mode.value === "video" && !thumbIsClip.value ? "" : thumbPath.value;
  return [props.image.id, localPath.value, compPath.value, thumb].join("|");
});
watch(
  resetKey,
  () => {
    thumbSlot.reset();
    origSlot.reset();
    videoSlot.reset();
    failedSources.value = [];
    readySent = false;
    resetWallpaper();
    if (isLost.value)
      finishLoading(); // 一条可加载的链都没有
    else startLoading();
  },
  { immediate: true },
);

// wallpaper 形态换封面：缩略层从新封面重来（实时画面不受影响）
watch(thumbPath, () => {
  if (mode.value === "wallpaper") thumbSlot.reset();
});

watch(
  isLost,
  (lost) => {
    if (lost) {
      finishLoading();
      emit("error");
      // 壁纸变体：丢失图也是可看的画面（同预览），桌面照样过渡上来
      if (isWallpaperVariant.value) emitReady();
    }
  },
  { immediate: true },
);

// 壁纸变体：加载超过骨架的延迟还没有画面，骨架就是可看的画面（同预览），桌面照样过渡上来
watch(showLoading, (shown) => {
  if (shown && isWallpaperVariant.value) emitReady();
});

// ---- Handlers ----
const onLoad = (e: Event) => {
  if (isStaleMediaEvent(e)) return;
  finishLoading();
  // 当前画面换了（缩略层、原图层、视频出来）：桌面平铺据此重取图源（原图盖上缩略图之后平铺也换成原图）
  if (isWallpaperVariant.value) emit("displayChange");
  if (mode.value === "wallpaper") {
    if (wallpaperReadySent) return;
    wallpaperReadySent = true;
  }
  emitReady();
};

const onWallpaperLive = () => {
  wallpaperFailed.value = false;
  wallpaperLive.value = true;
  loadFailure.value = null;
  settleLoad();
};

/** 实时画面显示不了：当原图加载失败，缩略层留着（缩略也死了 isLost 接手），原因先红字显示、再留在底部 */
const onWallpaperFail = (reasons: string[]) => {
  wallpaperLive.value = false;
  wallpaperFailed.value = true;
  loadFailure.value = [...reasons];
  settleLoad();
  emit("wallpaperFail", reasons);
};

/** 目标取不到：进丢失态（isLost 的 watch 负责 emit error） */
const onWallpaperError = () => {
  wallpaperFatal.value = true;
};

// 实时画面揭开：结束加载态，缩略层还没发过 ready 就由它发；揭开 / 收回都告诉上层（预览据此判断能不能暂停、设封面）
watch(wallpaperShown, (shown) => {
  if (shown) {
    finishLoading();
    if (!wallpaperReadySent) {
      wallpaperReadySent = true;
      emitReady();
    }
  }
  emit("wallpaperLive", shown);
});

const onVideoLoad = (e: Event) => {
  if (isStaleMediaEvent(e)) return;
  if (mode.value === "poster") {
    // 盖到缩略层上；缩略层还在加载（或已坏）时由这里结束加载态
    posterVideoReady.value = true;
    finishLoading();
    return;
  }
  onLoad(e);
};

const onVideoError = (e: Event) => {
  if (isStaleMediaEvent(e)) return;
  console.error("[video-error]", e);
  videoSlot.onError();
};

// ---- Video playback control ----
// Android 也由本 watchEffect 驱动 play/pause：wry 的 RustWebView 已设
// mediaPlaybackRequiresUserGesture=false，无手势 play() 合法。Android WebView 对
// 「从未播放且无 poster」的 <video> 会渲染巨大播放键占位（灰底黑色圆形播放图标），
// 因此不播放 ≠ 显示首帧——App 背景壁纸与 PhotoSwipe 预览都必须真正 play()。
watchEffect(() => {
  const el = videoEl.value;
  if (!el || !videoMounted.value || props.nativeVideoControls) return;
  if (props.videoPlaying) {
    if (isWallpaperVariant.value) {
      // 壁纸窗口没有用户手势，Chromium 只允许静音自动播放：先静音 play，成功后再按音量出声（带声 play 会被拒、停在第 0 帧）
      el.muted = true;
      void el
        .play()
        .then(() => {
          if (videoEl.value === el) applyWallpaperAudio(el);
        })
        .catch(() => emit("videoPlayFail"));
      return;
    }
    void el.play().catch(() => {
      emit("videoPlayFail");
    });
  } else {
    el.pause();
    if (props.resetVideoOnPause) {
      try {
        el.currentTime = 0;
      } catch {
        /* some platforms throw on currentTime write */
      }
    }
  }
});

// ---- 壁纸变体的视频音量与倍速 ----
/** 壁纸变体视频的音量（0…1）：`videoMuted` 时 0 */
const wallpaperVolume = computed(() => (props.videoMuted ? 0 : clampWallpaperVolume(props.playback?.volume ?? 1)));
/** 壁纸变体视频的倍速（0.25…3） */
const wallpaperRate = computed(() => {
  const rate = props.playback?.playbackRate ?? 1;
  return Math.min(3, Math.max(0.25, Number.isFinite(rate) ? rate : 1));
});

function applyWallpaperAudio(el: HTMLVideoElement) {
  el.volume = wallpaperVolume.value;
  el.muted = wallpaperVolume.value === 0;
}

// 音量变了：正在播的直接改；还没播成功的等 play 成功后再按当前音量出声
watch(wallpaperVolume, () => {
  const el = videoEl.value;
  if (el && isWallpaperVariant.value && mode.value === "video" && !el.paused) applyWallpaperAudio(el);
});
watch(
  [wallpaperRate, videoEl],
  ([rate, el]) => {
    if (!el || !isWallpaperVariant.value) return;
    el.defaultPlaybackRate = rate;
    el.playbackRate = rate;
  },
  { immediate: true },
);

// ---- WPE 视频的作者属性（步骤 4，用户定：桌面、预览、应用背景都生效）----
const fetchedWpeVideo = shallowRef<WpeVideoProps | null>(null);
let wpeVideoSeq = 0;
watch(
  () =>
    props.wpeVideo === undefined && WPE_LIVE && isWpeVideo.value && mode.value === "video" ? props.image.id : null,
  async (imageId) => {
    const seq = ++wpeVideoSeq;
    fetchedWpeVideo.value = null;
    if (!imageId) return;
    try {
      const target = await invoke<WallpaperTarget | null>("get_wallpaper_target_for_image", { imageId });
      if (seq === wpeVideoSeq) fetchedWpeVideo.value = target?.wpeVideo ?? null;
    } catch {
      // 取不到就按普通视频放（不影响播放）
    }
  },
  { immediate: true },
);
const wpeVideoProps = computed(() =>
  isWpeVideo.value ? (props.wpeVideo !== undefined ? props.wpeVideo : fetchedWpeVideo.value) : null,
);
const presentation = computed(() => wpeVideoPresentation(wpeVideoProps.value, props.fit));
const videoStyle = computed(() => ({
  objectFit: presentation.value.objectFit,
  objectPosition: presentation.value.objectPosition,
  transform: presentation.value.transform || undefined,
  filter: presentation.value.filter || undefined,
}));
/** 留边颜色：作者给了 `background` 时铺在根上（视频没盖满的地方） */
const rootStyle = computed(() =>
  mode.value === "video" && presentation.value.background
    ? { backgroundColor: presentation.value.background }
    : undefined,
);

/** wallpaper 形态的场景铺放：桌面给壁纸样式（含 tile），图库按 `fit` 换算 */
const FIT_STYLE: Record<MediaFit, Mode> = { cover: "fill", contain: "fit", fill: "stretch", none: "center" };
const wallpaperStyleMode = computed<Mode>(() => props.playback?.style ?? FIT_STYLE[props.fit]);

// ---- ready（壁纸变体每张一次）与当前画面 ----
function emitReady() {
  if (isWallpaperVariant.value) {
    if (readySent) return;
    readySent = true;
  }
  emit("ready");
}

const rootEl = ref<HTMLElement | null>(null);
/**
 * 当前显示的画面（给桌面的平铺用，`Wallpaper.vue` 拿它画重复背景）：图片取已经出来的原图层，没有就取缩略层；视频取 `<video>`。
 * 都还没出来时 null。
 */
function displaySource(): { kind: "image" | "video"; url: string; width: number; height: number } | null {
  if (mode.value === "video") {
    const el = videoEl.value;
    return el && el.videoWidth > 0
      ? { kind: "video", url: el.currentSrc || el.src, width: el.videoWidth, height: el.videoHeight }
      : null;
  }
  const root = rootEl.value;
  if (!root) return null;
  for (const selector of ["img.original-layer", "img.thumbnail-layer"]) {
    const img = root.querySelector<HTMLImageElement>(selector);
    if (img && img.complete && img.naturalWidth > 0)
      return { kind: "image", url: img.currentSrc || img.src, width: img.naturalWidth, height: img.naturalHeight };
  }
  return null;
}

const wallpaperContentRef = ref<InstanceType<typeof WpeWallpaperContent> | null>(null);
/** 壁纸窗口的 ping 是否交给 iframe 里的垫片应答：转问 wallpaper 形态的 `WpeWallpaperContent`，别的形态没有 iframe */
function delegatesPing(): boolean {
  return wallpaperContentRef.value?.delegatesPing() ?? false;
}

defineExpose({ videoEl, failedSources, isLost, displaySource, delegatesPing });
</script>
