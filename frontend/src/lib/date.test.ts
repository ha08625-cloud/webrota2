import { describe, expect, it } from "vitest";

import {
  addDays,
  DUTY_PERIOD_ANCHOR,
  formatDate,
  formatPeriodLabel,
  formatWeekLabel,
  getDutyPeriodStart,
  getDutyPeriodStarts,
  getUpcomingMondays,
  isMonday,
  parseLocalDate,
} from "./date";

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
  it("returns the anchor for the anchor itself", () => {
    expect(getDutyPeriodStart(DUTY_PERIOD_ANCHOR)).toBe(DUTY_PERIOD_ANCHOR);
  });

  it("returns the anchor for the last day of its period (anchor + 27 days)", () => {
    expect(getDutyPeriodStart(addDays(DUTY_PERIOD_ANCHOR, 27))).toBe(DUTY_PERIOD_ANCHOR);
  });

  it("returns the next period start for anchor + 28 days, not the anchor", () => {
    const nextStart = addDays(DUTY_PERIOD_ANCHOR, 28);
    expect(getDutyPeriodStart(nextStart)).toBe(nextStart);
  });

  it("returns a negative-index period start for a date before the anchor", () => {
    const before = addDays(DUTY_PERIOD_ANCHOR, -1);
    expect(getDutyPeriodStart(before)).toBe(addDays(DUTY_PERIOD_ANCHOR, -28));
  });

  it("DST guard: correctly places the period spanning the UK clock change", () => {
    // With the 2026-07-20 anchor, period index 3 runs 2026-10-12 to
    // 2026-11-08 and contains the 25 October 2026 UK clock change. A
    // local-millisecond implementation of the period-index calculation
    // is off by one across this boundary; this test exists to catch
    // that regression, not to re-prove already-covered boundary logic.
    expect(getDutyPeriodStart("2026-11-08")).toBe("2026-10-12");
    expect(getDutyPeriodStart("2026-11-09")).toBe("2026-11-09");
  });
});

describe("getDutyPeriodStarts", () => {
  it("returns ascending period starts 28 days apart, centred on the containing period", () => {
    const starts = getDutyPeriodStarts(1, 5, new Date(2026, 7, 5));
    expect(starts).toHaveLength(7);

    const containingStart = getDutyPeriodStart("2026-08-05");
    expect(starts[0]).toBe(addDays(containingStart, -28));
    expect(starts[1]).toBe(containingStart);
    expect(starts[2]).toBe(addDays(containingStart, 28));
    expect(starts[6]).toBe(addDays(containingStart, 5 * 28));

    for (let i = 1; i < starts.length; i++) {
      expect(addDays(starts[i - 1], 28)).toBe(starts[i]);
    }
  });
});

describe("formatPeriodLabel", () => {
  it("formats a period that stays within one year", () => {
    expect(formatPeriodLabel("2026-07-20")).toBe("20 Jul - 16 Aug 2026");
  });

  it("formats a period that crosses a year boundary", () => {
    expect(formatPeriodLabel("2026-12-21")).toBe("21 Dec 2026 - 17 Jan 2027");
  });
});