/**
 * WebGPU 适配器与设备。缺 WebGPU、拿不到适配器、建设备失败都抛 `SceneRenderError`，由调用方退回预览图；
 * DXT 纹理不做 CPU 解码，适配器不支持 `texture-compression-bc` 时，只要场景用到 BC 格式就退回（见 `SceneRenderer.load`）。
 */
import { oneLine, SceneRenderError } from "./errors";

export interface GpuAdapterInfo {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  features: string[];
  maxTextureDimension2D: number;
}

export interface Gpu {
  adapter: GPUAdapter;
  device: GPUDevice;
  info: GpuAdapterInfo;
  /** 设备已开启的特性（只开场景可能需要的）。 */
  features: ReadonlySet<string>;
}

/**
 * 场景可能用到、适配器有就开的特性：BC 压缩纹理；puppet 变形纹理（P12b1 步骤 4）一律是 `rgba32float`，要 `float32-filterable`，没有时场景退回
 * （`render:morph-texture`）。不用 WPE 的 `rgba16snorm`：rgba16snorm 在 Dawn 上只能当 unfilterable-float 采样，而翻译出的着色器是 textureSampleLevel + 普通 sampler，auto layout 要 filterable float，绑不上；WPE 是 rgba16snorm，snorm → float 的换算是 c / 32767，结果相同。
 */
const OPTIONAL_FEATURES: GPUFeatureName[] = ["texture-compression-bc", "float32-filterable"];

export async function acquireGpu(): Promise<Gpu> {
  if (typeof navigator === "undefined" || !navigator.gpu) throw new SceneRenderError(["webgpu:unavailable"]);
  let adapter: GPUAdapter | null;
  try {
    adapter = await navigator.gpu.requestAdapter();
  } catch (error) {
    throw new SceneRenderError([`webgpu:no-adapter:${oneLine(String(error))}`]);
  }
  if (!adapter) throw new SceneRenderError(["webgpu:no-adapter"]);
  const requiredFeatures = OPTIONAL_FEATURES.filter((feature) => adapter.features.has(feature));
  // 二维纹理上限取适配器支持的最大值（P12c 走查 F2）：WebGPU 缺省只给 8192，WPE（D3D11）是 16384。语料 3830665420 有个文本层 `size`
  // 9787×199 带 effect，合成 RT 按缺省上限建不出、整张退回。场景目标、用户纹理等按 `device.limits` 钳的地方随之放宽到同一个值
  const requiredLimits = { maxTextureDimension2D: adapter.limits.maxTextureDimension2D };
  let device: GPUDevice;
  try {
    device = await adapter.requestDevice({ label: "kabegame scene", requiredFeatures, requiredLimits });
  } catch (error) {
    throw new SceneRenderError([`webgpu:device-failed:${oneLine(String(error))}`]);
  }
  const raw = adapter.info;
  return {
    adapter,
    device,
    features: new Set(device.features),
    info: {
      vendor: raw?.vendor ?? "",
      architecture: raw?.architecture ?? "",
      device: raw?.device ?? "",
      description: raw?.description ?? "",
      features: [...adapter.features].sort(),
      maxTextureDimension2D: device.limits.maxTextureDimension2D,
    },
  };
}
