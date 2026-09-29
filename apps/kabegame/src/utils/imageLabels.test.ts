import { describe, expect, it } from "vitest";
import type { Album } from "@/services/albums";
import { escapeSdPrompt, labelKeysText } from "./imageLabels";
import { isLabelKey } from "./labelKey";

describe("isLabelKey", () => {
  it("放开括号与单个内部空格", () => {
    for (const key of ["long hair", "sua (alien stage)", "futaba_akane_(pentagon)", "a-b_c"]) {
      expect(isLabelKey(key), key).toBe(true);
    }
  });

  it("拒绝首尾空格、连续空格与其它符号", () => {
    for (const key of ["", " a", "a ", "a  b", "a,b", "a/b", "a.b", "初音", "a".repeat(65)]) {
      expect(isLabelKey(key), key).toBe(false);
    }
  });
});

describe("labelKeysText", () => {
  it("按 SD 提示词转义括号，空格保留", () => {
    expect(escapeSdPrompt("sua (alien stage)")).toBe("sua \\(alien stage\\)");
    const labels = [
      { labelKey: "futaba_akane_(pentagon)" },
      { labelKey: "long hair" },
      { labelKey: null },
    ] as unknown as Album[];
    expect(labelKeysText(labels)).toBe("futaba_akane_\\(pentagon\\), long hair");
  });
});
