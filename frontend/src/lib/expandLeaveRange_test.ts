import { describe, expect, it } from "vitest";

import {
  expandLeaveRange,
  segmentsToSessionKeys,
  singleDayToEdges,
} from "./expandLeaveRange";
import type { LeaveSegment } from "./expandLeaveRange";

/**
 * Asserts the disjointness property directly: expanding every segment
 * into individual sessions must never cover the same (date, period)
 * twice. segmentsToSessionKeys deduplicates via Set, so the check
 * compares the set size against the raw session count.
 */
function expectDisjoint(segments: LeaveSegment[]) {
  let rawCount = 0;
  for (const segment of segments) {
    const singles = segmentsToSessionKeys([segment]);
    rawCount += singles.size;
  }
  expect(segmentsToSessionKeys(segments).size).toBe(rawCount);
}

describe("expandLeaveRange", () => {
  it("full/full multi-day collapses to one BOTH segment", () => {
    const segments = expandLeaveRange("2026-07-13", "2026-07-17", "FULL", "FULL");
    expect(segments).toEqual([{ start_date: "2026-07-13", end_date: "2026-07-17", period: "BOTH" }]);
  });

  it("PM-only first day emits a PM edge before the interior", () => {
    const segments = expandLeaveRange("2026-07-13", "2026-07-17", "PM_ONLY", "FULL");
    expect(segments).toEqual([
      { start_date: "2026-07-13", end_date: "2026-07-13", period: "PM" },
      { start_date: "2026-07-14", end_date: "2026-07-17", period: "BOTH" },
    ]);
    expectDisjoint(segments);
  });

  it("AM-only last day emits an AM edge after the interior", () => {
    const segments = expandLeaveRange("2026-07-13", "2026-07-17", "FULL", "AM_ONLY");
    expect(segments).toEqual([
      { start_date: "2026-07-13", end_date: "2026-07-16", period: "BOTH" },
      { start_date: "2026-07-17", end_date: "2026-07-17", period: "AM" },
    ]);
    expectDisjoint(segments);
  });

  it("both half edges on a 3+ day range produce three segments with correct interior bounds", () => {
    const segments = expandLeaveRange("2026-07-13", "2026-07-17", "PM_ONLY", "AM_ONLY");
    expect(segments).toEqual([
      { start_date: "2026-07-13", end_date: "2026-07-13", period: "PM" },
      { start_date: "2026-07-14", end_date: "2026-07-16", period: "BOTH" },
      { start_date: "2026-07-17", end_date: "2026-07-17", period: "AM" },
    ]);
    expectDisjoint(segments);
  });

  it("both half edges on exactly 2 days produce exactly 2 segments and no inverted interior", () => {
    const segments = expandLeaveRange("2026-07-15", "2026-07-16", "PM_ONLY", "AM_ONLY");
    expect(segments).toEqual([
      { start_date: "2026-07-15", end_date: "2026-07-15", period: "PM" },
      { start_date: "2026-07-16", end_date: "2026-07-16", period: "AM" },
    ]);
    expectDisjoint(segments);
  });

  it("single day FULL -> one BOTH segment", () => {
    expect(expandLeaveRange("2026-07-15", "2026-07-15", "FULL", "FULL")).toEqual([
      { start_date: "2026-07-15", end_date: "2026-07-15", period: "BOTH" },
    ]);
  });

  it("single day with an AM-only last edge -> one AM segment", () => {
    expect(expandLeaveRange("2026-07-15", "2026-07-15", "FULL", "AM_ONLY")).toEqual([
      { start_date: "2026-07-15", end_date: "2026-07-15", period: "AM" },
    ]);
  });

  it("single day with a PM-only first edge -> one PM segment", () => {
    expect(expandLeaveRange("2026-07-15", "2026-07-15", "PM_ONLY", "FULL")).toEqual([
      { start_date: "2026-07-15", end_date: "2026-07-15", period: "PM" },
    ]);
  });

  it("the contradictory single-day pair throws", () => {
    expect(() => expandLeaveRange("2026-07-15", "2026-07-15", "PM_ONLY", "AM_ONLY")).toThrow(
      /contradictory/,
    );
  });

  it("start after end throws", () => {
    expect(() => expandLeaveRange("2026-07-17", "2026-07-13", "FULL", "FULL")).toThrow(
      /start date must not be after end date/,
    );
  });

  it("handles a month boundary in the interior arithmetic", () => {
    const segments = expandLeaveRange("2026-07-31", "2026-08-03", "PM_ONLY", "AM_ONLY");
    expect(segments).toEqual([
      { start_date: "2026-07-31", end_date: "2026-07-31", period: "PM" },
      { start_date: "2026-08-01", end_date: "2026-08-02", period: "BOTH" },
      { start_date: "2026-08-03", end_date: "2026-08-03", period: "AM" },
    ]);
  });

  it("handles a year boundary in the interior arithmetic", () => {
    const segments = expandLeaveRange("2026-12-31", "2027-01-04", "PM_ONLY", "FULL");
    expect(segments).toEqual([
      { start_date: "2026-12-31", end_date: "2026-12-31", period: "PM" },
      { start_date: "2027-01-01", end_date: "2027-01-04", period: "BOTH" },
    ]);
  });
});

describe("singleDayToEdges", () => {
  it("maps each single-day option to a non-contradictory edge pair", () => {
    expect(singleDayToEdges("FULL")).toEqual({ firstDay: "FULL", lastDay: "FULL" });
    expect(singleDayToEdges("AM_ONLY")).toEqual({ firstDay: "FULL", lastDay: "AM_ONLY" });
    expect(singleDayToEdges("PM_ONLY")).toEqual({ firstDay: "PM_ONLY", lastDay: "FULL" });
  });
});

describe("segmentsToSessionKeys", () => {
  it("expands BOTH into AM and PM keys per day, including weekends", () => {
    // Fri 2026-07-17 .. Mon 2026-07-20: the weekend is included here -
    // callers (the preview) decide whether weekend keys matter.
    const keys = segmentsToSessionKeys([
      { start_date: "2026-07-17", end_date: "2026-07-20", period: "BOTH" },
    ]);
    expect(keys.size).toBe(8);
    expect(keys.has("2026-07-17|AM")).toBe(true);
    expect(keys.has("2026-07-18|PM")).toBe(true);
    expect(keys.has("2026-07-20|PM")).toBe(true);
  });

  it("expands a single-period segment into that period only", () => {
    const keys = segmentsToSessionKeys([
      { start_date: "2026-07-13", end_date: "2026-07-13", period: "AM" },
    ]);
    expect([...keys]).toEqual(["2026-07-13|AM"]);
  });
});