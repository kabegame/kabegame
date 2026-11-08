/**
 * 长任务表：画面哈希、导入测试工程、宿主任务这类几分钟的事由 vite 起，REST 立刻回任务 id，再查进度和结果。
 * 取消是协作式的（任务函数收 `AbortSignal`）。结束的任务只留最近 20 个。
 */
import { randomUUID } from "node:crypto";
import { errorMessage, staleHandle } from "./errors.ts";
import type { JobKind, JobRecord } from "./types.ts";

export interface JobContext {
  signal: AbortSignal;
  progress: (value: unknown) => void;
}

export type JobRunner = (ctx: JobContext) => Promise<unknown>;

const KEEP_FINISHED = 20;

export class JobTable {
  #jobs = new Map<string, { record: JobRecord; controller: AbortController; done: Promise<void> }>();

  start(kind: JobKind, params: unknown, run: JobRunner): JobRecord {
    const id = `j-${randomUUID().slice(0, 8)}`;
    const controller = new AbortController();
    const record: JobRecord = {
      id,
      kind,
      params,
      status: "running",
      progress: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    const done = Promise.resolve()
      .then(() => {
        // 还没开始就被取消：不再启动
        if (controller.signal.aborted) throw new Error("已取消");
        return run({ signal: controller.signal, progress: (value) => (record.progress = value) });
      })
      .then(
        (result) => {
          record.result = result;
          record.status = controller.signal.aborted ? "canceled" : "done";
        },
        (error) => {
          record.error = errorMessage(error);
          record.status = controller.signal.aborted ? "canceled" : "failed";
        },
      )
      .finally(() => {
        record.endedAt = new Date().toISOString();
        this.#prune();
      });
    this.#jobs.set(id, { record, controller, done });
    return { ...record };
  }

  get(id: string): JobRecord {
    const job = this.#jobs.get(id);
    if (!job) throw staleHandle("任务", id);
    return { ...job.record };
  }

  list(): JobRecord[] {
    return [...this.#jobs.values()].map((job) => ({ ...job.record }));
  }

  /** 发出取消信号，等任务函数收尾（最多 5 s）后返回当前记录。 */
  async cancel(id: string): Promise<JobRecord> {
    const job = this.#jobs.get(id);
    if (!job) throw staleHandle("任务", id);
    if (job.record.status === "running") {
      job.controller.abort();
      await Promise.race([job.done, new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    return { ...job.record };
  }

  async cancelAll(): Promise<void> {
    await Promise.all(
      [...this.#jobs.values()]
        .filter((job) => job.record.status === "running")
        .map((job) => this.cancel(job.record.id)),
    );
  }

  counts(): { running: number; total: number } {
    const all = [...this.#jobs.values()];
    return { running: all.filter((job) => job.record.status === "running").length, total: all.length };
  }

  /** 等任务结束（测试用）。 */
  async settled(id: string): Promise<JobRecord> {
    const job = this.#jobs.get(id);
    if (!job) throw staleHandle("任务", id);
    await job.done;
    return { ...job.record };
  }

  #prune(): void {
    const finished = [...this.#jobs.values()].filter((job) => job.record.status !== "running");
    for (const job of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) {
      this.#jobs.delete(job.record.id);
    }
  }
}
