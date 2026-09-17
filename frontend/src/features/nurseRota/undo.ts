import type { Day, MasterRotaSession, MasterSessionType, Period } from "@/api/types";

import type { NurseSessionType } from "./types";

/**
 * Single-level undo for the Nurse Rota, cloned from `lib/masterUndo.ts`
 * (DD11) rather than shared with it. `lib/undoStack.ts` is generic and is
 * reused unchanged; only the entry shapes and the replay builder are the
 * section's own.
 *
 * Staging skipped undo because its recovery path is abandon-and-restart.
 * This surface has no such path - a mis-click edits the live template
 * directly - and it is read by the least technical audience in the
 * building, so it gets one.
 *
 * Two differences from the master version:
 *
 * 1. Replay steps carry no `templateId`. The nurse endpoints resolve the
 *    active template themselves (DD11a), so there is nothing to thread
 *    through.
 * 2. `displaced` is only ever ANOTHER NURSE. A non-nurse holder is
 *    refused outright with a 409 (DD5) and the popover will not even
 *    offer their room, so no replay step can ever try to move a doctor.
 *
 * Both entry kinds that can carry a room use `NurseSessionType`, not
 * `MasterSessionType`: the router accepts three of the five types and
 * 422s the other two (DD6), so a replay step that could name
 * `requires_room` or `wfh` would be an undo that cannot run. The builders
 * below are the place that rule is enforced - see `asNurseSessionType`.
 */

export interface NursePatchUndoEntry {
  kind: "patch";
  sessionId: number;
  previous: { sessionType: NurseSessionType; roomId: number | null };
  displaced: NurseDisplacedSnapshot | null;
}

export interface NurseCreateUndoEntry {
  kind: "create";
  /** The session id from the POST response - undo deletes it. */
  createdSessionId: number;
  displaced: NurseDisplacedSnapshot | null;
}

export interface NurseDeleteUndoEntry {
  kind: "delete";
  /** The deleted row's slot coordinates - undo recreates a row there via
   * POST. Flat rather than nested, as in the master version: "Remove
   * session" is a direct, unconfirmed action that never displaces
   * anything, so there is no displaced sibling to carry alongside. */
  doctorId: number;
  week: number;
  day: Day;
  period: Period;
  previous: { sessionType: NurseSessionType; roomId: number | null };
}

/** A nurse bumped out of a room by the forward edit. */
export interface NurseDisplacedSnapshot {
  sessionId: number;
  /** The PRE-displacement type - what the row was set to *before* the
   * forward edit took its room, not what the write response left it as.
   * The backend turns a displaced PRE_ASSIGNED into REQUIRES_ROOM, and
   * REQUIRES_ROOM is exactly what this router will not accept back, so
   * undo has to restore the original. */
  sessionType: NurseSessionType;
  roomId: number | null;
}

export type NurseUndoEntry = NursePatchUndoEntry | NurseCreateUndoEntry | NurseDeleteUndoEntry;

export type NurseReplayStep =
  | { op: "patch"; sessionId: number; sessionType: NurseSessionType; roomId: number | null }
  | {
      op: "create";
      doctorId: number;
      week: number;
      day: Day;
      period: Period;
      sessionType: NurseSessionType;
      roomId: number | null;
    }
  | { op: "delete"; sessionId: number };

const NURSE_SESSION_TYPES: readonly string[] = ["pre_assigned", "admin_time", "no_surgery"];

/**
 * The nurse-writable narrowing of a session type, or null when there
 * isn't one.
 *
 * Null means `requires_room` or `wfh`, which the Master Rota can write to
 * a nurse row (it is a permissive verbatim writer) but this router 422s.
 * Rather than coerce such a row to some nearby type - which would make
 * "Undo" silently change data instead of restoring it - the builders
 * below return no entry at all, and the page clears the stack.
 */
export function asNurseSessionType(sessionType: MasterSessionType): NurseSessionType | null {
  return NURSE_SESSION_TYPES.includes(sessionType) ? (sessionType as NurseSessionType) : null;
}

function restorablePair(
  session: MasterRotaSession,
): { sessionType: NurseSessionType; roomId: number | null } | null {
  const sessionType = asNurseSessionType(session.session_type);
  return sessionType === null ? null : { sessionType, roomId: session.room_id };
}

/**
 * A displaced nurse's pre-displacement snapshot, or null when the row
 * cannot be restored through this router.
 *
 * In practice the null branch is unreachable: a row is only ever
 * displaced because it held a room, and the backend's pair validator
 * forbids a room on `requires_room`, `wfh` and `no_surgery` alike - so a
 * room-holding nurse row is always `pre_assigned` or `admin_time`, both
 * writable here. It is a branch rather than a cast because "unreachable"
 * rests on a validator in another file, and the cost of being wrong is a
 * 422 in the middle of a two-step replay.
 */
function restorableDisplaced(displaced: MasterRotaSession): NurseDisplacedSnapshot | null {
  const pair = restorablePair(displaced);
  return pair === null ? null : { sessionId: displaced.session_id, ...pair };
}

/**
 * The undo entry for a room/type pick, or null if this edit cannot be
 * undone through the nurse endpoints.
 *
 * `session` and `displaced` are the PRE-mutation objects, read off the
 * grid at click time - the same convention as the master grid's push
 * sites, and the only moment the pre-displacement type still exists
 * anywhere.
 */
export function buildNursePatchUndoEntry(
  session: MasterRotaSession,
  displaced: MasterRotaSession | null,
): NursePatchUndoEntry | null {
  const previous = restorablePair(session);
  if (previous === null) return null;

  if (displaced === null) {
    return { kind: "patch", sessionId: session.session_id, previous, displaced: null };
  }
  const snapshot = restorableDisplaced(displaced);
  if (snapshot === null) return null;
  return { kind: "patch", sessionId: session.session_id, previous, displaced: snapshot };
}

/**
 * The undo entry for a created row. Deleting the created row is always
 * expressible, so the only way this returns null is an unrestorable
 * displaced nurse.
 */
export function buildNurseCreateUndoEntry(
  createdSessionId: number,
  displaced: MasterRotaSession | null,
): NurseCreateUndoEntry | null {
  if (displaced === null) {
    return { kind: "create", createdSessionId, displaced: null };
  }
  const snapshot = restorableDisplaced(displaced);
  if (snapshot === null) return null;
  return { kind: "create", createdSessionId, displaced: snapshot };
}

/** The undo entry for a removed row, built from the row itself before the
 * DELETE goes out - there is no response body to read it back from. */
export function buildNurseDeleteUndoEntry(
  session: MasterRotaSession,
): NurseDeleteUndoEntry | null {
  const previous = restorablePair(session);
  if (previous === null) return null;
  return {
    kind: "delete",
    doctorId: session.doctor_id,
    week: session.week,
    day: session.day,
    period: session.period,
    previous,
  };
}

/**
 * Builds the ordered replay steps for any NurseUndoEntry kind.
 * Displaced-first ordering is preserved across all three kinds - restore
 * whatever was stolen from before undoing the action that stole it:
 *
 * "patch": restore the displaced nurse's pair first, then the target's
 * own previous pair. Restoring the displaced row to its room will itself
 * auto-displace the target server-side (it is still holding that room
 * from the forward edit) - harmless, because the very next step
 * overwrites the target with its exact previous pair, which is not the
 * room that was just re-displaced.
 *
 * "create": same rationale - restoring a displaced nurse's room will
 * auto-displace the still-live created row, which is immaterial since the
 * following step deletes it outright.
 *
 * "delete": a single create step recreating the row at its original slot
 * with its previous pair. There is no displaced session to restore first
 * (Remove never displaces anything). If a NURSE has since taken that
 * room, the server displaces them exactly as it would for a fresh
 * create; if a DOCTOR has, the create 409s and the undo reports failure
 * rather than moving them - which is the permission boundary working, not
 * a bug. Under the single-user-per-lock assumption neither is likely.
 * The recreated row gets a new session_id; nothing in the client still
 * references the old one once the cache filter has run.
 */
export function buildNurseReplaySteps(entry: NurseUndoEntry): NurseReplayStep[] {
  if (entry.kind === "patch") {
    const steps: NurseReplayStep[] = [];
    if (entry.displaced) {
      steps.push({
        op: "patch",
        sessionId: entry.displaced.sessionId,
        sessionType: entry.displaced.sessionType,
        roomId: entry.displaced.roomId,
      });
    }
    steps.push({
      op: "patch",
      sessionId: entry.sessionId,
      sessionType: entry.previous.sessionType,
      roomId: entry.previous.roomId,
    });
    return steps;
  }

  if (entry.kind === "create") {
    const steps: NurseReplayStep[] = [];
    if (entry.displaced) {
      steps.push({
        op: "patch",
        sessionId: entry.displaced.sessionId,
        sessionType: entry.displaced.sessionType,
        roomId: entry.displaced.roomId,
      });
    }
    steps.push({ op: "delete", sessionId: entry.createdSessionId });
    return steps;
  }

  return [
    {
      op: "create",
      doctorId: entry.doctorId,
      week: entry.week,
      day: entry.day,
      period: entry.period,
      sessionType: entry.previous.sessionType,
      roomId: entry.previous.roomId,
    },
  ];
}
