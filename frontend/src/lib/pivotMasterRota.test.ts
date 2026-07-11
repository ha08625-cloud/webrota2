import { describe, expect, it } from "vitest";

import { makeDoctor } from "@/test/fixtures/reference";
import { makeMasterRotaSession } from "@/test/fixtures/masterRota";

import { getMasterRotaCell, pivotMasterRota } from "./pivotMasterRota";

describe("pivotMasterRota", () => {
  it("builds rows from the doctors list, ordered by code within a type", () => {
    const doctors = [
      makeDoctor({ id: 2, code: "ZZ" }),
      makeDoctor({ id: 1, code: "AA" }),
    ];
    const sessions = [
      makeMasterRotaSession({ doctor_id: 2, doctor_code: "ZZ" }),
      makeMasterRotaSession({ doctor_id: 1, doctor_code: "AA" }),
    ];
    const grid = pivotMasterRota(sessions, doctors);
    expect(grid.rows.map((r) => r.doctor.code)).toEqual(["AA", "ZZ"]);
  });

  it("groups rows by doctor type (Partner, Salaried, Trainee, AHP) before alphabetising by code", () => {
    const doctors = [
      makeDoctor({ id: 1, code: "ZZ", doctor_type: "AHP" }),
      makeDoctor({ id: 2, code: "AA", doctor_type: "Trainee" }),
      makeDoctor({ id: 3, code: "BB", doctor_type: "Salaried" }),
      makeDoctor({ id: 4, code: "YY", doctor_type: "Partner" }),
    ];
    const grid = pivotMasterRota([], doctors);
    expect(grid.rows.map((r) => r.doctor.code)).toEqual(["YY", "BB", "AA", "ZZ"]);
  });

  it("carries the full doctor object through onto each row", () => {
    const doctors = [makeDoctor({ id: 1, code: "AA", doctor_type: "Salaried" })];
    const grid = pivotMasterRota([], doctors);
    expect(grid.rows[0].doctor.doctor_type).toBe("Salaried");
  });

  it("does not duplicate a doctor row when they have multiple sessions", () => {
    const doctors = [makeDoctor({ id: 1, code: "AA" })];
    const sessions = [
      makeMasterRotaSession({ doctor_id: 1, doctor_code: "AA", day: "Monday" }),
      makeMasterRotaSession({ doctor_id: 1, doctor_code: "AA", day: "Tuesday" }),
    ];
    const grid = pivotMasterRota(sessions, doctors);
    expect(grid.rows).toHaveLength(1);
  });

  it("gives an active doctor a row even with zero template sessions (M4.4 groundwork)", () => {
    const doctors = [makeDoctor({ id: 1, code: "AA", active: true })];
    const grid = pivotMasterRota([], doctors);
    expect(grid.rows.map((r) => r.doctor.code)).toEqual(["AA"]);
    expect(grid.rows[0].inactiveWithSessions).toBe(false);
  });

  it("flags an inactive doctor who has template sessions rather than dropping them", () => {
    const doctors = [makeDoctor({ id: 1, code: "AA", active: false })];
    const sessions = [makeMasterRotaSession({ doctor_id: 1, doctor_code: "AA" })];
    const grid = pivotMasterRota(sessions, doctors);
    expect(grid.rows.map((r) => r.doctor.code)).toEqual(["AA"]);
    expect(grid.rows[0].inactiveWithSessions).toBe(true);
  });

  it("drops an inactive doctor with no template sessions", () => {
    const doctors = [makeDoctor({ id: 1, code: "AA", active: false })];
    const grid = pivotMasterRota([], doctors);
    expect(grid.rows).toEqual([]);
  });

  it("derives the week list from the max week present, not a hardcoded 1-4", () => {
    const sessions = [makeMasterRotaSession({ week: 2 })];
    const grid = pivotMasterRota(sessions, []);
    expect(grid.weeks).toEqual([1, 2]);
  });

  it("defaults to week 1 only when no sessions are present", () => {
    const grid = pivotMasterRota([], []);
    expect(grid.weeks).toEqual([1]);
  });

  it("looks a session up by its exact (doctor, week, day, period) key", () => {
    const session = makeMasterRotaSession({ doctor_id: 1, week: 2, day: "Wednesday", period: "PM" });
    const grid = pivotMasterRota([session], []);
    expect(getMasterRotaCell(grid, 1, 2, "Wednesday", "PM")).toBe(session);
  });

  it("returns undefined for an absent slot", () => {
    const grid = pivotMasterRota([makeMasterRotaSession({ doctor_id: 1 })], []);
    expect(getMasterRotaCell(grid, 1, 1, "Tuesday", "AM")).toBeUndefined();
  });
});
