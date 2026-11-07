<script setup lang="ts">
/**
 * 图库侧的 WPE 壁纸内容（`ImageContent` 的 `wallpaper` 形态）：按图片 id 取壁纸目标，交给纯渲染组件
 * `WallpaperStage`。只服务非视频的 WPE 类型（web 与 scene）；`x-wpe/video` 在图库里按普通视频处理。
 *
 * - 目标经 `get_wallpaper_target_for_image` 获取，与桌面壁纸窗口共用后端 `build_wallpaper_target`。
 * - 过渡 / 音量 / 倍速跟随壁纸设置（主窗口已加载 settings，这里不 loadAll）。铺放不看壁纸样式：这里是图库内容，
 *   和其它媒体一样由调用方给 `fit`（预览 contain、应用背景 cover）。
 *   音量对网页壁纸同样生效（Stage 经 postMessage 交给页面里的垫片）；`muted`（应用背景）时为 0。
 * - `ready`：网页 iframe load；场景出首帧，或不能渲染（含超时）时预览图加载完。场景结果出来前不发，加载态一直保持。
 * - `sceneLive`：场景是否在实时渲染，退回预览图时为假。
 * - `error` 第二个参数区分致命与否：目标取不到（行已删、IPC 失败）为致命，调用方显示丢失态；
 *   页面加载超时、场景既不能渲染又没有预览图等运行期错误不致命，只用来结束加载态。
 */
import { computed, ref, watch } from "vue";
import { invoke } from "@/api/rpc";
import { useSettingsStore } from "@/stores/settings";
import type { ImageInfo } from "@/types/image";
import WallpaperStage from "./WallpaperStage.vue";
import type { Mode, Transition, WallpaperTarget } from "./types";

const props = withDefaults(
  defineProps<{
    image: ImageInfo;
    fit?: "contain" | "cover";
    /** false 时暂停：网页由垫片冻结、场景停帧，画面都停在最后一帧 */
    playing?: boolean;
    /** true 时音量为 0（应用背景）：网页壁纸页面自己的声音也静音 */
    muted?: boolean;
    /** 预览内嵌为 true：页面接收指针事件 */
    interactive?: boolean;
  }>(),
  {
    fit: "contain",
    playing: true,
    muted: false,
    interactive: false,
  },
);

const emit = defineEmits<{
  ready: [];
  error: [message: string, fatal: boolean];
  sceneLive: [live: boolean];
}>();

const settings = useSettingsStore();

const styleMode = computed<Mode>(() => (props.fit === "cover" ? "fill" : "fit"));
const transition = computed(() => (settings.values.wallpaperRotationTransition ?? "none") as Transition);
const volume = computed(() => (props.muted ? 0 : (settings.values.wallpaperVolume ?? 1)));
const playbackRate = computed(() => settings.values.wallpaperVideoPlaybackRate ?? 1);

const target = ref<WallpaperTarget | null>(null);
let seq = 0;

watch(
  () => props.image.id,
  async (imageId) => {
    const current = ++seq;
    target.value = null;
    try {
      const next = await invoke<WallpaperTarget | null>("get_wallpaper_target_for_image", { imageId });
      if (current !== seq) return;
      if (!next?.path) {
        emit("error", "wallpaper target not found", true);
        return;
      }
      target.value = next;
    } catch (error) {
      if (current !== seq) return;
      console.error("[WpeWallpaperContent] 获取壁纸目标失败:", error);
      emit("error", String(error), true);
    }
  },
  { immediate: true },
);

function onStageError(message: string) {
  console.warn("[WpeWallpaperContent] 壁纸渲染错误:", message);
  emit("error", message, false);
}
</script>

<template>
  <WallpaperStage
    class="w-full h-full"
    :target="target"
    :style-mode="styleMode"
    :transition="transition"
    :volume="volume"
    :playback-rate="playbackRate"
    :paused="props.playing === false"
    :interactive="props.interactive"
    @ready="emit('ready')"
    @error="onStageError"
    @scene-live="emit('sceneLive', $event)"
  />
</template>
