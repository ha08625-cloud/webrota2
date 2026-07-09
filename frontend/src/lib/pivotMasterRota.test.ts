import { describe, expect, it } from "vitest";

import { makeMasterRotaSession } from "@/test/fixtures/masterRota";

import { getMasterRotaCell, pivotMasterRota } from "./pivotMasterRota";

describe("pivotMasterRota", () => {
  it("builds rows only from doctors present in the sessions, ordered by code within a type", () => {
    const sessions = [
      makeMasterRotaSession({ doctor_id: 2, doctor_code: "ZZ" }),
      makeMasterRotaSession({ doctor_id: 1, doctor_code: "AA" }),
    ];
    const grid = pivotMasterRota(sessions);
    expect(grid.rows.map((r) => r.doctorCode)).toEqual(["AA", "ZZ"]);
  });

  it("groups rows by doctor type (Partner, Salaried, Trainee, AHP) before alphabetising by code", () => {
    const sessions = [
      makeMasterRotaSession({ doctor_id: 1, doctor_code: "ZZ", doctor_type: "AHP" }),
      makeMasterRotaSession({ doctor_id: 2, doctor_code: "AA", doctor_type: "Trainee" }),
      makeMasterRotaSession({ doctor_id: 3, doctor_code: "BB", doctor_type: "Salaried" }),
      makeMasterRotaSession({ doctor_id: 4, doctor_code: "YY", doctor_type: "Partner" }),
    ];
    const grid = pivotMasterRota(sessions);
    expect(grid.rows.map((r) => r.doctorCode)).toEqual(["YY", "BB", "AA", "ZZ"]);
  });

  it("carries doctorType through onto each row", () => {
    const sessions = [makeMasterRotaSession({ doctor_id: 1, doctor_code: "AA", doctor_type: "Salaried" })];
    const grid = pivotMasterRota(sessions);
    expect(grid.rows[0].doctorType).toBe("Salaried");
  });

  it("does not duplicate a doctor row when they have multiple sessions", () => {
    const sessions = [
      makeMasterRotaSession({ doctor_id: 1, doctor_code: "AA", day: "Monday" }),
      makeMasterRotaSession({ doctor_id: 1, doctor_code: "AA", day: "Tuesday" }),
    ];
    const grid = pivotMasterRota(sessions);
    expect(grid.rows).toHaveLength(1);
  });

  it("derives the week list from the max week present, not a hardcoded 1-4", () => {
    const sessions = [makeMasterRotaSession({ week: 2 })];
    const grid = pivotMasterRota(sessions);
    expect(grid.weeks).toEqual([1, 2]);
  });

  it("defaults to week 1 only when no sessions are present", () => {
    const grid = pivotMasterRota([]);
    expect(grid.weeks).toEqual([1]);
  });

  it("looks a session up by its exact (doctor, week, day, period) key", () => {
    const session = makeMasterRotaSession({ doctor_id: 1, week: 2, day: "Wednesday", period: "PM" });
    const grid = pivotMasterRota([session]);
    expect(getMasterRotaCell(grid, 1, 2, "Wednesday", "PM")).toBe(session);
  });

  it("returns undefined for an absent slot", () => {
    const grid = pivotMasterRota([makeMasterRotaSession({ doctor_id: 1 })]);
    expect(getMasterRotaCell(grid, 1, 1, "Tuesday", "AM")).toBeUndefined();
  });
});