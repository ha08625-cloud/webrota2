import { describe, expect, it } from "vitest";

import { makeDoctor } from "@/test/fixtures/reference";
import { makeStagingSession } from "@/test/fixtures/staging";

import { getStagingCell, pivotStaging } from "./pivotStaging";

describe("pivotStaging", () => {
  it("builds rows from the doctors list, ordered by code within a type", () => {
    const doctors = [
      makeDoctor({ id: 2, code: "ZZ" }),
      makeDoctor({ id: 1, code: "AA" }),
    ];
    const grid = pivotStaging([], doctors, 1);
    expect(grid.rows.map((r) => r.doctor.code)).toEqual(["AA", "ZZ"]);
  });

  it("groups rows by doctor type before alphabetising by code", () => {
    const doctors = [
      makeDoctor({ id: 1, code: "ZZ", doctor_type: "AHP" }),
      makeDoctor({ id: 2, code: "AA", doctor_type: "Trainee" }),
      makeDoctor({ id: 3, code: "BB", doctor_type: "Salaried" }),
      makeDoctor({ id: 4, code: "YY", doctor_type: "Partner" }),
    ];
    const grid = pivotStaging([], doctors, 1);
    expect(grid.rows.map((r) => r.doctor.code)).toEqual(["YY", "BB", "AA", "ZZ"]);
  });

  it("gives an active doctor a row even with zero staged sessions", () => {
    const doctors = [makeDoctor({ id: 1, code: "AA", active: true })];
    const grid = pivotStaging([], doctors, 1);
    expect(grid.rows.map((r) => r.doctor.code)).toEqual(["AA"]);
    expect(grid.rows[0].inactiveWithSessions).toBe(false);
  });

  it("flags an inactive doctor who has staged sessions rather than dropping them", () => {
    const doctors = [makeDoctor({ id: 1, code: "AA", active: false })];
    const sessions = [makeStagingSession({ doctor_id: 1, doctor_code: "AA" })];
    const grid = pivotStaging(sessions, doctors, 1);
    expect(grid.rows.map((r) => r.doctor.code)).toEqual(["AA"]);
    expect(grid.rows[0].inactiveWithSessions).toBe(true);
  });

  it("drops an inactive doctor with no staged sessions", () => {
    const doctors = [makeDoctor({ id: 1, code: "AA", active: false })];
    const grid = pivotStaging([], doctors, 1);
    expect(grid.rows).toEqual([]);
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

  it("looks a session up by its exact (doctor, week, day, period) key", () => {
    const session = makeStagingSession({ doctor_id: 1, week: 2, day: "Wednesday", period: "PM" });
    const grid = pivotStaging([session], [], 2);
    expect(getStagingCell(grid, 1, 2, "Wednesday", "PM")).toBe(session);
  });

  it("returns undefined for an absent slot", () => {
    const grid = pivotStaging([makeStagingSession({ doctor_id: 1 })], [], 1);
    expect(getStagingCell(grid, 1, 1, "Tuesday", "AM")).toBeUndefined();
  });
});