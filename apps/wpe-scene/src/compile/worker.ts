import { compileScene, transferableBuffers } from "./bundle";
import type { SceneReader } from "./fs";
import { decodeFileError, type WorkerRequest, type WorkerResponse } from "./protocol";
import { Wpesl2wgsl } from "../wpesl2wgsl";

let nextId = 1;
const pending = new Map<number, { resolve: (value: { bytes?: Uint8Array }) => void; reject: (error: Error) => void }>();
function ask(
  operation: "range" | "whole",
  path: string,
  start?: number,
  end?: number,
): Promise<{ bytes?: Uint8Array }> {
  const id = nextId++;
  const message: WorkerResponse = { type: "file", id, operation, path, start, end };
  self.postMessage(message);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
const reader: SceneReader = {
  async readRange(path, start, end) {
    const result = await ask("range", path, start, end);
    if (!result.bytes) throw new Error("缺少文件区间响应");
    return result.bytes;
  },
  async readWhole(path) {
    const result = await ask("whole", path);
    if (!result.bytes) throw new Error("缺少整文件响应");
    return result.bytes;
  },
};

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === "file-result") {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(decodeFileError(message.error));
    else waiter.resolve(message);
    return;
  }
  try {
    const translator = message.module ? await Wpesl2wgsl.fromModule(message.module) : null;
    const bundle = await compileScene({
      projectDir: message.projectDir,
      sceneAssets: message.sceneAssets,
      userProperties: message.userProperties,
      scriptOverrides: message.scriptOverrides,
      postprocess: message.postprocess,
      reflection: message.reflection,
      force: message.force,
      exhaustive: message.exhaustive,
      reader,
      translator,
    });
    const response: WorkerResponse = { type: "done", bundle };
    self.postMessage(response, { transfer: transferableBuffers(bundle) });
  } catch (error) {
    const response: WorkerResponse = { type: "error", message: String(error) };
    self.postMessage(response);
  }
};
