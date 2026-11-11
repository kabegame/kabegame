/**
 * 按 SHA-256 钉死的下载：构建脚本拉工具链等大文件用。
 *
 *   await fetchPinned(url, sha256, dest);
 *
 * - `dest` 已存在且摘要对：直接返回，不碰网络（可以先手动把文件拷进去）；摘要不对：删掉重下。
 * - 下载写到 `<dest>.part`，校验通过才改名成 `dest`，中途失败不会留下看似完整的文件。
 * - 失败自动重试；`.part` 留着时用 `Range` 续传（服务器不支持续传就从头来）。续传拼出的文件摘要不对时删掉重下。
 * - 连续 {@link IDLE_TIMEOUT_MS} 收不到数据算失败（网络卡住时不至于一直挂着）。
 *
 * 只依赖 Node 内建模块与全局 fetch（Deno 下会读 HTTP(S)_PROXY）。
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const IDLE_TIMEOUT_MS = 60_000;

export interface FetchPinnedOptions {
  /** 最多尝试几次，默认 5。 */
  attempts?: number;
  /** 日志输出，默认 console.log。 */
  log?: (message: string) => void;
}

/** 文件的 SHA-256（小写十六进制），流式计算。 */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

function formatSize(bytes: number): string {
  return bytes >= 1 << 20
    ? `${(bytes / (1 << 20)).toFixed(1)} MiB`
    : `${(bytes / 1024).toFixed(0)} KiB`;
}

/** 下载一次到 `part`：已有部分时尝试续传；服务器回 416 说明 `.part` 已经到头，交给调用方校验摘要。 */
async function downloadOnce(
  url: string,
  part: string,
  log: (message: string) => void,
): Promise<void> {
  const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const controller = new AbortController();
  let idle = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: have > 0 ? { Range: `bytes=${have}-` } : {},
      redirect: "follow",
      signal: controller.signal,
    });
    if (response.status === 416) {
      // 请求的区间越过了文件末尾：.part 已经完整（或比原文件长），交给摘要判定
      await response.body?.cancel();
      return;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    // 只有 206 且区间起点正好接上时才追加，否则从头写
    const range = response.headers.get("content-range") ?? "";
    const append = have > 0 && response.status === 206 &&
      range.startsWith(`bytes ${have}-`);
    const length = Number(response.headers.get("content-length") ?? 0);
    const total = append ? have + length : length;
    log(
      append
        ? `续传（已有 ${formatSize(have)}，共 ${formatSize(total)}）`
        : `下载（${total ? formatSize(total) : "大小未知"}）`,
    );
    if (!response.body) throw new Error("响应没有正文");
    const fd = fs.openSync(part, append ? "a" : "w");
    try {
      const reader = response.body.getReader();
      let received = append ? have : 0;
      let reported = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        clearTimeout(idle);
        idle = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
        fs.writeSync(fd, value);
        received += value.byteLength;
        // 每 10% 报一次进度
        if (total && received * 10 >= (reported + 1) * total) {
          reported = Math.floor((received * 10) / total);
          log(`  ${reported * 10}%（${formatSize(received)}）`);
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    clearTimeout(idle);
  }
}

/**
 * 把 `url` 下载到 `dest` 并校验 SHA-256（`sha256` 为十六进制，不分大小写）。已有且摘要对就跳过。
 * 用尽重试仍失败时抛错。
 */
export async function fetchPinned(
  url: string,
  sha256: string,
  dest: string,
  options: FetchPinnedOptions = {},
): Promise<void> {
  const want = sha256.toLowerCase();
  const log = options.log ?? ((message: string) => console.log(message));
  const attempts = options.attempts ?? 5;
  const name = path.basename(dest);

  if (fs.existsSync(dest)) {
    const got = await sha256File(dest);
    if (got === want) {
      log(`${name}：已缓存，SHA-256 一致`);
      return;
    }
    log(`${name}：已有文件的 SHA-256 不符（${got}），重新下载`);
    fs.rmSync(dest, { force: true });
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      log(`${name}：第 ${attempt} 次，${url}`);
      await downloadOnce(url, part, (message) => log(`${name}：${message}`));
      const got = await sha256File(part);
      if (got !== want) {
        fs.rmSync(part, { force: true });
        throw new Error(`SHA-256 不符：期望 ${want}，实际 ${got}`);
      }
      fs.renameSync(part, dest);
      log(`${name}：完成，SHA-256 一致`);
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      log(`${name}：第 ${attempt} 次失败：${message}`);
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }
  }
  throw new Error(
    `下载 ${url} 失败（${attempts} 次）：${
      lastError instanceof Error ? lastError.message : String(lastError)
    }\n` +
      `网络不稳时可以手动下载后放到 ${dest}，摘要对就不再下载。`,
  );
}
