/**
 * 协议层单测：用 SDK 的 Client + InMemoryTransport 连 `createDevMcpServer`，背后是假的 REST（或没人监听的端口）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "./client.ts";
import { createDevMcpServer } from "./main.ts";
import type { DevMcpDeps } from "./tools.ts";
import { Client, InMemoryTransport } from "./testdata/sdkClient.ts";
import { PNG, SESSION, TOOLS, fakeRest, sendJson } from "./testdata/fakeRest.ts";
import type { Handler } from "./testdata/fakeRest.ts";
import { deadPort } from "../../../scripts/kabegame-dev/testdata/fakes.ts";
import { encodePng, pngSize } from "../../../scripts/kabegame-dev/png.ts";
import { Buffer } from "node:buffer";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
};

async function connect(port: number) {
  const root = mkdtempSync(path.join(os.tmpdir(), "kbdev-mcp-"));
  const deps: DevMcpDeps = {
    client: createClient({ port }),
    root,
    logDir: path.join(root, "logs"),
    log: () => {},
  };
  const server = createDevMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "kbdev-test", version: "0" });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}, options = {}) =>
    (await client.callTool({ name, arguments: args }, undefined, options)) as ToolResult;
  return {
    client,
    call,
    root,
    deps,
    close: async () => {
      await client.close();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const textOf = (result: ToolResult) =>
  result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

const imageOf = (result: ToolResult) => {
  const image = result.content.find((c) => c.type === "image");
  return image?.data ? new Uint8Array(Buffer.from(image.data, "base64")) : null;
};

/** 不透明 RGBA 渐变。 */
function bigPng(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([i & 255, (i >> 8) & 255, (i * 7) & 255, 255], i * 4);
  return encodePng({ width, height, channels: 4, data });
}

async function withRest(handler: Handler, run: (mcp: Awaited<ReturnType<typeof connect>>) => Promise<void>) {
  const rest = await fakeRest(handler);
  const mcp = await connect(rest.port);
  try {
    await run(mcp);
  } finally {
    await mcp.close();
    await rest.close();
  }
}

describe("vite 不在", () => {
  test("工具照常列出（静态表），调用报 [vite]；status 报第 1 层；不需要 vite 的工具照常可用", async () => {
    const mcp = await connect(await deadPort());
    try {
      const { tools } = await mcp.client.listTools();
      assert.deepEqual(
        tools.map((t: { name: string }) => t.name),
        TOOLS,
      );
      for (const name of ["targets", "app_state", "hosts"]) {
        const result = await mcp.call(name);
        assert.equal(result.isError, true, name);
        assert.match(textOf(result), /^\[vite\] 第 1 层：vite 不在/, name);
        assert.match(textOf(result), /deno task dev -c kabegame/);
      }
      const shot = await mcp.call("screenshot", { clip: { x: 0, y: 0, width: 10, height: 10 } });
      assert.match(textOf(shot), /^\[vite\]/);

      const status = await mcp.call("status");
      assert.notEqual(status.isError, true);
      assert.match(textOf(status), /^第 1 层：vite 不在/);
      assert.match(textOf(status), /第 2 层 CDP：未知/);
      assert.match(textOf(status), /不代起/);

      // 不需要 vite
      const mark = await mcp.call("app_log", { action: "mark" });
      assert.match(textOf(mark), /^标记：\d{4}-\d{2}-\d{2}@0/);
      const job = await mcp.call("job");
      assert.match(textOf(job), /^\[vite\]/);
    } finally {
      await mcp.close();
    }
  });

  test("资源：列表与模板都在；health 可读，targets 读不了时报层级", async () => {
    const mcp = await connect(await deadPort());
    try {
      const { resources } = await mcp.client.listResources();
      assert.deepEqual(
        resources.map((r: { uri: string }) => r.uri),
        ["kabegame-dev://health", "kabegame-dev://targets", "kabegame-dev://jobs"],
      );
      const { resourceTemplates } = await mcp.client.listResourceTemplates();
      assert.deepEqual(
        resourceTemplates.map((r: { uriTemplate: string }) => r.uriTemplate),
        ["kabegame-dev://jobs/{id}", "kabegame-dev://app-log/{date}"],
      );
      const health = await mcp.client.readResource({ uri: "kabegame-dev://health" });
      const report = JSON.parse((health.contents[0] as { text: string }).text);
      assert.equal(report.vite.ok, false);
      assert.equal(report.cdp, null);
      await assert.rejects(mcp.client.readResource({ uri: "kabegame-dev://targets" }), /\[vite\]/);
    } finally {
      await mcp.close();
    }
  });
});

describe("status 两层结论", () => {
  test("vite 在、CDP 不在：报第 2 层与端点层、可能原因与提示；调用报 [cdp]", async () => {
    const endpoint = { layer: "registration", error: "vite 上没有 CDP 端口登记", hint: "app 还在编译" };
    await withRest(
      (req, _body, res) => {
        if (req.url?.endsWith("/health")) {
          return sendJson(res, 200, {
            vite: true,
            android: false,
            cdp: endpoint,
            session: { ...SESSION, connected: false },
          });
        }
        sendJson(res, 503, { error: `CDP 不可用：${endpoint.error}`, layer: "cdp", endpoint });
      },
      async (mcp) => {
        const text = textOf(await mcp.call("status"));
        assert.match(text, /^第 2 层：vite 在，CDP 不在（registration：vite 上没有 CDP 端口登记）/);
        assert.match(text, /第 1 层 vite（http:\/\/127\.0\.0\.1:\d+）：在/);
        assert.match(text, /提示：app 还在编译/);
        assert.match(text, /vite 刚热重载重启/);
        const targets = await mcp.call("targets");
        assert.equal(targets.isError, true);
        assert.match(textOf(targets), /^\[cdp\] 第 2 层：vite 在，CDP 不在/);
        assert.match(textOf(targets), /提示：app 还在编译/);
      },
    );
  });

  test("安卓 CDP 不在：可能原因换成设备 / app / socket", async () => {
    const endpoint = { layer: "device", error: "adb 没有可用设备" };
    await withRest(
      (_req, _body, res) => sendJson(res, 200, { vite: true, android: true, cdp: endpoint, session: SESSION }),
      async (mcp) => {
        const text = textOf(await mcp.call("status"));
        assert.match(text, /CDP 不在（device/);
        assert.match(text, /没有设备/);
        assert.match(text, /没有调试 socket/);
      },
    );
  });

  test("两层都在：就绪，带端点与会话摘要", async () => {
    await withRest(
      (_req, _body, res) =>
        sendJson(res, 200, {
          vite: true,
          android: false,
          cdp: { kind: "desktop", port: 47370, webSocketUrl: "ws://x", pid: 42, browser: "Chrome/1" },
          session: SESSION,
        }),
      async (mcp) => {
        const text = textOf(await mcp.call("status"));
        assert.match(text, /^就绪：vite 在，CDP 在（desktop 端口 47370，pid 42）/);
        assert.match(text, /第 2 层 CDP：在（desktop，端口 47370，Chrome\/1）/);
        assert.match(text, /vite 会话：已连/);
      },
    );
  });

  test("vite 在但没有插件（SPA 兜底回 HTML）：第 1 层，提示重启 dev", async () => {
    await withRest(
      (_req, _body, res) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<!doctype html>");
      },
      async (mcp) => {
        const text = textOf(await mcp.call("status"));
        assert.match(text, /^第 1 层：vite 在，但没有 kabegame-dev 插件/);
      },
    );
  });
});

describe("一对一工具", () => {
  test("截图：参数原样转给 REST，回 image content，可落盘；clip 与 selector 互斥", async () => {
    await withRest(
      (req, _body, res) => {
        if (req.url?.endsWith("/screenshot")) {
          res.writeHead(200, { "Content-Type": "image/png" });
          return res.end(PNG);
        }
        sendJson(res, 404, { error: "x", layer: "rest" });
      },
      async (mcp) => {
        const clip = { x: 1, y: 2, width: 30, height: 40, scale: 2 };
        const result = await mcp.call("screenshot", { clip, save: "out/shot.png" });
        assert.notEqual(result.isError, true, textOf(result));
        assert.match(textOf(result), /原尺寸 1×1/);
        assert.match(textOf(result), /回传：原尺寸/);
        const image = result.content.find((c) => c.type === "image");
        assert.equal(image?.mimeType, "image/png");
        assert.deepEqual(
          Uint8Array.from(atob(image!.data!), (c) => c.charCodeAt(0)),
          PNG,
        );
        assert.deepEqual(new Uint8Array(readFileSync(path.join(mcp.root, "out/shot.png"))), PNG);
        const both = await mcp.call("screenshot", { clip, selector: ".a" });
        assert.match(textOf(both), /^\[local\]/);
      },
    );
  });

  test("截图缩小与落盘：缺省长边 1568、size 取最严、save temp 落原图；REST 收到的不带 size", async () => {
    const big = bigPng(2400, 300);
    const rest = await fakeRest((req, _body, res) => {
      if (req.url?.endsWith("/screenshot")) {
        res.writeHead(200, { "Content-Type": "image/png" });
        return res.end(big);
      }
      sendJson(res, 404, { error: "x", layer: "rest" });
    });
    const mcp = await connect(rest.port);
    const saved: string[] = [];
    try {
      const plain = await mcp.call("screenshot", {});
      assert.match(textOf(plain), /原尺寸 2400×300/);
      assert.match(textOf(plain), /回传：1568×196（已缩小/);
      assert.deepEqual(pngSize(imageOf(plain)!), { width: 1568, height: 196 });

      const small = await mcp.call("screenshot", { size: { maxWidth: 400 }, save: "temp" });
      assert.notEqual(small.isError, true, textOf(small));
      assert.deepEqual(pngSize(imageOf(small)!), { width: 400, height: 50 });
      const file = /原图已保存：(.+)$/m.exec(textOf(small))![1];
      saved.push(file);
      assert.match(path.basename(file), /^screenshot-\d{8}-\d{6}-\d{3}\.png$/);
      assert.deepEqual(new Uint8Array(readFileSync(file)), big, "落盘的是原图");

      const bad = await mcp.call("screenshot", { size: { maxWidth: 0 } });
      assert.equal(bad.isError, true);
      assert.deepEqual(
        rest.seen.map((r) => r.body),
        [{ target: "main" }, { target: "main" }],
        "size / save 不发给 REST（缩小在 MCP 里做）",
      );
    } finally {
      for (const file of saved) rmSync(file, { force: true });
      await mcp.close();
      await rest.close();
    }
  });

  test("show_window 与 open_image_preview：参数原样转给 REST，结果有路径、前后状态与预览", async () => {
    const front = { visibilityState: "visible", hasFocus: true, minimized: false, visible: true };
    const shown = {
      front: true,
      path: "always-on-top",
      before: { ...front, visibilityState: "hidden", hasFocus: false },
      after: front,
      steps: ["plugin:window|set_focus：ok"],
    };
    const preview = {
      open: true,
      imageId: "13515",
      resolved: true,
      mode: "single",
      inView: false,
      page: 1,
      pageSize: 1000,
    };
    await withRest(
      (req, _body, res) => {
        if (req.url?.endsWith("/app/show-window")) return sendJson(res, 200, shown);
        if (req.url?.endsWith("/app/open-preview")) {
          return sendJson(res, 200, {
            imageId: "13515",
            before: { route: "/gallery", preview: { ...preview, open: false, imageId: null, mode: null } },
            route: "/gallery?pvwimgid=13515",
            preview,
            window: shown,
            ms: 4200,
          });
        }
        sendJson(res, 404, { error: "x", layer: "rest" });
      },
      async (mcp) => {
        const show = await mcp.call("show_window");
        assert.notEqual(show.isError, true, textOf(show));
        assert.match(textOf(show), /^主窗口已到前台（路径 always-on-top/);
        assert.match(textOf(show), /之前：visibilityState hidden，hasFocus false/);
        assert.match(textOf(show), /之后：visibilityState visible，hasFocus true/);

        const open = await mcp.call("open_image_preview", { imageId: 13515, timeoutMs: 9000 });
        assert.notEqual(open.isError, true, textOf(open));
        assert.match(
          textOf(open),
          /^预览：开着 13515（不在当前视图里，降级成单图预览）；路由 \/gallery\?pvwimgid=13515；用时 4\.2 s/,
        );
        assert.match(textOf(open), /之前：路由 \/gallery，预览没开/);
        assert.match(textOf(open), /主窗口已到前台/);
        const bad = await mcp.call("open_image_preview", { imageId: "abc" });
        assert.equal(bad.isError, true);
      },
    );
  });

  test("host_render：缺省缩小回传，save 落原图（自动命名带图片 id），元数据在文本里", async () => {
    const big = bigPng(1800, 900);
    const meta = { width: 1800, height: 900, sha256: "pix", format: "rgba8unorm" };
    const saved: string[] = [];
    await withRest(
      (_req, body, res) =>
        sendJson(res, 200, {
          meta: { ...meta, echo: body },
          png: Buffer.from(big).toString("base64"),
          pngSha256: "file",
          pngBytes: big.length,
        }),
      async (mcp) => {
        const result = await mcp.call("host_render", {
          handle: "h-1",
          imageId: "42",
          save: "temp",
          size: { scale: 0.1 },
        });
        assert.notEqual(result.isError, true, textOf(result));
        assert.deepEqual(pngSize(imageOf(result)!), { width: 180, height: 90 });
        const file = /原图已保存：(.+)$/m.exec(textOf(result))![1];
        saved.push(file);
        assert.match(path.basename(file), /^host_render-42-/);
        assert.deepEqual(new Uint8Array(readFileSync(file)), big);
        assert.match(textOf(result), /像素摘要（RGBA）pix，原图 PNG 文件 sha256 file/);
        assert.match(textOf(result), /"format": "rgba8unorm"/);
        assert.match(textOf(result), /原尺寸 1800×900/);
      },
    );
    for (const file of saved) rmSync(file, { force: true });
  });

  test("REST 回的层原样带出（句柄 404）", async () => {
    await withRest(
      (_req, _body, res) =>
        sendJson(res, 404, { error: "宿主句柄 h-1 不存在：vite 重启过", layer: "handle", id: "h-1" }),
      async (mcp) => {
        const result = await mcp.call("host_close", { handle: "h-1" });
        assert.equal(result.isError, true);
        assert.match(textOf(result), /^\[handle\] 句柄/);
        assert.match(textOf(result), /"id": "h-1"/);
      },
    );
  });
});

describe("封装工具", () => {
  const BASELINE = {
    recordedAt: "2026-11-08T00:00:00Z",
    time: 1.5,
    levels: ["disabled"],
    hostBuild: { entry: "index-A.js", frameVisibility: "visible", corpusHead: "" },
    scenes: {
      "7": {
        input: { path: "D:\\p\\a", sceneAssets: [], metadataId: 1, userProperties: {}, projectFiles: {} },
        levels: { disabled: { stable: true, sha256: "s", unsupported: [], width: 1, height: 1, format: "f" } },
      },
    },
    closed: { before: {}, after: {}, previewHostsLeft: 0 },
  };

  test("hash_baseline：起任务、等完成、报 MCP 进度、写 out；out 已存在时拒绝", async () => {
    let polls = 0;
    await withRest(
      (req, body, res) => {
        if (req.method === "POST" && req.url?.endsWith("/jobs")) {
          assert.equal((body as { kind: string }).kind, "hash-baseline");
          return sendJson(res, 200, { id: "j-1", kind: "hash-baseline", status: "running", progress: null });
        }
        polls++;
        const done = polls >= 3;
        sendJson(res, 200, {
          id: "j-1",
          kind: "hash-baseline",
          status: done ? "done" : "running",
          progress: { done: Math.min(polls, 1), total: 1, current: "7 disabled" },
          result: done ? { ok: true, unstable: null, baseline: BASELINE } : undefined,
        });
      },
      async (mcp) => {
        const progress: Array<{ progress: number; total?: number }> = [];
        const result = await mcp.call(
          "hash_baseline",
          { ids: ["7"], out: "b/hash.json" },
          { onprogress: (p: { progress: number; total?: number }) => progress.push(p) },
        );
        assert.notEqual(result.isError, true, textOf(result));
        assert.match(textOf(result), /^完成：1 张场景、1 组/);
        const written = JSON.parse(readFileSync(path.join(mcp.root, "b/hash.json"), "utf8"));
        assert.deepEqual(written, BASELINE);
        assert.ok(progress.length >= 1, JSON.stringify(progress));
        for (let i = 1; i < progress.length; i++) assert.ok(progress[i].progress > progress[i - 1].progress);
        const again = await mcp.call("hash_baseline", { ids: ["7"], out: "b/hash.json" });
        assert.match(textOf(again), /^\[local\].*\n.*已存在/);
        const both = await mcp.call("hash_baseline", { ids: ["7"], from: "x.json", out: "b/other.json" });
        assert.match(textOf(both), /ids 与 from 给且只给一个/);
      },
    );
  });

  test("projects_import：清单写进 out；任务失败报 [job]", async () => {
    let fail = false;
    await withRest(
      (req, _body, res) => {
        if (req.method === "POST") return sendJson(res, 200, { id: "j-2", kind: "projects-import", status: "running" });
        sendJson(res, 200, {
          id: "j-2",
          kind: "projects-import",
          status: fail ? "failed" : "done",
          error: fail ? "导入超时" : undefined,
          result: fail ? undefined : { "D:\\r\\ignore\\x": { image: "9", task: "t", preexisting: false } },
        });
      },
      async (mcp) => {
        const ok = await mcp.call("projects_import", { dirs: ["ignore/x"], out: "m.json" });
        assert.match(textOf(ok), /^完成：导入 1 个工程/);
        assert.equal(JSON.parse(readFileSync(path.join(mcp.root, "m.json"), "utf8"))["D:\\r\\ignore\\x"].image, "9");
        fail = true;
        const bad = await mcp.call("projects_import", { dirs: ["ignore/x"], out: "m2.json" });
        assert.match(textOf(bad), /^\[job\] 任务没有成功结束\n任务 j-2（projects-import）failed：导入超时/);
        assert.equal(existsSync(path.join(mcp.root, "m2.json")), false);
      },
    );
  });

  test("hash_compare 与 app_log 不需要 vite", async () => {
    const mcp = await connect(await deadPort());
    try {
      writeFileSync(path.join(mcp.root, "a.json"), JSON.stringify(BASELINE));
      writeFileSync(
        path.join(mcp.root, "b.json"),
        JSON.stringify({ ok: true, baseline: { ...BASELINE, scenes: { "99": BASELINE.scenes["7"] } } }),
      );
      const compare = await mcp.call("hash_compare", { a: "a.json", b: "b.json" });
      assert.match(textOf(compare), /^相同：1 张场景、1 组/);

      const logs = mcp.deps.logDir;
      const { mkdirSync } = await import("node:fs");
      mkdirSync(logs, { recursive: true });
      writeFileSync(path.join(logs, "kabegame.2026-11-07.log"), "2026-11-07 23:59:59.000  INFO a: 前一天\n");
      const mark = await mcp.call("app_log", { action: "since", mark: "2026-11-07@0" });
      assert.match(textOf(mark), /前一天/);
      writeFileSync(path.join(logs, "kabegame.2026-11-08.log"), "2026-11-08 00:00:01.000  WARN a: 第二天\n");
      const next = /下一次 since 用：(\S+)/.exec(textOf(mark))![1];
      const since = await mcp.call("app_log", { action: "since", mark: next, level: "warn" });
      assert.match(textOf(since), /1 条，匹配 1 条/);
      assert.match(textOf(since), /第二天/);
      assert.doesNotMatch(textOf(since), /前一天/);
      const resource = await mcp.client.readResource({ uri: "kabegame-dev://app-log/2026-11-08" });
      assert.match((resource.contents[0] as { text: string }).text, /第二天/);
      const { resources } = await mcp.client.listResources();
      assert.ok(resources.some((r: { uri: string }) => r.uri === "kabegame-dev://app-log/2026-11-07"));
    } finally {
      await mcp.close();
    }
  });
});
