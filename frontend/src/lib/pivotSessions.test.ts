import { describe, expect, it } from "vitest";

import { makeDoctor } from "@/test/fixtures/reference";
import { makeRotaSession } from "@/test/fixtures/rota";

import { getSessionCell, pivotSessions, weekNumbers } from "./pivotSessions";

// The shared row/cell behaviour behind pivotRota, pivotMasterRota and
// pivotStaging. Each of those has its own test file covering only the
// week domain, which is the sole thing that differs between them.

describe("pivotSessions", () => {
  it("includes active doctors even with no sessions, ordered by code within a type", () => {
    const doctors = [makeDoctor({ id: 1, code: "ZZ" }), makeDoctor({ id: 2, code: "AA" })];
    const grid = pivotSessions([], doctors);
    expect(grid.rows.map((r) => r.doctor.code)).toEqual(["AA", "ZZ"]);
  });

  it("groups rows by doctor type (Partner, Salaried, Trainee, AHP) before alphabetising by code", () => {
    const doctors = [
      makeDoctor({ id: 1, code: "ZA", doctor_type: "Partner" }),
      makeDoctor({ id: 2, code: "AB", doctor_type: "Salaried" }),
      makeDoctor({ id: 3, code: "AA", doctor_type: "AHP" }),
      makeDoctor({ id: 4, code: "AC", doctor_type: "Trainee" }),
    ];
    const grid = pivotSessions([], doctors);
    expect(grid.rows.map((r) => r.doctor.code)).toEqual(["ZA", "AB", "AC", "AA"]);
  });

  it("carries the full doctor object through onto each row", () => {
    const doctors = [makeDoctor({ id: 1, code: "AA", doctor_type: "Salaried" })];
    const grid = pivotSessions([], doctors);
    expect(grid.rows[0].doctor.doctor_type).toBe("Salaried");
  });

  it("does not duplicate a doctor row when they have multiple sessions", () => {
    const doctors = [makeDoctor({ id: 1, code: "AA" })];
    const sessions = [
      makeRotaSession({ doctor_id: 1, day: "Monday" }),
      makeRotaSession({ doctor_id: 1, day: "Tuesday" }),
    ];
    const grid = pivotSessions(sessions, doctors);
    expect(grid.rows).toHaveLength(1);
  });

  it("excludes an inactive doctor with no sessions", () => {
    const doctors = [makeDoctor({ id: 1, code: "AB", active: false })];
    const grid = pivotSessions([], doctors);
    expect(grid.rows).toHaveLength(0);
  });

  it("includes and flags an inactive doctor who has sessions", () => {
    const doctors = [makeDoctor({ id: 1, code: "AB", active: false })];
    const grid = pivotSessions([makeRotaSession({ doctor_id: 1 })], doctors);
    expect(grid.rows).toHaveLength(1);
    expect(grid.rows[0].inactiveWithSessions).toBe(true);
  });

  it("does not flag an active doctor as inactiveWithSessions", () => {
    const doctors = [makeDoctor({ id: 1, code: "AB", active: true })];
    const grid = pivotSessions([makeRotaSession({ doctor_id: 1 })], doctors);
    expect(grid.rows[0].inactiveWithSessions).toBe(false);
  });
});

describe("getSessionCell", () => {
  it("finds a session by its (doctor, week, day, period) slot", () => {
    const session = makeRotaSession({ doctor_id: 1, week: 2, day: "Wednesday", period: "PM" });
    const grid = pivotSessions([session], [makeDoctor({ id: 1 })]);
    expect(getSessionCell(grid, 1, 2, "Wednesday", "PM")).toBe(session);
  });

  it("returns undefined for a slot with no template entry (absent cell, not an error)", () => {
    const grid = pivotSessions([], [makeDoctor({ id: 1 })]);
    expect(getSessionCell(grid, 1, 1, "Monday", "AM")).toBeUndefined();
  });

  it("does not confuse sessions across different weeks for the same doctor/day/period", () => {
    const week1 = makeRotaSession({ doctor_id: 1, week: 1, day: "Monday", period: "AM", room_code: "D1" });
    const week2 = makeRotaSession({ doctor_id: 1, week: 2, day: "Monday", period: "AM", room_code: "D2" });
    const grid = pivotSessions([week1, week2], [makeDoctor({ id: 1 })]);
    expect(getSessionCell(grid, 1, 1, "Monday", "AM")?.room_code).toBe("D1");
    expect(getSessionCell(grid, 1, 2, "Monday", "AM")?.room_code).toBe("D2");
  });
});

describe("weekNumbers", () => {
  it("produces 1..n", () => {
    expect(weekNumbers(4)).toEqual([1, 2, 3, 4]);
  });

  it("handles a single-week rota", () => {
    expect(weekNumbers(1)).toEqual([1]);
  });
});
