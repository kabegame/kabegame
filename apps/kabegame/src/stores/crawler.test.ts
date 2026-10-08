import { describe, expect, it } from "vitest";
import { normalizeDiffKeys } from "./crawler";

describe("normalizeDiffKeys", () => {
  it("保留 maxConcurrentDownloads 的显式 null", () => {
    expect(normalizeDiffKeys({ maxConcurrentDownloads: null })).toEqual({
      maxConcurrentDownloads: null,
    });
  });
});
