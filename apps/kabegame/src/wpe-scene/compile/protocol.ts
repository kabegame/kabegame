import type { SceneBundle } from "./bundle";

/** 主线程读文件失败时回传给 Worker 的错误。保留类型名：SceneFs 靠 `TypeError("Failed to fetch")` 判断文件不存在。 */
export interface FileError {
  name: string;
  message: string;
}

export type WorkerRequest =
  | {
      type: "start";
      projectDir: string;
      sceneAssets: string[];
      userProperties: Record<string, unknown>;
      module: WebAssembly.Module | null;
    }
  | { type: "file-result"; id: number; bytes?: Uint8Array; error?: FileError };
export type WorkerResponse =
  | { type: "file"; id: number; operation: "range" | "whole"; path: string; start?: number; end?: number }
  | { type: "done"; bundle: SceneBundle }
  | { type: "error"; message: string };

export function encodeFileError(error: unknown): FileError {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}

/** 按类型名还原；只还原 TypeError / RangeError，其余一律是 Error。 */
export function decodeFileError(error: FileError): Error {
  if (error.name === "TypeError") return new TypeError(error.message);
  if (error.name === "RangeError") return new RangeError(error.message);
  return new Error(error.message);
}
