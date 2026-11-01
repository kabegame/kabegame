<script setup lang="ts">
/**
 * WPE 场景壁纸（`x-wpe/scene`）的渲染视图：自取数据的子组件，地位等同 `WallpaperStage` web 层的 iframe。
 *
 * - 自己读用户属性（`get_wpe_web_properties`，与网页壁纸同一格式）、自己在 Worker 里编译（`compileSceneInWorker`）、
 *   自己用 WebGPU 渲染（`SceneRenderer`）；`WallpaperStage` 只传 props，仍然不 invoke、不 listen。
 * - 监听本张图的 `metadataId` 字段补丁（`image-changed` / `images-change`）：属性改了就重读、重编译，在同一设备上
 *   换掉场景（时钟不重置，动画不从头开始）。
 * - 渲染出第一帧 emit `ready`；不能渲染时 emit `fallback(reasons)`，调用方据此显示预览图。原因键见
 *   `wpe-scene/render/errors.ts`：编译期的 `unsupported` 原样给出，另有 `webgpu:*`（不可用、缺 BC、Tint 报错、
 *   管线失败、设备丢失……）、`render:*`、`compile:*`。属性变化可能让场景重新可渲染，这时会再 emit `ready`。
 * - 设备丢失时重建一次渲染器（一分钟内再丢就退回）；换目标或卸载时终止编译、销毁 GPU 资源与设备。
 * - `interactive` 时把指针位置交给渲染器（`g_PointerPosition`），P1 的样本都不用。
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { invoke } from "@/api";
import { kbEvent$ } from "@/services/kbEvents/eventSource";
import { logger } from "@/utils/logger";
import { compileSceneInWorker } from "@/wpe-scene/compile/client";
import { reasonsOf, SceneRenderError, SceneRenderer } from "@/wpe-scene/render";
import type { WallpaperTarget } from "./types";

const props = withDefaults(
  defineProps<{
    target: WallpaperTarget;
    /** true 时停止帧循环（画面停在最后一帧，`g_Time` 冻结） */
    paused?: boolean;
    /** 预览内嵌 / 桌面转发鼠标时为 true：画布接收指针事件 */
    interactive?: boolean;
  }>(),
  { paused: false, interactive: false },
);

const emit = defineEmits<{ ready: []; fallback: [reasons: string[]] }>();

const canvasRef = ref<HTMLCanvasElement | null>(null);

interface PropertiesView {
  metadataId: number | null;
  items: { key: string; kind: string; value?: unknown }[];
}

/** 一分钟内第二次设备丢失就不再重建。 */
const LOST_RETRY_WINDOW_MS = 60_000;

let renderer: SceneRenderer | null = null;
let rendererTask: Promise<SceneRenderer> | null = null;
let controller: AbortController | null = null;
/** 每次重载递增；异步步骤回来发现不是最新的就放弃。 */
let generation = 0;
/** 当前编译用的属性来自哪个 metadata 行；补丁里的值不同才重载。 */
let metadataId: number | null | undefined;
let state: "idle" | "loading" | "ready" | "fallback" = "idle";
let lastFallback = "";
let lastLostAt = -Infinity;
let disposed = false;

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function targetKey(target: WallpaperTarget): string {
  return [target.id, target.path, ...(target.sceneAssets ?? [])].join("\n");
}

/** 读作者属性的当前值；读不到不致命，按项目默认值编译。`metadataId` 由调用方确认这次重载仍是最新的再记下。 */
async function readProperties(
  imageId: string,
): Promise<{ values: Record<string, unknown>; metadataId: number | null }> {
  try {
    const view = await invoke<PropertiesView | null>("get_wpe_web_properties", { imageId });
    const values: Record<string, unknown> = {};
    for (const item of view?.items ?? [])
      if (item.kind !== "group" && item.kind !== "text" && item.value !== undefined && item.value !== null)
        values[item.key] = item.value;
    return { values, metadataId: view?.metadataId ?? null };
  } catch (error) {
    logger.warn(`场景壁纸 ${imageId} 读取用户属性失败，按默认值渲染：`, error);
    return { values: {}, metadataId: null };
  }
}

function dropRenderer() {
  rendererTask = null;
  renderer?.destroy();
  renderer = null;
}

function ensureRenderer(): Promise<SceneRenderer> {
  if (rendererTask) return rendererTask;
  const canvas = canvasRef.value;
  if (!canvas) return Promise.reject(new Error("画布未挂载"));
  const task: Promise<SceneRenderer> = SceneRenderer.create(canvas, {
    onError: (reasons) => {
      if (rendererTask === task) fallback(reasons);
    },
    onLost: (reasons) => {
      if (rendererTask !== task) return;
      dropRenderer();
      const now = performance.now();
      if (now - lastLostAt < LOST_RETRY_WINDOW_MS) {
        fallback(reasons);
        return;
      }
      lastLostAt = now;
      logger.warn(`场景壁纸 ${props.target.id} 设备丢失，重建渲染器：`, reasons.join("; "));
      void reload();
    },
  }).then(
    (created) => {
      if (rendererTask !== task || disposed) {
        created.destroy();
        throw new DOMException("渲染器已过期", "AbortError");
      }
      renderer = created;
      const info = created.adapterInfo;
      logger.debug(
        `场景渲染器：${info.vendor} ${info.architecture} ${info.description}`.trim(),
        `BC=${info.features.includes("texture-compression-bc")}`,
      );
      return created;
    },
    (error) => {
      if (rendererTask === task) rendererTask = null;
      throw error;
    },
  );
  rendererTask = task;
  return task;
}

/** 退回预览图：不渲染时不占设备，运行期出错的渲染器也不再复用。 */
function fallback(reasons: string[]) {
  dropRenderer();
  const key = reasons.join("\n");
  if (state === "fallback" && key === lastFallback) return;
  state = "fallback";
  lastFallback = key;
  logger.warn(`场景壁纸 ${props.target.id} 退回预览图：`, reasons.join("; "));
  emit("fallback", reasons);
}

/** 读属性 → 编译 → （必要时建渲染器）→ 换场景。目标变化、属性补丁、设备丢失都走这里。 */
async function reload() {
  // 拷成普通值：调用方传进来的 target 往往是响应式 Proxy，交给 Worker 的 postMessage 克隆不了
  const target = { id: props.target.id, path: props.target.path, sceneAssets: [...(props.target.sceneAssets ?? [])] };
  const id = ++generation;
  controller?.abort();
  const abort = (controller = new AbortController());
  if (state !== "ready") state = "loading";
  const started = performance.now();
  try {
    const properties = await readProperties(target.id);
    if (id !== generation) return;
    metadataId = properties.metadataId;
    const userProperties = properties.values;
    const bundle = await compileSceneInWorker({
      projectDir: target.path,
      sceneAssets: target.sceneAssets,
      userProperties,
      signal: abort.signal,
    }).catch((error: unknown) => {
      throw isAbort(error) ? error : new SceneRenderError(reasonsOf(error, "compile"));
    });
    if (id !== generation) return;
    if (bundle.unsupported.length) {
      fallback(bundle.unsupported);
      return;
    }
    const current = await ensureRenderer();
    if (id !== generation) return;
    await current.load(bundle);
    if (id !== generation) return;
    current.setPaused(props.paused);
    for (const warning of current.warnings.splice(0)) logger.debug(`场景着色器 ${target.id}：${warning}`);
    if (state !== "ready") {
      state = "ready";
      lastFallback = "";
      logger.info(
        `场景壁纸 ${target.id} 开始渲染：${bundle.layers.length} 层、${bundle.programs.length} 个程序，` +
          `用时 ${Math.round(performance.now() - started)} ms`,
      );
      emit("ready");
    }
  } catch (error) {
    if (id !== generation || isAbort(error)) return;
    fallback(reasonsOf(error, "render"));
  }
}

function onPointerMove(event: PointerEvent) {
  if (!props.interactive || !renderer) return;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  renderer.setPointer((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
}

function matchesPatch(patch: { id?: string; metadataId?: number } | null | undefined): boolean {
  return !!patch && patch.id === props.target.id && patch.metadataId !== undefined && patch.metadataId !== metadataId;
}

const changed = kbEvent$<{ patch?: { id: string; metadataId?: number } }>("image-changed").subscribe((event) => {
  if (matchesPatch(event.payload.patch)) void reload();
});
const changes = kbEvent$<{ patches?: { id: string; metadataId?: number }[] }>("images-change").subscribe((event) => {
  if (event.payload.patches?.some(matchesPatch)) void reload();
});

watch(
  () => targetKey(props.target),
  () => {
    // 换目标：销毁设备，从头来
    dropRenderer();
    metadataId = undefined;
    state = "idle";
    lastFallback = "";
    lastLostAt = -Infinity;
    void reload();
  },
);

watch(
  () => props.paused,
  (paused) => renderer?.setPaused(paused),
);

onMounted(() => {
  void reload();
});

onBeforeUnmount(() => {
  disposed = true;
  generation++;
  controller?.abort();
  changed.unsubscribe();
  changes.unsubscribe();
  dropRenderer();
});
</script>

<template>
  <canvas
    ref="canvasRef"
    class="block w-full h-full"
    :class="interactive ? 'pointer-events-auto' : 'pointer-events-none'"
    @pointermove="onPointerMove"
  />
</template>
