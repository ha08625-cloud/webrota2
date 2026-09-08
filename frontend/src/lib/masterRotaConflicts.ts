import type { Day, MasterRotaSession, Period } from "@/api/types";
import { DAYS, PERIODS } from "@/lib/pivot";

/**
 * One (week, day, period, room) slot held by more than one session in the
 * active master template. This is a genuine data problem, not an advisory
 * warning: the live-edit endpoints (PATCH/POST sessions) already prevent
 * this by displacing the existing holder (see slotConflict.ts's
 * findMasterRoomHolder and routers/master_rota.py's _find_room_holder), so
 * a conflict here can only arise from a path that bypasses that
 * displacement rule - chiefly seed_master_rota.py's bulk CSV import, which
 * writes every row directly with no conflict check at all.
 *
 * Deliberately client-side and derived from whatever session list is
 * already in memory, rather than a backend endpoint: MasterRotaPage's
 * template.sessions is fetched on page load and kept in sync on every
 * mutation (splice-in-place, see api/masterRota.ts), so recomputing this
 * from that list already satisfies "check on page load and on every
 * change" for free, with no extra request.
 */
export interface MasterRotaRoomConflict {
  week: number;
  day: Day;
  period: Period;
  roomId: number;
  roomCode: string;
  sessions: MasterRotaSession[];
}

function conflictKey(session: MasterRotaSession): string {
  return `${session.week}-${session.day}-${session.period}-${session.room_id}`;
}

/**
 * Groups sessions by (week, day, period, room_id) and returns one entry
 * per room held by two or more sessions at once. Sessions with no room
 * (room_id === null) can never conflict and are skipped. Ordering is
 * deterministic - week, then day (Monday-Friday), then period (AM/PM),
 * then room code - so the panel's list doesn't reshuffle across renders.
 */
export function findMasterRotaRoomConflicts(
  sessions: MasterRotaSession[],
): MasterRotaRoomConflict[] {
  const groups = new Map<string, MasterRotaSession[]>();
  for (const session of sessions) {
    if (session.room_id === null) continue;
    const key = conflictKey(session);
    const existing = groups.get(key);
    if (existing) {
      existing.push(session);
    } else {
      groups.set(key, [session]);
    }
  }

  const conflicts: MasterRotaRoomConflict[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [first] = group;
    conflicts.push({
      week: first.week,
      day: first.day,
      period: first.period,
      // Safe: only sessions with a non-null room_id were grouped above.
      roomId: first.room_id as number,
      roomCode: first.room_code ?? "?",
      sessions: group,
    });
  }

  return conflicts.sort((a, b) => {
    if (a.week !== b.week) return a.week - b.week;
    const dayDiff = DAYS.indexOf(a.day) - DAYS.indexOf(b.day);
    if (dayDiff !== 0) return dayDiff;
    if (a.period !== b.period) return PERIODS.indexOf(a.period) - PERIODS.indexOf(b.period);
    return a.roomCode.localeCompare(b.roomCode);
  });
}

/** "Room D1 is assigned to AA and BB (Week 1, Monday AM)" / "... AA, BB and
 * CC ..." for three or more. Mirrors masterUndo.ts's plain-sentence
 * convention - no issues/severity concept exists for the template. */
export function formatMasterRotaRoomConflictMessage(conflict: MasterRotaRoomConflict): string {
  const codes = conflict.sessions.map((s) => s.doctor_code);
  const names =
    codes.length < 2
      ? codes.join("")
      : `${codes.slice(0, -1).join(", ")} and ${codes[codes.length - 1]}`;
  return `Room ${conflict.roomCode} is assigned to ${names} (Week ${conflict.week}, ${conflict.day} ${conflict.period})`;
}