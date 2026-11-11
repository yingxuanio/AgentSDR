import { describe, expect, test } from "bun:test";
import { isWithinWorkingHours, nextWorkingWindowStart } from "./workingHours";
import type { WorkingHours } from "./schema";

const standardHours: WorkingHours = {
  timezone: "Asia/Shanghai",
  days: {
    sunday: { enabled: false, from: "09:30", to: "18:30" },
    monday: { enabled: true, from: "09:30", to: "18:30" },
    tuesday: { enabled: true, from: "09:30", to: "18:30" },
    wednesday: { enabled: true, from: "09:30", to: "18:30" },
    thursday: { enabled: true, from: "09:30", to: "18:30" },
    friday: { enabled: true, from: "09:30", to: "18:30" },
    saturday: { enabled: false, from: "09:30", to: "18:30" },
  },
};

describe("workingHours", () => {
  test("isWithinWorkingHours detects inside window", () => {
    // 2026-11-11 is Wednesday. 14:00 Asia/Shanghai = 06:00 UTC
    const inside = new Date("2026-11-11T06:00:00.000Z");
    expect(isWithinWorkingHours(standardHours, inside)).toBe(true);
  });

  test("isWithinWorkingHours detects outside window (night)", () => {
    // 2026-11-11 23:00 Asia/Shanghai = 15:00 UTC
    const night = new Date("2026-11-11T15:00:00.000Z");
    expect(isWithinWorkingHours(standardHours, night)).toBe(false);
  });

  test("isWithinWorkingHours detects weekend disabled", () => {
    // 2026-11-14 is Saturday 14:00 Asia/Shanghai = 06:00 UTC
    const sat = new Date("2026-11-14T06:00:00.000Z");
    expect(isWithinWorkingHours(standardHours, sat)).toBe(false);
  });

  test("nextWorkingWindowStart returns now if already inside", () => {
    const inside = new Date("2026-11-11T06:00:00.000Z");
    expect(nextWorkingWindowStart(standardHours, inside)).toEqual(inside);
  });

  test("nextWorkingWindowStart finds next morning from night", () => {
    // Wednesday 23:00 Asia/Shanghai (15:00 UTC) -> Thursday 09:30 Asia/Shanghai (01:30 UTC)
    const wedNight = new Date("2026-11-11T15:00:00.000Z");
    const nextStart = nextWorkingWindowStart(standardHours, wedNight);
    expect(nextStart.toISOString()).toBe("2026-11-12T01:30:00.000Z");
  });

  test("nextWorkingWindowStart skips weekend from Friday night", () => {
    // Friday 20:00 Asia/Shanghai (2026-11-13 12:00 UTC) -> Monday 09:30 Asia/Shanghai (2026-11-16 01:30 UTC)
    const friNight = new Date("2026-11-13T12:00:00.000Z");
    const nextStart = nextWorkingWindowStart(standardHours, friNight);
    expect(nextStart.toISOString()).toBe("2026-11-16T01:30:00.000Z");
  });

  test("nextWorkingWindowStart finds today morning if called early morning", () => {
    // Wednesday 07:00 Asia/Shanghai (2026-11-10 23:00 UTC) -> Wednesday 09:30 Asia/Shanghai (2026-11-11 01:30 UTC)
    const wedEarly = new Date("2026-11-10T23:00:00.000Z");
    const nextStart = nextWorkingWindowStart(standardHours, wedEarly);
    expect(nextStart.toISOString()).toBe("2026-11-11T01:30:00.000Z");
  });
});
