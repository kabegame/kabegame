// 场景宿主（P3-0）：现在只有一块全屏 WebGPU 画布，逐帧清屏证明设备与画布可用；渲染器迁移（P3-0 阶段 1）后
// 换成 SceneRenderer。宿主随 iframe 一起销毁，不需要卸载逻辑。

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
  if (!navigator.gpu) return;
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter?.requestDevice();
  const context = element.getContext("webgpu");
  if (!device || !context) return;
  context.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: "opaque" });

  const draw = (time: number) => {
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
if (canvas) void start(canvas);
