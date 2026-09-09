import { describe, expect, it } from "vitest";

import {
  addDays,
  formatDate,
  formatHolidayRange,
  formatPeriodLabel,
  formatWeekLabel,
  getDutyPeriodStart,
  getDutyPeriodStarts,
  getSurroundingMondays,
  getUpcomingMondays,
  getYearRange,
  isMonday,
  parseLocalDate,
} from "./date";

import { formatDateWithDay } from "./date";

describe("formatDateWithDay", () => {
  it("prepends the short weekday name to the ISO date string", () => {
    // These tests rely on parseLocalDate to safely handle timezones,
    // ensuring "2026-08-03" doesn't shift to Sunday in western timezones.
    expect(formatDateWithDay("2026-08-03")).toBe("Mon, 2026-08-03");
    expect(formatDateWithDay("2026-08-09")).toBe("Sun, 2026-08-09");
  });
});

describe("parseLocalDate", () => {
  it("parses a date-only string as local midnight, not UTC", () => {
    const date = parseLocalDate("2026-07-13");
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(6);
    expect(date.getDate()).toBe(13);
  });
});

describe("isMonday", () => {
  it("returns true for a Monday date", () => {
    expect(isMonday("2026-07-13")).toBe(true);
  });

  it("returns false for a non-Monday date", () => {
    expect(isMonday("2026-07-14")).toBe(false);
  });

  it("returns false for a malformed string", () => {
    expect(isMonday("not-a-date")).toBe(false);
  });
});

describe("formatHolidayRange", () => {
  it("formats a multi-day range with full weekday names and d/m/yy", () => {
    expect(formatHolidayRange("2026-07-21", "2026-08-31")).toBe("Tuesday 21/7/26 – Monday 31/8/26");
  });

  it("returns the single date alone, no dash, when start and end match", () => {
    expect(formatHolidayRange("2026-12-25", "2026-12-25")).toBe("Friday 25/12/26");
  });

  it("crosses a year boundary correctly", () => {
    expect(formatHolidayRange("2026-12-12", "2027-01-04")).toBe("Saturday 12/12/26 – Monday 4/1/27");
  });
});

describe("addDays", () => {
  it("adds days within the same month", () => {
    expect(addDays("2026-07-13", 1)).toBe("2026-07-14");
  });

  it("rolls over a month boundary", () => {
    expect(addDays("2026-07-31", 1)).toBe("2026-08-01");
  });

  it("rolls over a year boundary", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("supports negative offsets", () => {
    expect(addDays("2026-07-13", -1)).toBe("2026-07-12");
  });
});

describe("getUpcomingMondays", () => {
  it("includes today as the first result when today is itself a Monday", () => {
    const mondays = getUpcomingMondays(3, parseLocalDate("2026-07-13"));
    expect(mondays).toEqual(["2026-07-13", "2026-07-20", "2026-07-27"]);
  });

  it("advances forward to the next Monday when today is not a Monday", () => {
    const mondays = getUpcomingMondays(2, parseLocalDate("2026-07-15"));
    expect(mondays).toEqual(["2026-07-20", "2026-07-27"]);
  });

  it("returns exactly `count` results", () => {
    expect(getUpcomingMondays(12, parseLocalDate("2026-07-13"))).toHaveLength(12);
  });
});

describe("getSurroundingMondays", () => {
  it("returns pastCount + futureCount + 1 Mondays, ascending, centred on today's week", () => {
    const mondays = getSurroundingMondays(2, 2, parseLocalDate("2026-07-15"));
    expect(mondays).toEqual([
      "2026-07-06",
      "2026-07-13",
      "2026-07-20",
      "2026-07-27",
      "2026-08-03",
    ]);
  });

  it("anchors on today itself when today is a Monday", () => {
    const mondays = getSurroundingMondays(1, 1, parseLocalDate("2026-07-13"));
    expect(mondays).toEqual(["2026-07-06", "2026-07-13", "2026-07-20"]);
  });
});

describe("formatWeekLabel", () => {
  it("formats a Monday as 'w/c D Mon YYYY'", () => {
    expect(formatWeekLabel("2026-07-13")).toBe("w/c 13 Jul 2026");
  });
});

describe("formatDate", () => {
  it("still formats a date-only string (regression check, unchanged behaviour)", () => {
    expect(formatDate("2026-07-13")).toContain("2026");
  });
});

describe("getDutyPeriodStart", () => {
  it("returns the anchor itself for the anchor date", () => {
    expect(getDutyPeriodStart("2026-07-20")).toBe("2026-07-20");
  });

  it("returns the anchor for the last day of the anchor period (anchor + 27 days)", () => {
    expect(getDutyPeriodStart("2026-08-16")).toBe("2026-07-20");
  });

  it("returns the next period start at anchor + 28 days", () => {
    expect(getDutyPeriodStart("2026-08-17")).toBe("2026-08-17");
  });

  it("returns a period before the anchor for a date preceding it (negative index)", () => {
    expect(getDutyPeriodStart("2026-07-19")).toBe("2026-06-22");
  });

  it("DST guard: correctly resolves the period spanning the 25 October UK clock change", () => {
    // Period starting 2026-10-12 runs to 2026-11-08 inclusive, spanning
    // the October DST change. A local-time-subtraction implementation
    // would misjudge this boundary by a day.
    expect(getDutyPeriodStart("2026-11-08")).toBe("2026-10-12");
    expect(getDutyPeriodStart("2026-11-09")).toBe("2026-11-09");
  });
});

describe("getDutyPeriodStarts", () => {
  it("returns ascending period starts 28 days apart, centred on the period containing `from`", () => {
    const starts = getDutyPeriodStarts(1, 5, new Date(2026, 7, 5));
    expect(starts).toEqual([
      "2026-06-22",
      "2026-07-20",
      "2026-08-17",
      "2026-09-14",
      "2026-10-12",
      "2026-11-09",
      "2026-12-07",
    ]);
  });

  it("returns exactly pastCount + futureCount + 1 results", () => {
    expect(getDutyPeriodStarts(2, 3, new Date(2026, 7, 5))).toHaveLength(6);
  });
});

describe("getYearRange", () => {
  it("returns 1 Jan to 31 Dec of the year containing the date", () => {
    expect(getYearRange("2026-07-13")).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });

  it("uses the year of the date itself at each end of the calendar year", () => {
    expect(getYearRange("2026-01-01")).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(getYearRange("2026-12-31")).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });

  it("does not roll over into the next year", () => {
    expect(getYearRange("2027-01-01")).toEqual({ from: "2027-01-01", to: "2027-12-31" });
  });
});

describe("formatPeriodLabel", () => {
  it("formats a period within the same year", () => {
    expect(formatPeriodLabel("2026-07-20")).toBe("20 Jul - 16 Aug 2026");
  });

  it("formats a period crossing a year boundary", () => {
    expect(formatPeriodLabel("2026-12-21")).toBe("21 Dec 2026 - 17 Jan 2027");
  });
});