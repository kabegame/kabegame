<script setup lang="ts">
/**
 * WPE 场景壁纸（`x-wpe/scene`）的视图：场景宿主（`apps/wpe-scene`，P3-0）的 `file:` iframe 外壳，地位等同
 * `WallpaperStage` web 层的网页壁纸 iframe。编译、渲染、用户属性与后处理档位都在宿主里，这里不碰。
 *
 * - 地址：`get_wpe_scene_host_url` + `kbScene=<图片 id>` + `kbInstance=<实例号>`；换目标就换实例号、重建 iframe。
 * - 状态：宿主经 `wpe_scene_report` 报 `ready` / `fallback`，后端以 `wpe-scene-status` 发回本窗口，这里只认本实例号，
 *   照旧 emit `ready` / `fallback(reasons)`；取不到宿主地址时 emit `fallback(["host:unavailable"])`。
 * - 暂停与音量：回应本 iframe 里垫片的音量请求（`wpeWebVolume.ts` 的协议，消息带 `paused`，垫片转成
 *   `setPaused`），`volume` / `paused` 变化时主动推。第一次收到请求说明垫片已在跑，emit `alive`：
 *   壁纸窗口从此把 ping 交给宿主里的垫片应答。
 * - 样式与尺寸：`styleMode` 经 `wpeSceneStyle.ts` 的协议交给宿主，由它铺放；出首帧时宿主报场景分辨率，emit `size`。
 * - 指针：`interactive` 时 iframe 接收指针事件，宿主自己算 `g_PointerPosition`。
 */
import { invoke } from "@/api";
import { logger } from "@/utils/logger";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Mode, WallpaperContentSize, WallpaperTarget } from "./types";
import { WEB_SANDBOX } from "./webSandbox";
import { isWpeSceneStyleRequest, wpeSceneSizeOf, wpeSceneStyleMessage } from "./wpeSceneStyle";
import { isWpeVolumeRequest, webHostVolume, wpeVolumeMessage } from "./wpeWebVolume";

const props = withDefaults(
  defineProps<{
    target: WallpaperTarget;
    styleMode: Mode;
    paused?: boolean;
    volume: number;
    interactive?: boolean;
  }>(),
  { paused: false, interactive: false },
);
const emit = defineEmits<{ ready: []; fallback: [reasons: string[]]; alive: []; size: [size: WallpaperContentSize] }>();
const frame = ref<HTMLIFrameElement | null>(null);
const src = ref("");
let instance = "";
let alive = false;
let generation = 0;
let disposed = false;
let unlisten: UnlistenFn | null = null;

function postVolume() {
  const target = frame.value?.contentWindow;
  if (!target) return;
  try {
    target.postMessage(wpeVolumeMessage(webHostVolume(props.volume, props.paused), props.paused), "*");
  } catch (error) {
    logger.warn(`场景宿主音量发送失败: ${error}`);
  }
}

function postStyle() {
  frame.value?.contentWindow?.postMessage(wpeSceneStyleMessage(props.styleMode), "*");
}

function onWindowMessage(event: MessageEvent) {
  const target = frame.value?.contentWindow;
  if (!target || !event.isTrusted || event.source !== target) return;
  if (isWpeSceneStyleRequest(event.data)) {
    postStyle();
    return;
  }
  const size = wpeSceneSizeOf(event.data);
  if (size) {
    emit("size", size);
    return;
  }
  if (!isWpeVolumeRequest(event.data)) return;
  postVolume();
  if (!alive) {
    alive = true;
    emit("alive");
  }
}

async function start() {
  const id = ++generation;
  src.value = "";
  alive = false;
  instance = crypto.randomUUID();
  try {
    const base = await invoke<string>("get_wpe_scene_host_url");
    if (disposed || id !== generation) return;
    const url = new URL(base);
    url.searchParams.set("kbScene", props.target.id);
    url.searchParams.set("kbInstance", instance);
    src.value = url.href;
  } catch (error) {
    if (disposed || id !== generation) return;
    logger.warn(`场景宿主不可用: ${error}`);
    emit("fallback", ["host:unavailable"]);
  }
}

onMounted(async () => {
  window.addEventListener("message", onWindowMessage);
  try {
    const stop = await listen<{ instance: string; kind: string; reasons?: string[] }>("wpe-scene-status", (event) => {
      if (disposed || event.payload.instance !== instance) return;
      if (event.payload.kind === "ready") emit("ready");
      else if (event.payload.kind === "fallback") emit("fallback", event.payload.reasons ?? []);
    });
    if (disposed) stop();
    else unlisten = stop;
  } catch (error) {
    logger.warn(`监听场景宿主状态失败: ${error}`);
    emit("fallback", ["host:unavailable"]);
    return;
  }
  if (!disposed) void start();
});

watch(
  () => [props.target.id, props.target.path, ...(props.target.sceneAssets ?? [])].join("\n"),
  () => {
    if (!disposed && unlisten) void start();
  },
);
watch(() => [props.volume, props.paused], postVolume);
watch(() => props.styleMode, postStyle);

onBeforeUnmount(() => {
  disposed = true;
  generation++;
  window.removeEventListener("message", onWindowMessage);
  unlisten?.();
  src.value = "";
});
</script>

<template>
  <iframe
    v-if="src"
    ref="frame"
    :src="src"
    :sandbox="WEB_SANDBOX"
    allow="autoplay; fullscreen"
    referrerpolicy="no-referrer"
    title="wallpaper-scene"
    class="block w-full h-full border-0"
    :class="interactive ? 'pointer-events-auto' : 'pointer-events-none'"
  />
</template>
