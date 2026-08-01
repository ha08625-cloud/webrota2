import { describe, expect, it } from "vitest";

import { RECEPTION_HOURS, formatHour } from "./receptionHours";

describe("RECEPTION_HOURS", () => {
  it("is the twenty half-hourly slots from 8am to 6pm", () => {
    expect(RECEPTION_HOURS).toEqual([
      8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16, 16.5, 17, 17.5,
    ]);
  });
});

describe("formatHour", () => {
  it("formats a whole hour with zero-padding on both ends", () => {
    expect(formatHour(8)).toBe("08:00-08:30");
    expect(formatHour(9)).toBe("09:00-09:30");
  });

  it("formats a half hour", () => {
    expect(formatHour(9.5)).toBe("09:30-10:00");
  });

  it("formats a double-digit hour", () => {
    expect(formatHour(13)).toBe("13:00-13:30");
  });

  it("formats the last slot, rolling the end hour into double digits", () => {
    expect(formatHour(17.5)).toBe("17:30-18:00");
  });
});
