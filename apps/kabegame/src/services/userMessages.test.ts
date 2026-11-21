import { beforeEach, describe, expect, it, vi } from "vitest";

const kame = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));
const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());

vi.mock("@/utils/kameMessage", () => ({ kameMessage: kame }));
vi.mock("@kabegame/i18n", () => ({
  i18n: {
    global: {
      t: (key: string, params: Record<string, unknown>) =>
        Object.keys(params).length ? `${key}|${JSON.stringify(params)}` : key,
    },
  },
}));
vi.mock("@/api/rpc", () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    listeners.set(name, callback);
    return () => listeners.delete(name);
  }),
}));

import { dispose, init, showUserMessage } from "./userMessages";

describe("userMessages", () => {
  beforeEach(() => {
    for (const fn of Object.values(kame)) fn.mockClear();
    dispose();
    listeners.clear();
  });

  it("按级别交给看板娘，键按当前语言翻译并填入参数", () => {
    showUserMessage({ level: "error", key: "gallery.wpeShortcutLaunchFailed", params: { reason: "文件夹不存在" } });
    expect(kame.error).toHaveBeenCalledWith('gallery.wpeShortcutLaunchFailed|{"reason":"文件夹不存在"}');
    showUserMessage({ level: "success", key: "a.b" });
    expect(kame.success).toHaveBeenCalledWith("a.b");
  });

  it("级别不认识时按 info，参数不是对象时按没有参数", () => {
    showUserMessage({ level: "loud" as never, key: "a.b", params: ["x"] });
    expect(kame.info).toHaveBeenCalledWith("a.b");
  });

  it("init 监听 user-message，dispose 取消", async () => {
    await init();
    listeners.get("user-message")?.({ payload: { level: "warning", key: "k" } });
    expect(kame.warning).toHaveBeenCalledWith("k");
    dispose();
    expect(listeners.has("user-message")).toBe(false);
  });
});
