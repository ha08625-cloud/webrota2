import type { PreferredRoomIn, RoomType } from "@/api/types";

/**
 * Client-only form-state shape for one preferred-room row. `id` is a
 * stable client-side key (independent of position) so React and
 * dnd-kit can track a row across reorders. Deliberately has no
 * `preference_order` field of its own - see toWireRows for why.
 * Mirrors the `kind` discriminant pattern used for roomEligibilities in
 * Task 5's clinicTypeSchema.ts.
 */
export type PreferredRoomRow =
  | { id: string; kind: "room"; roomId: number }
  | { id: string; kind: "roomType"; roomType: RoomType };

/**
 * Moves the row at `fromIndex` to `toIndex` and returns a new array.
 * Out-of-range indices are clamped rather than throwing, so a caller
 * wiring this to a drag-end event doesn't need its own bounds-checking.
 */
export function moveRow(rows: PreferredRoomRow[], fromIndex: number, toIndex: number): PreferredRoomRow[] {
  const clampedFrom = Math.max(0, Math.min(fromIndex, rows.length - 1));
  const clampedTo = Math.max(0, Math.min(toIndex, rows.length - 1));
  if (clampedFrom === clampedTo || rows.length === 0) {
    return rows;
  }
  const next = [...rows];
  const [moved] = next.splice(clampedFrom, 1);
  next.splice(clampedTo, 0, moved);
  return next;
}

/**
 * Builds the PUT /doctors/{id}/preferred-rooms payload from the current
 * row order.
 *
 * The PUT endpoint 409s on a duplicate preference_order ("Duplicate
 * preference_order or invalid room reference") and the schema requires
 * preference_order >= 1 (PreferredRoomIn.preference_order Field(ge=1)).
 * Rather than storing preference_order as separate mutable state on each
 * row - which reorder/add/remove could each get out of sync with the
 * array's actual order - array position is the single source of truth
 * and preference_order is derived here, and only here, as index + 1.
 * This makes "always contiguous 1..n, never duplicated" a structural
 * property of any array of PreferredRoomRow rather than an invariant a
 * caller has to remember to maintain after every mutation: moveRow,
 * pushing a new row, and filtering one out all just produce a new array,
 * and this function's output is correct for any array it's given.
 */
export function toWireRows(rows: PreferredRoomRow[]): PreferredRoomIn[] {
  return rows.map((row, index) => ({
    preference_order: index + 1,
    room_id: row.kind === "room" ? row.roomId : null,
    room_type: row.kind === "roomType" ? row.roomType : null,
  }));
}