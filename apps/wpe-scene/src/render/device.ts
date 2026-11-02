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

/** 场景可能用到、适配器有就开的特性。 */
const OPTIONAL_FEATURES: GPUFeatureName[] = ["texture-compression-bc"];

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
  let device: GPUDevice;
  try {
    device = await adapter.requestDevice({ label: "kabegame scene", requiredFeatures });
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
