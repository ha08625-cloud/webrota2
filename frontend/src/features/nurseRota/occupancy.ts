import type { Day, Period } from "@/api/types";

import type { NurseSlotOccupancy } from "./types";

/**
 * Who holds `roomId` in this slot, among the NON-nurse rows the nurse
 * page never sees in full.
 *
 * This is `slotConflict.ts`'s `findMasterRoomHolder` re-expressed over
 * the occupancy list instead of over a session array: the nurse page's
 * session array holds nurse rows only, so that helper can only ever
 * answer half the question, and its `MasterRotaSession` signature cannot
 * express the other half.
 *
 * There is no exclude-self parameter, unlike the session-array version.
 * A nurse row is never in the occupancy list, so the caller's own
 * session can never be the holder returned here.
 *
 * Advisory only, same caveat as the helpers it mirrors: the backend's own
 * displacement lookup decides what actually happens, and its 409 is the
 * backstop when this list is stale.
 */
export function findSlotHolder(
  occupancy: NurseSlotOccupancy[],
  week: number,
  day: Day,
  period: Period,
  roomId: number,
): string | null {
  const entry = occupancy.find(
    (o) => o.week === week && o.day === day && o.period === period && o.room_id === roomId,
  );
  return entry?.doctor_code ?? null;
}
