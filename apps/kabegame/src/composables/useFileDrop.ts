import { Ref, onUnmounted } from "vue";
import { kameMessage as ElMessage } from "@/utils/kameMessage";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke } from "@/api/rpc";
import { DragFileItem, DragFilePlan, DragFileZone, hitTestDragZone } from "@/directives/dragFile";
import { IS_ANDROID, IS_WEB } from "@/env";
import { claimInternalDrag } from "@/utils/dragExport";
// #region debug-drag
import { sendDebugEvent } from "@/debugIngest";
// #endregion debug-drag
import { i18n } from "@kabegame/i18n";

/** 后端根据路径推断类型（扩展名 + infer），用于拖入文件分类 */
const getFileDropKinds = async (paths: string[]): Promise<DragFileItem[]> => {
  if (paths.length === 0) return [];
  return invoke<DragFileItem[]>("get_file_drop_kinds", { paths });
};

/** 本次拖放会话（enter → drop/leave 期间有效），跨多次 over 事件复用探测结果 */
let sessionPaths: string[] | null = null;
let sessionItems: DragFileItem[] | null = null;
/** 会话是否已开始（首个 enter/over/drop 到达）；enter 可能缺席，不能只在 enter 里开会话 */
let sessionStarted = false;
/** 本会话是否为应用内拖拽（会话开始时认领），是则全程静默 */
let sessionInternal = false;
/** over 阶段命中的热区与其 plan 缓存，避免同一热区内重复计算 */
let lastZone: DragFileZone | null = null;
let lastPlan: DragFilePlan | null = null;

const clearSession = () => {
  sessionPaths = null;
  sessionItems = null;
  sessionStarted = false;
  sessionInternal = false;
  lastZone = null;
  lastPlan = null;
};

/** 坐标换算：Tauri 事件 position 是物理像素，DOM rect 是 CSS 像素 */
const toCss = (p: { x: number; y: number }) => {
  const r = window.devicePixelRatio || 1;
  return { x: p.x / r, y: p.y / r };
};

const resolveZone = (p: { x: number; y: number }) => {
  const css = toCss(p);
  // 兜底：多显示器不同缩放时，Rust 侧用的是主显示器的 scale factor，
  // 换算可能偏；按 CSS 坐标全 miss 时再用原始物理值重试一次。
  return hitTestDragZone(css.x, css.y) ?? hitTestDragZone(p.x, p.y);
};

/**
 * 文件拖拽 composable：路由层。
 * 只做类型探测 + 落点命中，具体接不接、导入什么行为下沉到各热区（v-drag-file）自己决定。
 */
export function useFileDrop(fileDropOverlayRef: Ref<any>) {
  let fileDropUnlisten: (() => void) | null = null;
  let currentWindow: ReturnType<typeof getCurrentWebviewWindow> | null = null;

  // 将窗口带到前台并聚焦（只在 enter 时调一次，避免每个 over 都发一次 IPC）
  const bringWindowToFront = async () => {
    if (!currentWindow) {
      currentWindow = getCurrentWebviewWindow();
    }
    try {
      await currentWindow.setFocus();
    } catch (error) {
      console.warn("[FileDrop] 将窗口带到前台失败:", error);
    }
  };

  const init = async () => {
    // 安卓与 web 下不支持拖拽导入，直接返回
    if (IS_ANDROID || IS_WEB) {
      return;
    }

    try {
      currentWindow = getCurrentWebviewWindow();

      fileDropUnlisten = await currentWindow.onDragDropEvent(async (event) => {
        // #region debug-drag
        void sendDebugEvent(
          "tauri_drag",
          {
            type: event.payload.type,
            sessionInternal,
            hasItems: !!sessionItems,
            paths: "paths" in event.payload ? event.payload.paths : undefined,
          },
          { sessionId: "drag-internal" },
        );
        // #endregion debug-drag
        // 会话开始：认领应用内起手。Linux CEF 上内部拖拽有时不发 enter，首个事件就是 over。
        if (event.payload.type === "enter" || (!sessionStarted && event.payload.type !== "leave")) {
          sessionStarted = true;
          sessionInternal = claimInternalDrag();
          // #region debug-drag
          void sendDebugEvent(
            "session_start",
            { via: event.payload.type, sessionInternal },
            { sessionId: "drag-internal" },
          );
          // #endregion debug-drag
        }

        if (event.payload.type === "enter") {
          if (sessionInternal) {
            sessionPaths = null;
            sessionItems = null;
            lastZone = null;
            lastPlan = null;
            fileDropOverlayRef.value?.hide();
            return;
          }
          // enter 的 position 恒为 (0,0)，不可信，这里只做全量类型探测，不命中、不显示浮层
          const paths = event.payload.paths ?? [];
          try {
            sessionItems = await getFileDropKinds(paths);
            sessionPaths = paths;
          } catch (error) {
            sessionItems = null;
            sessionPaths = null;
          }
          lastZone = null;
          lastPlan = null;
          await bringWindowToFront();
        } else if (event.payload.type === "over") {
          if (sessionInternal || !sessionItems) return;

          const zone = resolveZone(event.payload.position);
          if (!zone) {
            if (lastZone) {
              fileDropOverlayRef.value?.hide();
              lastZone = null;
              lastPlan = null;
            }
            return;
          }

          if (zone.el !== lastZone?.el) {
            lastZone = zone;
            lastPlan = zone.options.plan(sessionItems);
          }

          if (lastPlan) {
            fileDropOverlayRef.value?.show({
              rect: zone.rect(),
              label: lastPlan.label,
              hint: lastPlan.hint,
            });
          } else {
            fileDropOverlayRef.value?.hide();
          }
        } else if (event.payload.type === "drop") {
          if (sessionInternal) {
            fileDropOverlayRef.value?.hide();
            clearSession();
            return;
          }
          fileDropOverlayRef.value?.hide();
          lastZone = null;
          lastPlan = null;

          const droppedPaths = event.payload.paths ?? [];
          // 没有任何文件（拖文字/链接、或拖出时未带文件）：无可导入内容，静默，不提示「此处不支持」
          if (droppedPaths.length === 0 && !sessionPaths?.length) {
            clearSession();
            return;
          }
          let items = sessionItems;
          const pathsChanged =
            !sessionPaths ||
            droppedPaths.length !== sessionPaths.length ||
            droppedPaths.some((p, i) => p !== sessionPaths![i]);
          if (pathsChanged) {
            try {
              items = await getFileDropKinds(droppedPaths);
            } catch (error) {
              items = null;
            }
          }

          const zone = resolveZone(event.payload.position);
          const plan = zone && items ? zone.options.plan(items) : null;
          clearSession();

          if (!zone || !plan) {
            // #region debug-drag
            void sendDebugEvent(
              "drop_unsupported",
              { zone: !!zone, plan: !!plan, items: items?.length },
              { sessionId: "drag-internal" },
            );
            // #endregion debug-drag
            ElMessage.info(i18n.global.t("import.dropUnsupportedHere"));
            return;
          }

          try {
            await zone.options.onDrop(plan);
          } catch (error) {
            console.error("[FileDrop] 处理文件拖入失败:", error);
            ElMessage.error(
              `${i18n.global.t("import.fileDropFailed")}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        } else if (event.payload.type === "leave") {
          fileDropOverlayRef.value?.hide();
          clearSession();
        }
      });
    } catch (error) {
      console.error("[FileDrop] 注册文件拖拽事件监听失败:", error);
    }
  };

  const cleanup = () => {
    if (fileDropUnlisten) {
      fileDropUnlisten();
      fileDropUnlisten = null;
    }
    currentWindow = null;
  };

  onUnmounted(() => {
    cleanup();
  });

  return {
    init,
    cleanup,
  };
}
