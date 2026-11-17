import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirmWpeForceRender } from "./wpeForceRender";

const box = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock("@/components/ui/messageBox", () => ({ messageBox: { confirm: box.confirm } }));
vi.mock("@kabegame/i18n", () => ({ i18n: { global: { t: (key: string) => key } } }));

beforeEach(() => box.confirm.mockReset());

describe("confirmWpeForceRender", () => {
  it("警告样式的确认框：点确定返回 true，取消或关掉返回 false", async () => {
    box.confirm.mockResolvedValueOnce("confirm");
    await expect(confirmWpeForceRender()).resolves.toBe(true);
    expect(box.confirm).toHaveBeenCalledWith(
      "settings.wpeSceneForceRenderConfirm",
      "settings.wpeSceneForceRenderConfirmTitle",
      expect.objectContaining({
        confirmButtonText: "settings.wpeSceneForceRenderConfirmOk",
        type: "warning",
        danger: true,
      }),
    );
    box.confirm.mockRejectedValueOnce("cancel");
    await expect(confirmWpeForceRender()).resolves.toBe(false);
    box.confirm.mockRejectedValueOnce("close");
    await expect(confirmWpeForceRender()).resolves.toBe(false);
  });
});
