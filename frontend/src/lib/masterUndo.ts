import type { Day, MasterSessionType, Period } from "@/api/types";

/**
 * Master-template undo entry. Deliberately NOT a member of the rota
 * UndoEntry union and NOT routed through replayUndo.ts's
 * buildReplayRequest - that function is rota-scoped (every branch takes
 * a rotaId and builds RotaSession-shaped mutation payloads). The master
 * template's three write endpoints (PATCH/POST/DELETE) have their own,
 * much smaller replay logic below.
 *
 * A discriminated union (M4.4 Task 4), mirroring lib/undoStack.ts's
 * UndoEntry "kind" convention: "patch" is the M4.3 shape (renamed from
 * an interim "edit" used while this was being built ahead of the plan's
 * own task order - see Task 3's note, now resolved by this task's exact
 * naming), "create"/"delete" are new. previous/displaced are captured
 * from the grid's pre-mutation session objects at click time, same
 * convention as the rota entries in undoStack.ts.
 */
export interface MasterPatchUndoEntry {
  kind: "patch";
  sessionId: number;
  previous: { sessionType: MasterSessionType; roomId: number | null };
  displaced: {
    sessionId: number;
    /** Pre-displacement type - what the displaced session was set to
     * *before* the forward edit stole its room, not what the PATCH
     * response left it as (a displaced PRE_ASSIGNED becomes
     * REQUIRES_ROOM server-side; undo must restore the original type). */
    sessionType: MasterSessionType;
    roomId: number | null;
  } | null;
}

export interface MasterCreateUndoEntry {
  kind: "create";
  /** The session id from the POST response - undo deletes it. */
  createdSessionId: number;
  /** Same shape/semantics as MasterPatchUndoEntry.displaced - a session
   * displaced by the create, if any, restored before the created row is
   * deleted (see buildMasterReplaySteps for the ordering rationale). */
  displaced: {
    sessionId: number;
    sessionType: MasterSessionType;
    roomId: number | null;
  } | null;
}

export interface MasterDeleteUndoEntry {
  kind: "delete";
  /** The deleted session's slot coordinates - undo recreates a row at
   * this exact slot via POST. Flat, not nested (unlike patch/create's
   * displaced), since there's only ever one thing to restore here: the
   * "Remove session" forward action is direct/unconfirmed and never
   * displaces anything (M4.4 Task 3), so there's no displaced sibling
   * to also carry. */
  doctorId: number;
  week: number;
  day: Day;
  period: Period;
  previous: { sessionType: MasterSessionType; roomId: number | null };
}

export type MasterUndoEntry = MasterPatchUndoEntry | MasterCreateUndoEntry | MasterDeleteUndoEntry;

export type MasterReplayStep =
  | { op: "patch"; sessionId: number; sessionType: MasterSessionType; roomId: number | null }
  | { op: "create"; doctorId: number; week: number; day: Day; period: Period; sessionType: MasterSessionType; roomId: number | null }
  | { op: "delete"; sessionId: number };

/**
 * Builds the ordered replay steps for any MasterUndoEntry kind.
 * Displaced-first ordering is preserved across all three kinds - restore
 * whatever was stolen from before undoing the action that stole it:
 *
 * "patch": the original M4.3 ordering - restore the displaced session's
 * pair, then the target's own previous pair. Restoring the displaced
 * session to PRE_ASSIGNED + its room will itself auto-displace the
 * target server-side (still holding that room from the forward edit) -
 * harmless, because the very next step overwrites the target with its
 * exact previous pair, which is not the room that was just re-displaced.
 *
 * "create": same rationale - restoring a displaced session's room will
 * auto-displace the still-live created session (clearing its room),
 * which is immaterial since the following step deletes that row
 * outright.
 *
 * "delete": a single create step recreating the row at its original
 * slot with its previous pair. There is no displaced session to restore
 * first (Remove never displaces anything). If another session has since
 * taken that room, the server's own displacement rule fires exactly as
 * it would for a fresh create - acceptable under the single-user
 * assumption. The recreated row gets a new session_id; nothing in the
 * client still references the old one after the cache filter ran, so
 * this is safe.
 */
export function buildMasterReplaySteps(entry: MasterUndoEntry): MasterReplayStep[] {
  if (entry.kind === "patch") {
    const steps: MasterReplayStep[] = [];
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
    const steps: MasterReplayStep[] = [];
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

const SESSION_TYPE_LABEL: Record<MasterSessionType, string> = {
  requires_room: "Normal clinic",
  pre_assigned: "Pre-assigned",
  admin_time: "Admin time",
  no_surgery: "No surgery",
  wfh: "WFH",
};

/**
 * "AB Monday AM set to Pre-assigned D1" / "AB Monday AM set to No
 * surgery". No issues concept on the template (Phase 12 doesn't run
 * here - see the router docstring), so this is a plain description of
 * what changed, not mutationAppliedMessage's before/after issue-count
 * delta.
 */
export function masterMutationAppliedMessage(
  doctorCode: string,
  day: Day,
  period: Period,
  sessionType: MasterSessionType,
  roomCode: string | null,
): string {
  const label = SESSION_TYPE_LABEL[sessionType];
  const withRoom = roomCode ? `${label} ${roomCode}` : label;
  return `${doctorCode} ${day} ${period} set to ${withRoom}`;
}

/** "AB Monday AM session added (No surgery)" / "AB Monday AM session
 * added (Pre-assigned D1)" (M4.4 Task 3). */
export function masterSessionCreatedMessage(
  doctorCode: string,
  day: Day,
  period: Period,
  sessionType: MasterSessionType,
  roomCode: string | null,
): string {
  const label = SESSION_TYPE_LABEL[sessionType];
  const withRoom = roomCode ? `${label} ${roomCode}` : label;
  return `${doctorCode} ${day} ${period} session added (${withRoom})`;
}

/** "AB Monday AM session removed" (M4.4 Task 3). */
export function masterSessionDeletedMessage(doctorCode: string, day: Day, period: Period): string {
  return `${doctorCode} ${day} ${period} session removed`;
}