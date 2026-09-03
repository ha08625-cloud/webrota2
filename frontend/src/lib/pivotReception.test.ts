import { describe, expect, it } from "vitest";

import { makeReceptionMasterSession, makeReceptionRotaSession, makeReceptionStaff } from "@/test/fixtures/reception";

import { getReceptionCell, pivotReception } from "./pivotReception";

describe("pivotReception", () => {
  it("builds rows from the staff list, alphabetical by code", () => {
    const staff = [
      makeReceptionStaff({ id: 2, code: "ZZ" }),
      makeReceptionStaff({ id: 1, code: "AA" }),
    ];
    const grid = pivotReception([], staff);
    expect(grid.rows.map((r) => r.staff.code)).toEqual(["AA", "ZZ"]);
  });

  it("carries the full staff object through onto each row", () => {
    const staff = [makeReceptionStaff({ id: 1, code: "AA" })];
    const grid = pivotReception([], staff);
    expect(grid.rows[0].staff).toEqual(staff[0]);
  });

  it("does not duplicate a staff row when they have multiple sessions", () => {
    const staff = [makeReceptionStaff({ id: 1, code: "AA" })];
    const sessions = [
      makeReceptionMasterSession({ staff_id: 1, hour: 9 }),
      makeReceptionMasterSession({ staff_id: 1, hour: 10 }),
    ];
    const grid = pivotReception(sessions, staff);
    expect(grid.rows).toHaveLength(1);
  });

  it("gives an active staff member a row even with zero sessions", () => {
    const staff = [makeReceptionStaff({ id: 1, code: "AA", active: true })];
    const grid = pivotReception([], staff);
    expect(grid.rows.map((r) => r.staff.code)).toEqual(["AA"]);
    expect(grid.rows[0].inactiveWithSessions).toBe(false);
  });

  it("flags an inactive staff member who has sessions rather than dropping them", () => {
    const staff = [makeReceptionStaff({ id: 1, code: "AA", active: false })];
    const sessions = [makeReceptionMasterSession({ staff_id: 1 })];
    const grid = pivotReception(sessions, staff);
    expect(grid.rows.map((r) => r.staff.code)).toEqual(["AA"]);
    expect(grid.rows[0].inactiveWithSessions).toBe(true);
  });

  it("drops an inactive staff member with no sessions", () => {
    const staff = [makeReceptionStaff({ id: 1, code: "AA", active: false })];
    const grid = pivotReception([], staff);
    expect(grid.rows).toEqual([]);
  });

  it("looks a session up by its exact (staff, hour) key", () => {
    const session = makeReceptionMasterSession({ staff_id: 1, hour: 11 });
    const grid = pivotReception([session], []);
    expect(getReceptionCell(grid, 1, 11)).toBe(session);
  });

  it("returns undefined for an absent slot - not expected this hour, not an unassigned one", () => {
    const grid = pivotReception([makeReceptionMasterSession({ staff_id: 1, hour: 9 })], []);
    expect(getReceptionCell(grid, 1, 10)).toBeUndefined();
  });

  it("is generic over ReceptionRotaSession too, the shape Task 8's day rota reuses this pivot with", () => {
    const session = makeReceptionRotaSession({ staff_id: 1, hour: 14, role: "other", note: "Post run" });
    const grid = pivotReception([session], []);
    const cell = getReceptionCell(grid, 1, 14);
    expect(cell?.note).toBe("Post run");
  });
});
