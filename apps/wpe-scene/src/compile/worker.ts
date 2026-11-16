import { createWorkerHandler } from "./workerHandler";
import type { WorkerRequest, WorkerResponse } from "./protocol";

// 逻辑都在 `workerHandler.ts`（可在 Node 里测）；这里只接上 postMessage 与 close
const handler = createWorkerHandler(
  (message: WorkerResponse, transfer: Transferable[]) => self.postMessage(message, { transfer }),
  { onClose: () => self.close() },
);
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  void handler(event.data);
};
