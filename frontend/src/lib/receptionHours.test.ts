import { describe, expect, it } from "vitest";

import { RECEPTION_HOURS, formatHour } from "./receptionHours";

describe("RECEPTION_HOURS", () => {
  it("is the ten hourly slots from 8am to 5pm", () => {
    expect(RECEPTION_HOURS).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });
});

describe("formatHour", () => {
  it("formats a single-digit hour with zero-padding on both ends", () => {
    expect(formatHour(8)).toBe("08:00-09:00");
    expect(formatHour(9)).toBe("09:00-10:00");
  });

  it("formats a double-digit hour", () => {
    expect(formatHour(13)).toBe("13:00-14:00");
  });

  it("formats the last slot, rolling the end hour into double digits", () => {
    expect(formatHour(17)).toBe("17:00-18:00");
  });
});
