import { describe, expect, it } from "vitest";

import { addDays, formatDate, formatWeekLabel, getUpcomingMondays, isMonday, parseLocalDate } from "./date";

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