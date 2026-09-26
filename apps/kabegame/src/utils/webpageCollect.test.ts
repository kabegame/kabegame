import { describe, expect, it } from "vitest";
import { canOpenTaskWebview, validateWebpageUrl } from "./webpageCollect";

describe("validateWebpageUrl", () => {
  it("accepts absolute http(s) and trims whitespace, keeping path/query/fragment", () => {
    expect(validateWebpageUrl("  https://example.com/a?b=1#c ")).toEqual({
      ok: true,
      url: "https://example.com/a?b=1#c",
    });
    expect(validateWebpageUrl("http://example.com")).toEqual({ ok: true, url: "http://example.com" });
  });

  it("rejects empty, relative, non-http and credential URLs", () => {
    expect(validateWebpageUrl("   ")).toEqual({ ok: false, error: "empty" });
    expect(validateWebpageUrl("example.com/a")).toEqual({ ok: false, error: "invalid" });
    for (const raw of ["ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "blob:https://a.com/x"]) {
      expect(validateWebpageUrl(raw)).toEqual({ ok: false, error: "scheme" });
    }
    expect(validateWebpageUrl("https://user:pw@example.com/")).toEqual({ ok: false, error: "credentials" });
    expect(validateWebpageUrl("https://user@example.com/")).toEqual({ ok: false, error: "credentials" });
  });
});

describe("canOpenTaskWebview", () => {
  const plugins = [
    { id: "js-plugin", scriptType: "js" },
    { id: "v8-plugin", scriptType: "v8" },
    { id: "webpage", scriptType: "builtin" },
  ];

  it("keeps the static rule for ordinary plugins", () => {
    expect(canOpenTaskWebview({ pluginId: "js-plugin", status: "running" }, plugins)).toBe(true);
    expect(canOpenTaskWebview({ pluginId: "js-plugin", status: "waiting_downloads" }, plugins)).toBe(true);
    expect(canOpenTaskWebview({ pluginId: "v8-plugin", status: "running" }, plugins)).toBe(false);
  });

  it("uses the per-task backend for webpage tasks", () => {
    const webview = { pluginId: "webpage", userConfig: { backend: "webview" } };
    expect(canOpenTaskWebview({ ...webview, status: "running" }, plugins)).toBe(true);
    expect(canOpenTaskWebview({ ...webview, status: "waiting_downloads" }, plugins)).toBe(true);
    expect(canOpenTaskWebview({ pluginId: "webpage", status: "running", userConfig: { backend: "v8" } }, plugins)).toBe(false);
    expect(canOpenTaskWebview({ pluginId: "webpage", status: "running", userConfig: {} }, plugins)).toBe(false);
    expect(canOpenTaskWebview({ pluginId: "webpage", status: "running", userConfig: null }, plugins)).toBe(false);
  });

  it("never shows for pending or terminal tasks", () => {
    for (const status of ["pending", "completed", "failed", "canceled"]) {
      expect(canOpenTaskWebview({ pluginId: "js-plugin", status }, plugins)).toBe(false);
      expect(canOpenTaskWebview({ pluginId: "webpage", status, userConfig: { backend: "webview" } }, plugins)).toBe(false);
    }
  });
});
