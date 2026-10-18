import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../state/superState", () => ({ getIsSuper: () => false }));

import { invoke } from "./web";

describe("web RPC", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("把方法名放入请求路径并保留在 JSON-RPC body 中", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(invoke<string>("pathql_fetch", { path: "images://gallery" })).resolves.toBe("ok");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(String(url), "http://localhost").pathname).toBe("/rpc/pathql_fetch");
    expect(JSON.parse(init?.body as string)).toMatchObject({
      method: "pathql_fetch",
      params: { path: "images://gallery" },
    });
  });
});
