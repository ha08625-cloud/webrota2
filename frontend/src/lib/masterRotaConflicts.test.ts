import { describe, expect, it } from "vitest";

import type { MasterRotaSession } from "@/api/types";

import { findMasterRotaRoomConflicts, formatMasterRotaRoomConflictMessage } from "./masterRotaConflicts";

function makeSession(overrides: Partial<MasterRotaSession> = {}): MasterRotaSession {
  return {
    session_id: 1,
    doctor_id: 1,
    doctor_code: "AA",
    doctor_type: "Partner",
    week: 1,
    day: "Monday",
    period: "AM",
    session_type: "pre_assigned",
    room_id: 1,
    room_code: "D1",
    ...overrides,
  };
}

describe("findMasterRotaRoomConflicts", () => {
  it("returns nothing when no room is double-booked", () => {
    const sessions = [
      makeSession({ session_id: 1, doctor_id: 1, room_id: 1, room_code: "D1" }),
      makeSession({ session_id: 2, doctor_id: 2, room_id: 2, room_code: "D2" }),
    ];
    expect(findMasterRotaRoomConflicts(sessions)).toEqual([]);
  });

  it("ignores sessions with no room", () => {
    const sessions = [
      makeSession({ session_id: 1, doctor_id: 1, room_id: null, room_code: null, session_type: "no_surgery" }),
      makeSession({ session_id: 2, doctor_id: 2, room_id: null, room_code: null, session_type: "no_surgery" }),
    ];
    expect(findMasterRotaRoomConflicts(sessions)).toEqual([]);
  });

  it("flags two sessions holding the same room in the same week/day/period", () => {
    const sessions = [
      makeSession({ session_id: 1, doctor_id: 1, doctor_code: "AA", room_id: 1, room_code: "D1" }),
      makeSession({ session_id: 2, doctor_id: 2, doctor_code: "BB", room_id: 1, room_code: "D1" }),
    ];
    const conflicts = findMasterRotaRoomConflicts(sessions);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      week: 1,
      day: "Monday",
      period: "AM",
      roomId: 1,
      roomCode: "D1",
    });
    expect(conflicts[0].sessions.map((s) => s.session_id)).toEqual([1, 2]);
  });

  it("does not flag the same room held in different weeks - a different week is a different session, not a conflict", () => {
    const sessions = [
      makeSession({ session_id: 1, doctor_id: 1, week: 1, room_id: 1, room_code: "D1" }),
      makeSession({ session_id: 2, doctor_id: 2, week: 2, room_id: 1, room_code: "D1" }),
    ];
    expect(findMasterRotaRoomConflicts(sessions)).toEqual([]);
  });

  it("does not flag the same room held in different days or periods", () => {
    const sessions = [
      makeSession({ session_id: 1, doctor_id: 1, day: "Monday", period: "AM", room_id: 1, room_code: "D1" }),
      makeSession({ session_id: 2, doctor_id: 2, day: "Monday", period: "PM", room_id: 1, room_code: "D1" }),
      makeSession({ session_id: 3, doctor_id: 3, day: "Tuesday", period: "AM", room_id: 1, room_code: "D1" }),
    ];
    expect(findMasterRotaRoomConflicts(sessions)).toEqual([]);
  });

  it("handles three-way conflicts as one group, not pairwise duplicates", () => {
    const sessions = [
      makeSession({ session_id: 1, doctor_id: 1, room_id: 1, room_code: "D1" }),
      makeSession({ session_id: 2, doctor_id: 2, room_id: 1, room_code: "D1" }),
      makeSession({ session_id: 3, doctor_id: 3, room_id: 1, room_code: "D1" }),
    ];
    const conflicts = findMasterRotaRoomConflicts(sessions);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].sessions).toHaveLength(3);
  });

  it("sorts results by week, then day, then period, then room code", () => {
    const sessions = [
      // Week 2, Tuesday PM, room D2
      makeSession({ session_id: 1, doctor_id: 1, week: 2, day: "Tuesday", period: "PM", room_id: 2, room_code: "D2" }),
      makeSession({ session_id: 2, doctor_id: 2, week: 2, day: "Tuesday", period: "PM", room_id: 2, room_code: "D2" }),
      // Week 1, Monday AM, room D1
      makeSession({ session_id: 3, doctor_id: 3, week: 1, day: "Monday", period: "AM", room_id: 1, room_code: "D1" }),
      makeSession({ session_id: 4, doctor_id: 4, week: 1, day: "Monday", period: "AM", room_id: 1, room_code: "D1" }),
      // Week 1, Monday PM, room D3
      makeSession({ session_id: 5, doctor_id: 5, week: 1, day: "Monday", period: "PM", room_id: 3, room_code: "D3" }),
      makeSession({ session_id: 6, doctor_id: 6, week: 1, day: "Monday", period: "PM", room_id: 3, room_code: "D3" }),
    ];
    const conflicts = findMasterRotaRoomConflicts(sessions);
    expect(conflicts.map((c) => `${c.week}-${c.day}-${c.period}-${c.roomCode}`)).toEqual([
      "1-Monday-AM-D1",
      "1-Monday-PM-D3",
      "2-Tuesday-PM-D2",
    ]);
  });

  it("multiple independent conflicts each surface separately", () => {
    const sessions = [
      makeSession({ session_id: 1, doctor_id: 1, room_id: 1, room_code: "D1" }),
      makeSession({ session_id: 2, doctor_id: 2, room_id: 1, room_code: "D1" }),
      makeSession({ session_id: 3, doctor_id: 3, room_id: 2, room_code: "D2" }),
      makeSession({ session_id: 4, doctor_id: 4, room_id: 2, room_code: "D2" }),
    ];
    expect(findMasterRotaRoomConflicts(sessions)).toHaveLength(2);
  });
});

describe("formatMasterRotaRoomConflictMessage", () => {
  it("formats a two-doctor conflict", () => {
    const [conflict] = findMasterRotaRoomConflicts([
      makeSession({ session_id: 1, doctor_id: 1, doctor_code: "AA", week: 1, day: "Monday", period: "AM", room_id: 1, room_code: "D1" }),
      makeSession({ session_id: 2, doctor_id: 2, doctor_code: "BB", week: 1, day: "Monday", period: "AM", room_id: 1, room_code: "D1" }),
    ]);
    expect(formatMasterRotaRoomConflictMessage(conflict)).toBe(
      "Room D1 is assigned to AA and BB (Week 1, Monday AM)",
    );
  });

  it("formats a three-doctor conflict with an Oxford-comma-free list", () => {
    const [conflict] = findMasterRotaRoomConflicts([
      makeSession({ session_id: 1, doctor_id: 1, doctor_code: "AA", room_id: 1, room_code: "D1" }),
      makeSession({ session_id: 2, doctor_id: 2, doctor_code: "BB", room_id: 1, room_code: "D1" }),
      makeSession({ session_id: 3, doctor_id: 3, doctor_code: "CC", room_id: 1, room_code: "D1" }),
    ]);
    expect(formatMasterRotaRoomConflictMessage(conflict)).toBe(
      "Room D1 is assigned to AA, BB and CC (Week 1, Monday AM)",
    );
  });
});