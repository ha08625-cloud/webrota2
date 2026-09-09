import { describe, expect, it } from "vitest";

import { makeDoctor } from "@/test/fixtures/reference";
import { makeRotaSession } from "@/test/fixtures/rota";

import { getCell, pivotRota, weekNumbers } from "./pivot";

describe("pivotRota", () => {
  it("includes active doctors even with no sessions, ordered by code within a type", () => {
    const doctors = [makeDoctor({ id: 1, code: "ZZ" }), makeDoctor({ id: 2, code: "AA" })];
    const grid = pivotRota([], doctors);
    expect(grid.rows.map((r) => r.doctor.code)).toEqual(["AA", "ZZ"]);
  });

  it("groups rows by doctor type (Partner, Salaried, Trainee, AHP) before alphabetising by code", () => {
    const doctors = [
      makeDoctor({ id: 1, code: "ZZ", doctor_type: "AHP" }),
      makeDoctor({ id: 2, code: "AA", doctor_type: "Trainee" }),
      makeDoctor({ id: 3, code: "BB", doctor_type: "Salaried" }),
      makeDoctor({ id: 4, code: "YY", doctor_type: "Partner" }),
    ];
    const grid = pivotRota([], doctors);
    expect(grid.rows.map((r) => r.doctor.code)).toEqual(["YY", "BB", "AA", "ZZ"]);
  });

  it("excludes an inactive doctor with no sessions in this rota", () => {
    const doctors = [makeDoctor({ id: 1, code: "AB", active: false })];
    const grid = pivotRota([], doctors);
    expect(grid.rows).toHaveLength(0);
  });

  it("includes and flags an inactive doctor who has sessions in this rota", () => {
    const doctors = [makeDoctor({ id: 1, code: "AB", active: false })];
    const sessions = [makeRotaSession({ doctor_id: 1 })];
    const grid = pivotRota(sessions, doctors);
    expect(grid.rows).toHaveLength(1);
    expect(grid.rows[0].inactiveWithSessions).toBe(true);
  });

  it("does not flag an active doctor as inactiveWithSessions", () => {
    const doctors = [makeDoctor({ id: 1, code: "AB", active: true })];
    const sessions = [makeRotaSession({ doctor_id: 1 })];
    const grid = pivotRota(sessions, doctors);
    expect(grid.rows[0].inactiveWithSessions).toBe(false);
  });

  it("looks a session up by its exact (doctor, week, day, period) key", () => {
    const session = makeRotaSession({ doctor_id: 1, week: 2, day: "Wednesday", period: "PM" });
    const grid = pivotRota([session], [makeDoctor({ id: 1 })]);
    expect(getCell(grid, 1, 2, "Wednesday", "PM")).toBe(session);
  });

  it("returns undefined for a slot with no template entry (absent cell, not an error)", () => {
    const grid = pivotRota([], [makeDoctor({ id: 1 })]);
    expect(getCell(grid, 1, 1, "Monday", "AM")).toBeUndefined();
  });

  it("does not confuse sessions across different weeks for the same doctor/day/period", () => {
    const week1 = makeRotaSession({ doctor_id: 1, week: 1, day: "Monday", period: "AM", room_code: "D1" });
    const week2 = makeRotaSession({ doctor_id: 1, week: 2, day: "Monday", period: "AM", room_code: "D2" });
    const grid = pivotRota([week1, week2], [makeDoctor({ id: 1 })]);
    expect(getCell(grid, 1, 1, "Monday", "AM")?.room_code).toBe("D1");
    expect(getCell(grid, 1, 2, "Monday", "AM")?.room_code).toBe("D2");
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