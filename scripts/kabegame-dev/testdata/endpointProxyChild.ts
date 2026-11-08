/**
 * `endpoint.test.ts` 的子进程：由 `runWithProxy` 带假代理的环境变量启动，用缺省实现探端点、连 CDP，结果打一行 JSON。
 * 用法：deno run -A endpointProxyChild.ts <假 CDP 端口> <没人监听的端口>
 */
import process from "node:process";
import { connectCdp } from "../cdp.ts";
import { probeCdp, resolveEndpoint } from "../endpoint.ts";

const [cdpPort, dead] = process.argv.slice(2).map(Number);
const out: Record<string, unknown> = {};
// 对照组：全局 fetch 会被交给代理，证明这个子进程里的代理环境变量是生效的
out.control = await fetch(`http://127.0.0.1:${cdpPort}/control`).then(
  async (res) => `${res.status} ${await res.text()}`,
  (error) => `ERR ${error.message}`,
);
out.probeLive = await probeCdp(cdpPort);
out.probeDead = await probeCdp(dead);
out.desktopLive = await resolveEndpoint({ android: false, readRegistration: async () => ({ port: cdpPort, pid: 1 }) });
out.desktopDead = await resolveEndpoint({ android: false, readRegistration: async () => ({ port: dead, pid: 1 }) });
try {
  const conn = await connectCdp(`ws://127.0.0.1:${cdpPort}/devtools/browser/fake`);
  out.ws = await conn.send("Target.getTargets");
  conn.close();
} catch (error) {
  out.ws = `ERR ${(error as Error).message}`;
}
console.log(JSON.stringify(out));
process.exit(0);
