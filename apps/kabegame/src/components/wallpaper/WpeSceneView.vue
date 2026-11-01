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
 * - 后处理档位（设置「场景后处理」`wpeScenePostprocess`）每次加载都经 IPC 读一次，跟随 WPE 时由编译管线读 WPE 的
 *   `config.json`；监听 `setting-change`，档位变了就重新判定、重新加载（壁纸窗口不装 settings store，这里自己读）。
 *   泛光 / HDR 由编译结果决定（`bundle.bloom`）；HDR 切换要换场景目标格式，重新加载时整份 `GpuScene` 重建，不复用旧目标。
 * - FreeImage 纹理（4K PNG）的解码结果按目标缓存（`TextureDecodeCache`），改属性重新编译时不再重复解码。
 * - dev 强制渲染（D4）：`localStorage["kabegame-dev-scene-force-render"] = "1"` 时有不支持项也照常渲染，看半成品。
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { invoke } from "@/api";
import { IS_DEV } from "@/env";
import { kbEvent$ } from "@/services/kbEvents/eventSource";
import { logger } from "@/utils/logger";
import { compileSceneInWorker } from "@/wpe-scene/compile/client";
import { TextureDecodeCache } from "@/wpe-scene/compile/decode";
import { FetchSceneReader } from "@/wpe-scene/compile/fs";
import { SCENE_POSTPROCESS_SETTINGS, type ScenePostprocessSetting } from "@/wpe-scene/compile/postprocess";
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
/** dev 强制渲染开关（主窗口与壁纸窗口同源，共用一份 localStorage）。 */
const FORCE_RENDER_KEY = "kabegame-dev-scene-force-render";

function forceRender(): boolean {
  if (!IS_DEV) return false;
  try {
    return localStorage.getItem(FORCE_RENDER_KEY) === "1";
  } catch {
    return false;
  }
}

function asPostprocess(value: unknown): ScenePostprocessSetting {
  return SCENE_POSTPROCESS_SETTINGS.includes(value as ScenePostprocessSetting)
    ? (value as ScenePostprocessSetting)
    : "follow";
}

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
/** 上次加载用的后处理设置；`setting-change` 里的新值不同才重新加载。 */
let postprocess: ScenePostprocessSetting | null = null;
const reader = new FetchSceneReader();
/** FreeImage 纹理的解码缓存：每个目标一份，换目标或卸载时释放。 */
let textureCache = new TextureDecodeCache(reader);

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function targetKey(target: WallpaperTarget): string {
  return [target.id, target.path, ...(target.sceneAssets ?? [])].join("\n");
}

/** 读「场景后处理」设置；读不到按跟随 WPE。 */
async function readPostprocess(): Promise<ScenePostprocessSetting> {
  try {
    return asPostprocess(await invoke<string>("get_wpe_scene_postprocess"));
  } catch (error) {
    logger.warn("读取场景后处理设置失败，按跟随 WPE 处理：", error);
    return "follow";
  }
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
    const [properties, setting] = await Promise.all([readProperties(target.id), readPostprocess()]);
    if (id !== generation) return;
    metadataId = properties.metadataId;
    postprocess = setting;
    const userProperties = properties.values;
    const force = forceRender();
    const bundle = await compileSceneInWorker({
      projectDir: target.path,
      sceneAssets: target.sceneAssets,
      userProperties,
      postprocess: setting,
      force,
      textureCache,
      reader,
      signal: abort.signal,
    }).catch((error: unknown) => {
      throw isAbort(error) ? error : new SceneRenderError(reasonsOf(error, "compile"));
    });
    if (id !== generation) return;
    if (bundle.unsupported.length) {
      if (!force) {
        fallback(bundle.unsupported);
        return;
      }
      logger.warn(`场景壁纸 ${target.id} 强制渲染（dev），不支持项：`, bundle.unsupported.join("; "));
    }
    const current = await ensureRenderer();
    if (id !== generation) return;
    await current.load(bundle, { ignoreUnsupported: force });
    if (id !== generation) return;
    current.setPaused(props.paused);
    for (const warning of current.warnings.splice(0)) logger.debug(`场景着色器 ${target.id}：${warning}`);
    const stats = current.sceneStats;
    const post = bundle.general.postprocess;
    const detail =
      `后处理 ${post.level}（${bundle.bloom ? (bundle.bloom.hdr ? "泛光 + HDR" : "泛光") : "无泛光"}）` +
      (stats
        ? `，目标 ${stats.width}×${stats.height} ${stats.format}、渲染目标约 ${Math.round(stats.targetBytes / 2 ** 20)} MiB`
        : "");
    if (state !== "ready") {
      state = "ready";
      lastFallback = "";
      logger.info(
        `场景壁纸 ${target.id} 开始渲染：${bundle.layers.length} 层、${bundle.programs.length} 个程序，` +
          `${detail}，用时 ${Math.round(performance.now() - started)} ms`,
      );
      emit("ready");
    } else
      logger.debug(`场景壁纸 ${target.id} 重新加载：${detail}，用时 ${Math.round(performance.now() - started)} ms`);
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
// 改「场景后处理」后正在显示的场景重新判定、重新加载（payload 为 `{ changes: { key: value } }` 或直接是变更对象）
const settingChanges = kbEvent$<Record<string, unknown>>("setting-change").subscribe((event) => {
  const raw = event.payload;
  const delta = (raw && typeof raw.changes === "object" ? raw.changes : raw) as Record<string, unknown> | null;
  if (!delta || !("wpeScenePostprocess" in delta)) return;
  const next = asPostprocess(delta.wpeScenePostprocess);
  if (postprocess !== null && next === postprocess) return;
  logger.debug(`场景壁纸 ${props.target.id} 后处理设置 ${postprocess} → ${next}，重新判定`);
  void reload();
});

watch(
  () => targetKey(props.target),
  () => {
    // 换目标：销毁设备、释放解码缓存，从头来
    dropRenderer();
    textureCache.clear();
    textureCache = new TextureDecodeCache(reader);
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
  settingChanges.unsubscribe();
  dropRenderer();
  textureCache.clear();
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
