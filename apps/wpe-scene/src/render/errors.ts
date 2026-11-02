/**
 * 渲染器退回预览图的原因。`reasons` 是可读的原因键，形如 `类别:细节`：
 * - `webgpu:unavailable` / `webgpu:no-adapter` / `webgpu:no-bc` / `webgpu:device-failed:…` / `webgpu:device-lost:…`
 * - `webgpu:shader:<程序号>:<阶段>:<首条错误>`（Tint 校验）、`webgpu:pipeline:<程序号>:…`、`webgpu:validation:…`
 * - `webgpu:texture-*:<路径>…`、`render:*`（bundle 里出现渲染器还不会画的结构）
 */
export class SceneRenderError extends Error {
  constructor(readonly reasons: string[]) {
    super(reasons.join("; "));
    this.name = "SceneRenderError";
  }
}

/** 把任意错误整理成原因键；`SceneRenderError` 原样展开，其它错误归到 `fallback` 类别下。 */
export function reasonsOf(error: unknown, fallback: string): string[] {
  if (error instanceof SceneRenderError) return error.reasons;
  const message = error instanceof Error ? error.message : String(error);
  return [`${fallback}:${oneLine(message)}`];
}

export function oneLine(message: string, limit = 160): string {
  return message.replace(/\s+/g, " ").trim().slice(0, limit);
}
