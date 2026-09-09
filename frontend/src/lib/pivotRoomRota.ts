import type { Day, Period, Room, RoomType, RotaSession } from "@/api/types";

/**
 * Fixed display order for room-type row groups in the room view - not
 * alphabetical (C/D/SR/W) but the familiar GAS sheet layout: D-rooms,
 * then C-rooms, then W-rooms, then SR. Mirrors DOCTOR_TYPE_ORDER's role
 * in groupDoctors.ts (a fixed, non-alphabetical convention order that
 * every room-ordering call site must share).
 */
export const ROOM_TYPE_ORDER: RoomType[] = ["D", "C", "W", "SR"];

/**
 * Orders two rooms by ROOM_TYPE_ORDER first, then by code within a type
 * (numeric-aware, so "D9" sorts before "D10" if that ever arises) - the
 * single source of truth for room row ordering in the room view, mirroring
 * compareDoctorDisplayOrder in groupDoctors.ts. Deliberately not
 * site-then-code: that would interleave SR into the SHC D-rooms and put
 * Cutteslowe rooms first, neither of which matches the familiar layout.
 */
export function compareRoomDisplayOrder(a: Room, b: Room): number {
  const typeDiff = ROOM_TYPE_ORDER.indexOf(a.room_type) - ROOM_TYPE_ORDER.indexOf(b.room_type);
  if (typeDiff !== 0) return typeDiff;
  return a.code.localeCompare(b.code, undefined, { numeric: true });
}

function roomKey(roomId: number, week: number, day: Day, period: Period): string {
  return `${roomId}:${week}:${day}:${period}`;
}

export interface PivotedRoomGrid {
  /** Rooms in display order - see compareRoomDisplayOrder. Every room from
   * the input list appears here regardless of whether it holds any
   * sessions in this rota, so an unused room reads as a full row of
   * "Available" rather than disappearing. */
  rows: Room[];
  /**
   * Cell lookup, keyed by (room, week, day, period). A missing key means
   * the room is free in that slot - the room-view equivalent of pivot.ts's
   * "absent cell" state, except here absence is the common case, not the
   * exception.
   *
   * Invariant: at most one session holds a given room in a given slot.
   * This is enforced elsewhere, not by this map - the engine's
   * `_room_occupancy` index guarantees it at generation time, and every
   * room-writing edit endpoint preserves it afterwards: `set-room`
   * displaces any existing holder via `_find_room_holder` before
   * assigning, `swap-rooms` exchanges two holders atomically, and
   * `set-role` only ever clears a room, never assigns one. Should that
   * invariant ever be violated, this map silently keeps the
   * last-processed session for a key (Map.set overwrite) - that is a
   * documented reliance on the invariant holding, not a case this
   * function detects or handles.
   */
  cells: Map<string, RotaSession>;
}

/**
 * Builds the pivoted room-occupancy grid for one rota. `rooms` should be
 * the full room list - every room is shown as a row whether or not it
 * appears in `sessions`, since an unoccupied room is exactly what this
 * view exists to surface as available.
 *
 * Sessions with `room_id === null` are skipped: they have no home in a
 * room-keyed view. Any unresolved-room warning for such a session
 * surfaces via the IssuesPanel, not here.
 */
export function pivotRoomRota(sessions: RotaSession[], rooms: Room[]): PivotedRoomGrid {
  const cells = new Map<string, RotaSession>();

  for (const session of sessions) {
    if (session.room_id === null) continue;
    cells.set(roomKey(session.room_id, session.week, session.day, session.period), session);
  }

  const rows = [...rooms].sort(compareRoomDisplayOrder);

  return { rows, cells };
}

export function getRoomCell(
  grid: PivotedRoomGrid,
  roomId: number,
  week: number,
  day: Day,
  period: Period,
): RotaSession | undefined {
  return grid.cells.get(roomKey(roomId, week, day, period));
}
