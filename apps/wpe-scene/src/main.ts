// 场景宿主（P3-0）：现在只有一块全屏 WebGPU 画布，逐帧清屏证明设备与画布可用；渲染器迁移（P3-0 阶段 1）后
// 换成 SceneRenderer。宿主随 iframe 一起销毁，不需要卸载逻辑。
import { invoke } from "@tauri-apps/api/core";

const instance = new URLSearchParams(location.search).get("kbInstance") ?? "";
let paused = false;
let ready = false;

type SceneReport =
  | { kind: "ready"; instance: string }
  | { kind: "fallback"; instance: string; reasons: string[] }
  | { kind: "log"; level: string; message: string };

async function report(report: SceneReport) {
  try {
    await invoke("wpe_scene_report", { report });
  } catch (error) {
    console.error("场景宿主上报失败", error);
  }
}

declare global {
  interface Window {
    wallpaperPropertyListener?: {
      applyUserProperties(changed: Record<string, { type: string; value: unknown }>): void;
      setPaused(value: boolean): void;
    };
  }
}

window.wallpaperPropertyListener = {
  applyUserProperties(changed) {
    void report({ kind: "log", level: "info", message: `applyUserProperties ${Object.keys(changed).join(",")}` });
    if (!ready) {
      ready = true;
      void report({ kind: "ready", instance });
    }
  },
  setPaused(value) {
    paused = value;
  },
};

/** 画布像素尺寸跟随 CSS 尺寸与 DPR。 */
function fitCanvas(element: HTMLCanvasElement) {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(element.clientWidth * ratio));
  const height = Math.max(1, Math.round(element.clientHeight * ratio));
  if (element.width !== width || element.height !== height) {
    element.width = width;
    element.height = height;
  }
}

async function start(element: HTMLCanvasElement) {
  if (!navigator.gpu) {
    void report({ kind: "fallback", instance, reasons: ["webgpu:unavailable"] });
    return;
  }
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter?.requestDevice();
  const context = element.getContext("webgpu");
  if (!device || !context) {
    void report({ kind: "fallback", instance, reasons: ["webgpu:unavailable"] });
    return;
  }
  context.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: "opaque" });

  const draw = (time: number) => {
    if (paused) {
      requestAnimationFrame(draw);
      return;
    }
    fitCanvas(element);
    // 很慢的明暗呼吸，肉眼可确认渲染循环在跑
    const level = 0.08 + 0.06 * Math.sin(time / 1000);
    const encoder = device.createCommandEncoder();
    encoder
      .beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: level, g: level, b: level * 1.4, a: 1 },
          },
        ],
      })
      .end();
    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
}

const canvas = document.querySelector<HTMLCanvasElement>("#scene-canvas");
if (canvas)
  void start(canvas).catch((error) => {
    void report({ kind: "log", level: "error", message: `WebGPU 初始化失败: ${error}` });
    void report({ kind: "fallback", instance, reasons: ["webgpu:unavailable"] });
  });
