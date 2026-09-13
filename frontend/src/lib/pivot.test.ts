import { describe, expect, it } from "vitest";

import { makeDoctor } from "@/test/fixtures/reference";
import { makeRotaSession } from "@/test/fixtures/rota";

import { getCell, pivotRota } from "./pivot";

// Row/cell behaviour lives in pivotSessions.test.ts - pivotRota is that
// pivot with no week domain of its own (callers page it with
// weekNumbers(config.num_weeks)). These cover the wiring only.

describe("pivotRota", () => {
  it("builds rows and cells for a generated rota", () => {
    const doctors = [makeDoctor({ id: 1, code: "ZZ" }), makeDoctor({ id: 2, code: "AA" })];
    const session = makeRotaSession({ doctor_id: 1, week: 2, day: "Wednesday", period: "PM" });
    const grid = pivotRota([session], doctors);
    expect(grid.rows.map((r) => r.doctor.code)).toEqual(["AA", "ZZ"]);
    expect(getCell(grid, 1, 2, "Wednesday", "PM")).toBe(session);
  });

  it("returns undefined for a slot with no template entry (absent cell, not an error)", () => {
    const grid = pivotRota([], [makeDoctor({ id: 1 })]);
    expect(getCell(grid, 1, 1, "Monday", "AM")).toBeUndefined();
  });
});
