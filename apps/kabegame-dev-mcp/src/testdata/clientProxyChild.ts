/**
 * `client.test.ts` 的子进程：由 `runWithProxy` 带假代理的环境变量启动，用缺省的 `createClient()` 打 REST，结果打一行 JSON。
 * 用法：deno run -A clientProxyChild.ts <假 REST 端口> <没人监听的端口>
 */
import process from "node:process";
import { KabegameDevError, createClient } from "../client.ts";

const [restPort, dead] = process.argv.slice(2).map(Number);
const out: Record<string, unknown> = {};
// 对照组：全局 fetch 会被交给代理，证明这个子进程里的代理环境变量是生效的
out.control = await fetch(`http://127.0.0.1:${restPort}/control`).then(
  async (res) => `${res.status} ${await res.text()}`,
  (error) => `ERR ${error.message}`,
);
try {
  out.dead = { ok: true, value: await createClient({ port: dead }).health() };
} catch (error) {
  out.dead =
    error instanceof KabegameDevError
      ? { layer: error.layer, status: error.status, message: error.message }
      : { other: String(error) };
}
try {
  out.live = { ok: true, value: await createClient({ port: restPort }).health() };
} catch (error) {
  out.live = { ok: false, error: String(error) };
}
console.log(JSON.stringify(out));
process.exit(0);
