import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addColorBucket,
  ColorBucketError,
  colorBucketErrorCode,
  deleteColorBucket,
  normalizeColorBucketRow,
  normalizeColorBucketRows,
  normalizeColorHex,
} from "./colorBuckets";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/api/rpc", () => ({ invoke }));

// 带花括号：钩子返回函数会被当成清理函数，在用例结束后再调一次
beforeEach(() => {
  invoke.mockReset();
});

describe("色桶行", () => {
  it("rgb 补零转出六位小写 hex，用户保存的色桶 key 为 null", () => {
    expect(normalizeColorBucketRow({ rgb: 0xff0000, key: "red", position: 0 })).toEqual({
      rgb: 0xff0000,
      hex: "ff0000",
      key: "red",
      position: 0,
    });
    expect(normalizeColorBucketRow({ rgb: 0, key: "black", position: 9 })?.hex).toBe("000000");
    expect(normalizeColorBucketRow({ rgb: 0x00000a, key: null, position: 12 })).toEqual({
      rgb: 10,
      hex: "00000a",
      key: null,
      position: 12,
    });
    // 数字以字符串给出也认；空 key 当作没有
    expect(normalizeColorBucketRow({ rgb: "3341976", key: "", position: "13" })).toEqual({
      rgb: 0x32fe98,
      hex: "32fe98",
      key: null,
      position: 13,
    });
  });

  it.each([[null], [undefined], ["ff0000"], [""], [-1], [0x1000000], [1.5], [Number.NaN]])(
    "rgb 为 %s 的行丢弃",
    (rgb) => {
      expect(normalizeColorBucketRow({ rgb, key: null, position: 0 })).toBeNull();
    },
  );

  it("整张表丢掉坏行，按 position、rgb 升序", () => {
    const rows = [
      { rgb: 0x32fe98, key: null, position: 12 },
      { rgb: "bad", key: null, position: 1 },
      { rgb: 0xff8000, key: "orange", position: 1 },
      { rgb: 0xff0000, key: "red", position: 0 },
      { rgb: 0x000001, key: null, position: 12 },
    ];
    expect(normalizeColorBucketRows(rows).map((bucket) => bucket.hex)).toEqual([
      "ff0000",
      "ff8000",
      "000001",
      "32fe98",
    ]);
  });
});

describe("normalizeColorHex", () => {
  it.each([
    ["#FF0000", "ff0000"],
    ["ff0000", "ff0000"],
    [" #32Fe98 ", "32fe98"],
    ["#000000", "000000"],
  ])("%s → %s", (input, hex) => {
    expect(normalizeColorHex(input)).toBe(hex);
  });

  it.each([[null], [undefined], [""], ["#fff"], ["#ff00000"], ["rgb(255, 0, 0)"], ["#gg0000"], ["#ff0000ff"]])(
    "%s 不是六位十六进制 → null",
    (input) => {
      expect(normalizeColorHex(input)).toBeNull();
    },
  );
});

describe("错误码", () => {
  it.each([
    ["color-bucket:invalid", "invalid", "common.operationFailed"],
    ["color-bucket:exists", "exists", "gallery.colorBucketExists"],
    ["color-bucket:limit", "limit", "gallery.colorBucketLimit"],
    ["color-bucket:builtin", "builtin", "common.operationFailed"],
    ["color-bucket:not-found", "not-found", "common.operationFailed"],
  ] as const)("%s → %s / %s", (raw, code, messageKey) => {
    expect(colorBucketErrorCode(raw)).toBe(code);
    // 码前后带文字、包在 Error 里同样认得
    expect(colorBucketErrorCode(new Error(`保存失败: ${raw} (rgb=1)`))).toBe(code);
    const error = new ColorBucketError(raw, code);
    expect(error.messageKey).toBe(messageKey);
    expect(error.message).toBe(raw);
  });

  it("认不出的报错没有错误码，提示归到通用的操作失败", () => {
    expect(colorBucketErrorCode("database is locked")).toBeNull();
    expect(colorBucketErrorCode("color-bucket:whatever")).toBeNull();
    expect(colorBucketErrorCode(undefined)).toBeNull();
    expect(new ColorBucketError("database is locked", null).messageKey).toBe("common.operationFailed");
  });
});

describe("写操作", () => {
  it("addColorBucket 把 hex 换成 rgb 整数调用命令，返回保存后的色桶", async () => {
    invoke.mockResolvedValue({ rgb: 0x32fe98, key: null, position: 12 });
    await expect(addColorBucket("32fe98")).resolves.toEqual({ rgb: 0x32fe98, hex: "32fe98", key: null, position: 12 });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("add_color_bucket", { rgb: 0x32fe98 });

    // 黑色：rgb 是 0，不能被当成「没有」
    invoke.mockReset().mockResolvedValue({ rgb: 0, key: null, position: 13 });
    await expect(addColorBucket("000000")).resolves.toMatchObject({ rgb: 0, hex: "000000" });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("add_color_bucket", { rgb: 0 });
  });

  it("addColorBucket 失败抛带错误码的 ColorBucketError", async () => {
    invoke.mockRejectedValue("color-bucket:limit");
    const error = await addColorBucket("32fe98").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ColorBucketError);
    expect((error as ColorBucketError).code).toBe("limit");
    expect((error as ColorBucketError).messageKey).toBe("gallery.colorBucketLimit");

    invoke.mockRejectedValue(new Error("boom"));
    const unknown = await addColorBucket("32fe98").catch((e: unknown) => e);
    expect((unknown as ColorBucketError).code).toBeNull();
    expect((unknown as ColorBucketError).message).toBe("boom");
  });

  it.each(["FF0000", "#ff0000", "ff00", ""])("颜色写法不对（%s）直接报 invalid，不调用命令", async (hex) => {
    const added = await addColorBucket(hex).catch((e: unknown) => e);
    const deleted = await deleteColorBucket(hex).catch((e: unknown) => e);
    expect((added as ColorBucketError).code).toBe("invalid");
    expect((deleted as ColorBucketError).code).toBe("invalid");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("deleteColorBucket 调用命令；色桶已经不在了当作删除成功，其它失败照抛", async () => {
    invoke.mockResolvedValue(null);
    await expect(deleteColorBucket("32fe98")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("delete_color_bucket", { rgb: 0x32fe98 });

    invoke.mockRejectedValue("color-bucket:not-found");
    await expect(deleteColorBucket("32fe98")).resolves.toBeUndefined();

    invoke.mockRejectedValue("color-bucket:builtin");
    const error = await deleteColorBucket("ff0000").catch((e: unknown) => e);
    expect((error as ColorBucketError).code).toBe("builtin");
  });
});
