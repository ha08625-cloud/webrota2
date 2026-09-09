import { describe, expect, it } from "vitest";

import { makeRotaSession } from "@/test/fixtures/rota";
import { makeClinicType, makeRoom } from "@/test/fixtures/reference";
import type { ClinicType, Room } from "@/api/types";

import { cellStyle } from "./cellStyle";

function maps(rooms: Room[] = [], clinicTypes: ClinicType[] = []) {
  return {
    roomsById: new Map(rooms.map((r) => [r.id, r])),
    clinicTypesById: new Map(clinicTypes.map((c) => [c.id, c])),
  };
}

describe("cellStyle", () => {
  it("renders an absent cell (no session) as default/black", () => {
    const { roomsById, clinicTypesById } = maps();
    expect(cellStyle(undefined, roomsById, clinicTypesById)).toEqual({
      background: "default",
      fontColor: "black",
    });
  });

  it("leave wins over everything else, including duty + room", () => {
    const room = makeRoom({ id: 1, room_type: "C" });
    const session = makeRotaSession({
      is_on_leave: true,
      role: "duty_primary",
      room_id: 1,
      is_wfh: true,
    });
    const { roomsById, clinicTypesById } = maps([room]);
    expect(cellStyle(session, roomsById, clinicTypesById)).toEqual({
      background: "leave",
      fontColor: "red",
    });
  });

  it("WFH wins over role colouring when not on leave", () => {
    const session = makeRotaSession({ is_wfh: true, role: "clinic", clinic_type_name: "School clinic" });
    const { roomsById, clinicTypesById } = maps();
    expect(cellStyle(session, roomsById, clinicTypesById)).toEqual({
      background: "wfh",
      fontColor: "black",
    });
  });

  it("duty_primary and duty_secondary both render as duty (light red)", () => {
    const { roomsById, clinicTypesById } = maps();
    for (const role of ["duty_primary", "duty_secondary"] as const) {
      const session = makeRotaSession({ role });
      expect(cellStyle(session, roomsById, clinicTypesById).background).toBe("duty");
    }
  });

  it("a clinic session with category=duty_helper renders as duty_helper (light blue)", () => {
    const clinicType = makeClinicType({ id: 5, category: "duty_helper" });
    const session = makeRotaSession({ role: "clinic", clinic_type_id: 5 });
    const { roomsById, clinicTypesById } = maps([], [clinicType]);
    expect(cellStyle(session, roomsById, clinicTypesById).background).toBe("duty_helper");
  });

  it("a clinic session with category=null renders as an ordinary named clinic (light green)", () => {
    const clinicType = makeClinicType({ id: 6, category: null });
    const session = makeRotaSession({ role: "clinic", clinic_type_id: 6 });
    const { roomsById, clinicTypesById } = maps([], [clinicType]);
    expect(cellStyle(session, roomsById, clinicTypesById).background).toBe("clinic");
  });

  it("a clinic session with an unrecognised category still renders as an ordinary clinic, not an error", () => {
    const clinicType = makeClinicType({ id: 7, category: "something_else" });
    const session = makeRotaSession({ role: "clinic", clinic_type_id: 7 });
    const { roomsById, clinicTypesById } = maps([], [clinicType]);
    expect(cellStyle(session, roomsById, clinicTypesById).background).toBe("clinic");
  });

  it("a clinic session whose clinic_type_id isn't in the lookup still renders as clinic (fail open, not throw)", () => {
    const session = makeRotaSession({ role: "clinic", clinic_type_id: 999 });
    const { roomsById, clinicTypesById } = maps();
    expect(cellStyle(session, roomsById, clinicTypesById).background).toBe("clinic");
  });

  it("NO_SURGERY with no role present renders grey", () => {
    const session = makeRotaSession({ template_type: "no_surgery", role: null });
    const { roomsById, clinicTypesById } = maps();
    expect(cellStyle(session, roomsById, clinicTypesById).background).toBe("no_surgery");
  });

  it("ADMIN_TIME with no role present renders grey", () => {
    const session = makeRotaSession({ template_type: "admin_time", role: null });
    const { roomsById, clinicTypesById } = maps();
    expect(cellStyle(session, roomsById, clinicTypesById).background).toBe("no_surgery");
  });

  it("NO_SURGERY with a role present renders the role colour, not grey (role wins visually)", () => {
    const session = makeRotaSession({ template_type: "no_surgery", role: "duty_primary" });
    const { roomsById, clinicTypesById } = maps();
    expect(cellStyle(session, roomsById, clinicTypesById).background).toBe("duty");
  });

  it("a normal session with no role and a non-blocking template_type renders default/white", () => {
    const session = makeRotaSession({ template_type: "requires_room", role: null });
    const { roomsById, clinicTypesById } = maps();
    expect(cellStyle(session, roomsById, clinicTypesById).background).toBe("default");
  });

  it.each([
    ["D", "black"],
    ["SR", "black"],
    ["C", "red"],
    ["W", "blue"],
  ] as const)("room type %s maps to font colour %s", (roomType, expected) => {
    const room = makeRoom({ id: 1, room_type: roomType });
    const session = makeRotaSession({ room_id: 1 });
    const { roomsById, clinicTypesById } = maps([room]);
    expect(cellStyle(session, roomsById, clinicTypesById).fontColor).toBe(expected);
  });

  it("no room_id renders black font colour", () => {
    const session = makeRotaSession({ room_id: null });
    const { roomsById, clinicTypesById } = maps();
    expect(cellStyle(session, roomsById, clinicTypesById).fontColor).toBe("black");
  });
});