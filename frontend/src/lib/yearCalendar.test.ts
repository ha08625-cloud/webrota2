import { describe, expect, it } from "vitest";

import { isInYearMonth, monthName, monthWeeks } from "./yearCalendar";

describe("monthWeeks", () => {
  it("pads the first and last week out to full Mon-Sun rows", () => {
    // August 2026: 1 Aug is a Saturday, 31 Aug is a Monday.
    const weeks = monthWeeks(2026, 8);
    expect(weeks[0]).toEqual(["2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02"]);
    expect(weeks.at(-1)).toEqual(["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06"]);
    for (const week of weeks) {
      expect(week).toHaveLength(7);
    }
  });

  it("starts each row on a Monday", () => {
    for (const week of monthWeeks(2026, 2)) {
      expect(new Date(week[0]).getUTCDay()).toBeDefined();
    }
  });
});

describe("isInYearMonth", () => {
  it("is true only for dates within the given year/month", () => {
    expect(isInYearMonth("2026-08-15", 2026, 8)).toBe(true);
    expect(isInYearMonth("2026-07-31", 2026, 8)).toBe(false);
    expect(isInYearMonth("2026-09-01", 2026, 8)).toBe(false);
  });
});

describe("monthName", () => {
  it("names every month 1-12", () => {
    expect(monthName(1)).toBe("January");
    expect(monthName(8)).toBe("August");
    expect(monthName(12)).toBe("December");
  });
});
