import { describe, expect, it } from "vitest";
import { previewNextRuns, specText } from "./scheduleText";

const t = (key: string, params?: Record<string, unknown>) => `${key}${params ? `:${JSON.stringify(params)}` : ""}`;

describe("scheduleText", () => {
  it("formats hourly and multi-weekday schedules", () => {
    expect(specText({ mode: "hourly", minute: 30 }, t)).toContain('"minute":"30"');
    const weekly = specText({ mode: "weekly", weekdays: [0, 2, 4], hour: 8, minute: 5 }, t);
    expect(weekly).toContain("autoConfig.weekday0");
    expect(weekly).toContain("autoConfig.weekday2");
    expect(weekly).toContain("autoConfig.weekday4");
  });

  it("previews hourly runs without using the persisted planned time", () => {
    const now = new Date("2026-10-20T08:10:15");
    const runs = previewNextRuns({ mode: "hourly", minute: 30 }, 3, now).map((value) => new Date(value));
    expect(runs.map((value) => [value.getHours(), value.getMinutes()])).toEqual([
      [8, 30],
      [9, 30],
      [10, 30],
    ]);
  });

  it("previews only selected weekdays", () => {
    const monday = new Date("2026-10-19T09:00:00");
    const runs = previewNextRuns({ mode: "weekly", weekdays: [0, 2, 4], hour: 8, minute: 0 }, 3, monday);
    expect(runs.map((value) => new Date(value).getDay())).toEqual([3, 5, 1]);
  });
});
