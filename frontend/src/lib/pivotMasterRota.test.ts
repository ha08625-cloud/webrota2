import { describe, expect, it } from "vitest";

import { makeDoctor } from "@/test/fixtures/reference";
import { makeMasterRotaSession } from "@/test/fixtures/masterRota";

import { getMasterRotaCell, pivotMasterRota } from "./pivotMasterRota";

// Row/cell behaviour lives in pivotSessions.test.ts - the fixed week
// domain is the only thing pivotMasterRota adds, so it is what is
// covered here.

describe("pivotMasterRota", () => {
  it("builds rows and cells for a template", () => {
    const doctors = [makeDoctor({ id: 2, code: "ZZ" }), makeDoctor({ id: 1, code: "AA" })];
    const session = makeMasterRotaSession({ doctor_id: 1, week: 2, day: "Wednesday", period: "PM" });
    const grid = pivotMasterRota([session], doctors);
    expect(grid.rows.map((r) => r.doctor.code)).toEqual(["AA", "ZZ"]);
    expect(getMasterRotaCell(grid, 1, 2, "Wednesday", "PM")).toBe(session);
  });

  it("always returns the fixed 1-4 week domain regardless of which weeks have sessions (M4.4 Task 5)", () => {
    const sessions = [makeMasterRotaSession({ week: 2 })];
    const grid = pivotMasterRota(sessions, []);
    expect(grid.weeks).toEqual([1, 2, 3, 4]);
  });

  it("still returns all four weeks with no sessions at all", () => {
    const grid = pivotMasterRota([], []);
    expect(grid.weeks).toEqual([1, 2, 3, 4]);
  });
});
