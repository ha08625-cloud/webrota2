import { describe, expect, it } from "vitest";

import { rotaDate } from "./weekDates";

describe("rotaDate", () => {
  it("maps week 1 Monday to the rota's start_date itself", () => {
    expect(rotaDate("2026-01-05", 1, "Monday")).toBe("2026-01-05");
  });

  it("maps week 1 Friday to start_date + 4 days", () => {
    expect(rotaDate("2026-01-05", 1, "Friday")).toBe("2026-01-09");
  });

  it("advances a full week per generation week", () => {
    expect(rotaDate("2026-01-05", 2, "Monday")).toBe("2026-01-12");
    expect(rotaDate("2026-01-05", 2, "Friday")).toBe("2026-01-16");
  });

  it("matches the backend's week_map.build_week_dates for a 4-week run", () => {
    // Mirrors test_week_map.py's TestBuildWeekDates.test_four_weeks_full_coverage.
    expect(rotaDate("2026-01-05", 4, "Friday")).toBe("2026-01-30");
  });
});