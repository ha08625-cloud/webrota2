import { describe, expect, it } from "vitest";

import { makeDoctor } from "@/test/fixtures/reference";
import { makeStagingSession } from "@/test/fixtures/staging";

import { getStagingCell, pivotStaging } from "./pivotStaging";

// Row/cell behaviour lives in pivotSessions.test.ts - the num_weeks-driven
// week domain is the only thing pivotStaging adds, so it is what is
// covered here.

describe("pivotStaging", () => {
  it("builds rows and cells for a staging run", () => {
    const doctors = [makeDoctor({ id: 2, code: "ZZ" }), makeDoctor({ id: 1, code: "AA" })];
    const session = makeStagingSession({ doctor_id: 1, week: 2, day: "Wednesday", period: "PM" });
    const grid = pivotStaging([session], doctors, 2);
    expect(grid.rows.map((r) => r.doctor.code)).toEqual(["AA", "ZZ"]);
    expect(getStagingCell(grid, 1, 2, "Wednesday", "PM")).toBe(session);
  });

  it("derives the week list from the numWeeks parameter, not from sessions or a fixed 1-4", () => {
    // Deliberately only a week-1 session, with numWeeks=2 - the point of
    // this pivot (see file docstring) is that the tab count follows the
    // staging's own num_weeks, unlike pivotMasterRota's fixed [1,2,3,4].
    const sessions = [makeStagingSession({ week: 1 })];
    const grid = pivotStaging(sessions, [], 2);
    expect(grid.weeks).toEqual([1, 2]);
  });

  it("renders a single week tab for a 1-week staging even if a session somehow carries a higher week", () => {
    const sessions = [makeStagingSession({ week: 3 })];
    const grid = pivotStaging(sessions, [], 1);
    expect(grid.weeks).toEqual([1]);
  });

  it("clamps a zero-week staging to a single tab rather than rendering none", () => {
    expect(pivotStaging([], [], 0).weeks).toEqual([1]);
  });
});
