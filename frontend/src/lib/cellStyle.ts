import type { ClinicType, Room, RoomType, RotaSession } from "@/api/types";

export type CellBackground = "leave" | "wfh" | "duty" | "duty_helper" | "clinic" | "no_surgery" | "default";
export type FontColor = "black" | "red" | "blue";

export interface CellStyle {
  background: CellBackground;
  fontColor: FontColor;
}

const ROOM_FONT_COLOR: Record<RoomType, FontColor> = {
  D: "black",
  SR: "black",
  C: "red",
  W: "blue",
};

/**
 * Q13 colour rules, single source of truth (per the M4 plan's explicit
 * "single cellStyle() function" instruction). Precedence, in order:
 * leave wins over everything; then WFH; then role colouring (duty /
 * duty helper / named clinic); then NO_SURGERY/ADMIN_TIME grey, which
 * only applies when no role is present; then default white.
 *
 * `roomsById` and `clinicTypesById` are pre-built lookups (see
 * useRooms/useClinicTypes) rather than arrays, since this function runs
 * once per cell per render.
 */
export function cellStyle(
  session: RotaSession | undefined,
  roomsById: Map<number, Room>,
  clinicTypesById: Map<number, ClinicType>,
): CellStyle {
  if (session === undefined) {
    // Absent: no template entry for this doctor/slot at all.
    return { background: "default", fontColor: "black" };
  }

  const fontColor = fontColorFor(session, roomsById);

  if (session.is_on_leave) {
    return { background: "leave", fontColor };
  }

  if (session.is_wfh) {
    // WFH background is unconditionally blank/white regardless of any
    // role present - the WFH badge carries the signal, not the
    // background colour.
    return { background: "wfh", fontColor };
  }

  if (session.role === "duty_primary" || session.role === "duty_secondary") {
    return { background: "duty", fontColor };
  }

  if (session.role === "clinic") {
    const clinicType = session.clinic_type_id !== null ? clinicTypesById.get(session.clinic_type_id) : undefined;
    if (clinicType?.category === "duty_helper") {
      return { background: "duty_helper", fontColor };
    }
    return { background: "clinic", fontColor };
  }

  if (session.template_type === "no_surgery" || session.template_type === "admin_time") {
    // Only reached when no role is present - the role branches above
    // already returned. This is the "role colouring wins visually" rule
    // (architecture-clinical.md, "Cell colouring"): a role on an incompatible slot
    // stays normal/interactive here, and Phase 12's
    // role_on_incompatible_slot warning is what surfaces the conflict,
    // not the cell's own appearance.
    return { background: "no_surgery", fontColor };
  }

  return { background: "default", fontColor };
}

function fontColorFor(session: RotaSession, roomsById: Map<number, Room>): FontColor {
  if (session.room_id === null) {
    return "black";
  }
  const room = roomsById.get(session.room_id);
  if (room === undefined) {
    return "black";
  }
  return ROOM_FONT_COLOR[room.room_type];
}

export function isAbsent(session: RotaSession | undefined): boolean {
  return session === undefined;
}