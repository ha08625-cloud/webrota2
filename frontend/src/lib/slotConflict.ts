import type { Day, MasterRotaSession, Period, RotaSession, SessionRole } from "@/api/types";

/**
 * Advisory only: used to decide whether the cell edit menu shows the
 * confirm-before-steal panel and to name the current holder in it. The
 * backend's own displacement lookup (set-room/set-role) remains the
 * source of truth for what actually happens - a stale client-side miss
 * here just means a displacement happens without a confirm, which the
 * response's displaced_session and the resulting toast still surface.
 */
export function findRoomHolder(
  sessions: RotaSession[],
  week: number,
  day: Day,
  period: Period,
  roomId: number,
  excludeSessionId: number,
): RotaSession | undefined {
  return sessions.find(
    (s) =>
      s.session_id !== excludeSessionId &&
      s.week === week &&
      s.day === day &&
      s.period === period &&
      s.room_id === roomId,
  );
}

/**
 * clinicTypeId: pass null to match on role alone (duty steal); pass a
 * clinic type id to also require the same clinic_type_id (clinic-type
 * steal). Mirrors the backend's _find_role_holder displacement rule
 * exactly - see set_role's docstring in routers/rota.py.
 */
export function findRoleHolder(
  sessions: RotaSession[],
  week: number,
  day: Day,
  period: Period,
  role: SessionRole,
  clinicTypeId: number | null,
  excludeSessionId: number,
): RotaSession | undefined {
  return sessions.find(
    (s) =>
      s.session_id !== excludeSessionId &&
      s.week === week &&
      s.day === day &&
      s.period === period &&
      s.role === role &&
      (clinicTypeId === null || s.clinic_type_id === clinicTypeId),
  );
}

/**
 * Master-template equivalent of findRoomHolder. Not a reuse of the
 * RotaSession-typed helper above - MasterRotaSession shares only the
 * (week, day, period, room_id) shape, none of the rota-only fields, and
 * forcing one generic helper to serve both would need a wider parameter
 * type that gains nothing (M4.3 Task 3 review). Same advisory-only
 * caveat: the backend's own displacement lookup in the PATCH/POST
 * endpoints is the source of truth.
 *
 * excludeSessionId is nullable (M4.4 Task 3): create mode has no self
 * row yet, so every session already in the slot holding the room counts
 * as a holder, matching the backend POST's exclude_id=None behaviour.
 */
export function findMasterRoomHolder(
  sessions: MasterRotaSession[],
  week: number,
  day: Day,
  period: Period,
  roomId: number,
  excludeSessionId: number | null,
): MasterRotaSession | undefined {
  return sessions.find(
    (s) =>
      s.session_id !== excludeSessionId &&
      s.week === week &&
      s.day === day &&
      s.period === period &&
      s.room_id === roomId,
  );
}