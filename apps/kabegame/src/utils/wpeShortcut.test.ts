import { describe, expect, it } from "vitest";
import { composeWpeShortcut, parseWpeShortcut } from "./wpeShortcut";

describe("parseWpeShortcut", () => {
  it("空值、不是字符串、没有类型、类型不认识都是空的 file", () => {
    for (const value of [undefined, null, 5, "", "no-colon", "bogus:x", "File:x"])
      expect(parseWpeShortcut(value), String(value)).toEqual({ kind: "file", path: "", args: "" });
  });

  it("file 在第一个 | 处拆成路径与参数（路径里的盘符冒号不影响类型，后面的 | 留在参数里）", () => {
    expect(parseWpeShortcut("file:C:\\Windows\\notepad.exe")).toEqual({
      kind: "file",
      path: "C:\\Windows\\notepad.exe",
      args: "",
    });
    expect(parseWpeShortcut("file:C:\\a.exe|-x --y|z")).toEqual({ kind: "file", path: "C:\\a.exe", args: "-x --y|z" });
  });

  it("cmd 整条命令行放在路径里（不拆参数）；directory、web 不拆", () => {
    expect(parseWpeShortcut("cmd:calc /x")).toEqual({ kind: "cmd", path: "calc /x", args: "" });
    expect(parseWpeShortcut("directory:D:\\a|b")).toEqual({ kind: "directory", path: "D:\\a|b", args: "" });
    expect(parseWpeShortcut("web:https://example.com/?a=1|2")).toEqual({
      kind: "web",
      path: "https://example.com/?a=1|2",
      args: "",
    });
  });
});

describe("composeWpeShortcut", () => {
  it("路径为空（含只有空白）是空串，不管类型与参数", () => {
    expect(composeWpeShortcut("file", "", "-x")).toBe("");
    expect(composeWpeShortcut("web", "   ", "")).toBe("");
  });

  it("只有 file 带参数；参数为空不写 |；路径与参数去首尾空白", () => {
    expect(composeWpeShortcut("file", " C:\\a.exe ", " -x ")).toBe("file:C:\\a.exe|-x");
    expect(composeWpeShortcut("file", "C:\\a.exe", "  ")).toBe("file:C:\\a.exe");
    expect(composeWpeShortcut("cmd", "calc /x", "ignored")).toBe("cmd:calc /x");
    expect(composeWpeShortcut("directory", "D:\\x", "ignored")).toBe("directory:D:\\x");
    expect(composeWpeShortcut("web", "www.example.com", "")).toBe("web:www.example.com");
  });

  it("拆了再拼得回原值", () => {
    for (const value of [
      "file:C:\\a.exe|-x",
      "file:C:\\a.exe",
      "directory:D:\\x",
      "web:https://e.com",
      "cmd:calc /x",
    ]) {
      const parts = parseWpeShortcut(value);
      expect(composeWpeShortcut(parts.kind, parts.path, parts.args)).toBe(value);
    }
  });
});
