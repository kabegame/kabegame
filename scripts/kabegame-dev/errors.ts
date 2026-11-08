/**
 * REST 层统一的错误：带 HTTP 状态、出错的层与附加字段，`rest.ts` 原样转成 `{ error, layer, ...extra }`。
 */
export class DevError extends Error {
  constructor(
    readonly status: number,
    readonly layer: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DevError";
  }
}

/** 参数错。 */
export function badRequest(message: string, extra?: Record<string, unknown>): DevError {
  return new DevError(400, "rest", message, extra);
}

/** 句柄、任务、控制台流不存在：多半是 vite 重启过或 CDP 连接断开过。 */
export function staleHandle(kind: string, id: string): DevError {
  return new DevError(
    404,
    "handle",
    `${kind} ${id} 不存在：句柄、任务、控制台流都在 vite 进程里，vite 重启过或 CDP 连接断开过都会丢，请重开`,
    { id },
  );
}

/** 当前平台没有这项能力。 */
export function wrongPlatform(what: string, android: boolean): DevError {
  return new DevError(
    400,
    "platform",
    `${what}只在${android ? "桌面" : "安卓"}可用（当前是${android ? "安卓" : "桌面"} dev）`,
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}
