import { describe, expect, it } from "vitest";

import { makeRotaSession } from "@/test/fixtures/rota";

import { findRoleHolder, findRoomHolder } from "./slotConflict";

describe("findRoomHolder", () => {
  it("finds the session in the same slot holding the room", () => {
    const holder = makeRotaSession({
      session_id: 1, week: 1, day: "Monday", period: "AM", room_id: 5,
    });
    const other = makeRotaSession({ session_id: 2, week: 1, day: "Monday", period: "AM", room_id: null });

    expect(findRoomHolder([holder, other], 1, "Monday", "AM", 5, 99)).toBe(holder);
  });

  it("returns undefined when nobody in the slot holds the room", () => {
    const other = makeRotaSession({ session_id: 2, week: 1, day: "Monday", period: "AM", room_id: null });

    expect(findRoomHolder([other], 1, "Monday", "AM", 5, 99)).toBeUndefined();
  });

  it("excludes the target session itself", () => {
    const self = makeRotaSession({ session_id: 1, week: 1, day: "Monday", period: "AM", room_id: 5 });

    expect(findRoomHolder([self], 1, "Monday", "AM", 5, 1)).toBeUndefined();
  });

  it("ignores holders in a different slot", () => {
    const elsewhere = makeRotaSession({ session_id: 2, week: 1, day: "Monday", period: "PM", room_id: 5 });

    expect(findRoomHolder([elsewhere], 1, "Monday", "AM", 5, 99)).toBeUndefined();
  });
});

describe("findRoleHolder", () => {
  it("finds a duty steal target by role alone (clinicTypeId null)", () => {
    const holder = makeRotaSession({
      session_id: 1, week: 1, day: "Monday", period: "AM", role: "duty_primary",
    });

    expect(findRoleHolder([holder], 1, "Monday", "AM", "duty_primary", null, 99)).toBe(holder);
  });

  it("matches on clinic type id, not just role=clinic", () => {
    const wrongType = makeRotaSession({
      session_id: 1, week: 1, day: "Monday", period: "AM", role: "clinic", clinic_type_id: 7,
    });
    const rightType = makeRotaSession({
      session_id: 2, week: 1, day: "Monday", period: "AM", role: "clinic", clinic_type_id: 9,
    });

    expect(findRoleHolder([wrongType, rightType], 1, "Monday", "AM", "clinic", 9, 99)).toBe(rightType);
  });

  it("excludes the target session itself", () => {
    const self = makeRotaSession({ session_id: 1, week: 1, day: "Monday", period: "AM", role: "duty_primary" });

    expect(findRoleHolder([self], 1, "Monday", "AM", "duty_primary", null, 1)).toBeUndefined();
  });

  it("returns undefined when no session in the slot has the role", () => {
    const other = makeRotaSession({ session_id: 2, week: 1, day: "Monday", period: "AM", role: null });

    expect(findRoleHolder([other], 1, "Monday", "AM", "duty_primary", null, 99)).toBeUndefined();
  });
});
