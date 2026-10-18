import { beforeEach, describe, expect, it, vi } from "vitest";
import { openExternalLink } from "./openExternalLink";

const mocks = vi.hoisted(() => ({
  openUrl: vi.fn<(url: string) => Promise<void>>(),
  resolveSettingWithPrompt: vi.fn(),
  startSession: vi.fn<(url: string) => Promise<void>>(),
}));

vi.mock("@kabegame/i18n", () => ({
  i18n: { global: { t: (key: string) => key } },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("../composables/useSettingChoice", () => ({
  resolveSettingWithPrompt: mocks.resolveSettingWithPrompt,
}));
vi.mock("../env", () => ({ IS_ANDROID: true, IS_WEB: false }));
vi.mock("../stores/surf", () => ({
  useSurfStore: () => ({ startSession: mocks.startSession }),
}));

describe("openExternalLink on Android", () => {
  beforeEach(() => {
    mocks.openUrl.mockReset();
    mocks.resolveSettingWithPrompt.mockReset();
    mocks.startSession.mockReset();
  });

  it("先询问打开方式，选择畅游时启动畅游会话", async () => {
    mocks.resolveSettingWithPrompt.mockResolvedValue("surf");

    await openExternalLink("https://example.com/gallery");

    expect(mocks.resolveSettingWithPrompt).toHaveBeenCalledWith(
      "linkOpenMode",
      expect.objectContaining({
        title: "common.chooseLinkOpenMode",
        options: [expect.objectContaining({ id: "surf" }), expect.objectContaining({ id: "browser" })],
      }),
    );
    expect(mocks.startSession).toHaveBeenCalledWith("https://example.com/gallery");
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it("选择系统浏览器时再跳转外部应用", async () => {
    mocks.resolveSettingWithPrompt.mockResolvedValue("browser");

    await openExternalLink("https://example.com/gallery");

    expect(mocks.startSession).not.toHaveBeenCalled();
    expect(mocks.openUrl).toHaveBeenCalledWith("https://example.com/gallery");
  });
});
