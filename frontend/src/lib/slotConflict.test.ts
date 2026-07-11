import { describe, expect, it } from "vitest";

import { makeMasterRotaSession } from "@/test/fixtures/masterRota";
import { makeRotaSession } from "@/test/fixtures/rota";

import { findMasterRoomHolder, findRoleHolder, findRoomHolder } from "./slotConflict";

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

describe("findMasterRoomHolder", () => {
  it("finds the master session in the same slot holding the room", () => {
    const holder = makeMasterRotaSession({
      session_id: 1, week: 1, day: "Monday", period: "AM", room_id: 5,
    });
    const other = makeMasterRotaSession({ session_id: 2, week: 1, day: "Monday", period: "AM", room_id: null });

    expect(findMasterRoomHolder([holder, other], 1, "Monday", "AM", 5, 99)).toBe(holder);
  });

  it("returns undefined when nobody in the slot holds the room", () => {
    const other = makeMasterRotaSession({ session_id: 2, week: 1, day: "Monday", period: "AM", room_id: null });

    expect(findMasterRoomHolder([other], 1, "Monday", "AM", 5, 99)).toBeUndefined();
  });

  it("excludes the target session itself", () => {
    const self = makeMasterRotaSession({ session_id: 1, week: 1, day: "Monday", period: "AM", room_id: 5 });

    expect(findMasterRoomHolder([self], 1, "Monday", "AM", 5, 1)).toBeUndefined();
  });

  it("ignores holders in a different slot", () => {
    const elsewhere = makeMasterRotaSession({ session_id: 2, week: 1, day: "Monday", period: "PM", room_id: 5 });

    expect(findMasterRoomHolder([elsewhere], 1, "Monday", "AM", 5, 99)).toBeUndefined();
  });

  it("ignores holders in a different week", () => {
    const differentWeek = makeMasterRotaSession({ session_id: 2, week: 2, day: "Monday", period: "AM", room_id: 5 });

    expect(findMasterRoomHolder([differentWeek], 1, "Monday", "AM", 5, 99)).toBeUndefined();
  });

  it("with a null excludeSessionId (create mode, no self yet), any session in the slot holding the room counts", () => {
    const holder = makeMasterRotaSession({ session_id: 1, week: 1, day: "Monday", period: "AM", room_id: 5 });

    expect(findMasterRoomHolder([holder], 1, "Monday", "AM", 5, null)).toBe(holder);
  });
});