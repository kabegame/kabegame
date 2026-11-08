/**
 * 协议冒烟：另起子进程照 `.mcp.json` 的 `kabegame-dev` 项（同一组参数与权限，cwd 为仓库根）跑 `main.ts`，用 SDK 的
 * Client + StdioClientTransport 连上：initialize、tools/list、resources/list、调 status。
 * 背后是假的 REST（经 KABEGAME_DEV_SERVER_PORT 指过去）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { ROOT } from "../../../scripts/kabegame-dev/paths.ts";
import { Client, StdioClientTransport } from "./testdata/sdkClient.ts";
import { SESSION, TOOLS, fakeRest, sendJson } from "./testdata/fakeRest.ts";

const MCP_JSON = JSON.parse(readFileSync(path.join(ROOT, ".mcp.json"), "utf8"));
const ENTRY: { command: string; args: string[] } = MCP_JSON.mcpServers["kabegame-dev"];

describe("stdio 冒烟", () => {
  test(".mcp.json 的 kabegame-dev 项：deno 跑 main.ts，只给本机网络、不给 --allow-run / -A", () => {
    assert.equal(ENTRY.command, "deno");
    assert.deepEqual(ENTRY.args, [
      "run",
      "--allow-net=127.0.0.1,localhost",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "apps/kabegame-dev-mcp/src/main.ts",
    ]);
  });

  test("子进程 main.ts：initialize、tools/list、resources/list、status", async () => {
    const rest = await fakeRest((_req, _body, res) =>
      sendJson(res, 200, {
        vite: true,
        android: false,
        cdp: { kind: "desktop", port: 47370, webSocketUrl: "ws://x", pid: 7 },
        session: SESSION,
      }),
    );
    const transport = new StdioClientTransport({
      // 用当前 deno（PATH 里的 deno 可能是别的版本），参数原样取自 .mcp.json
      command: process.execPath,
      args: ENTRY.args,
      cwd: ROOT,
      env: { KABEGAME_DEV_SERVER_PORT: String(rest.port) },
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Uint8Array) => (stderr += new TextDecoder().decode(chunk)));
    const client = new Client({ name: "kbdev-smoke", version: "0" });
    try {
      await client.connect(transport, { timeout: 60_000 });
      const info = client.getServerVersion();
      assert.equal(info?.name, "kabegame-dev");
      assert.match(client.getInstructions() ?? "", /先调 status/);
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((t: { name: string }) => t.name),
        TOOLS,
      );
      const { resources } = await client.listResources();
      assert.ok(resources.some((r: { uri: string }) => r.uri === "kabegame-dev://health"));
      const status = (await client.callTool({ name: "status", arguments: {} })) as {
        content: Array<{ type: string; text?: string }>;
      };
      assert.match(status.content[0].text ?? "", /^就绪：vite 在，CDP 在（desktop 端口 47370，pid 7）/);
      assert.match(stderr, /\[kabegame-dev\] 已启动/);
    } catch (error) {
      throw new Error(`${(error as Error).message}\n子进程 stderr：\n${stderr}`);
    } finally {
      await client.close();
      await rest.close();
    }
  });
});
