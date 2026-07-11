import type { Day, MasterSessionType, Period } from "@/api/types";

/**
 * Master-template undo entry. Deliberately NOT a member of the rota
 * UndoEntry union and NOT routed through replayUndo.ts's
 * buildReplayRequest - that function is rota-scoped (every branch takes
 * a rotaId and builds RotaSession-shaped mutation payloads). The master
 * template's three write endpoints (PATCH/POST/DELETE) have their own,
 * much smaller replay logic below.
 *
 * M4.4 Task 3 widens this from a single shape (PATCH-only) into a
 * discriminated union, mirroring lib/undoStack.ts's UndoEntry "kind"
 * convention: "edit" is the original M4.3 shape unchanged (renamed to
 * MasterEditUndoEntry), "create"/"delete" are new. Note on scope: the
 * plan attributes the full undo/replay wiring to a later "Task 4", but
 * MasterRotaGrid's create/delete handlers (this task) have a hard
 * compile-time dependency on typed entries to pass to onMutationApplied
 * - so the type definitions, message helpers, and replay-step building
 * below are implemented now, out of strict task order, rather than
 * leaving the grid unable to type-check. MasterRotaPage's handleUndo is
 * updated to match (see that file) so the app stays in a working state
 * end-to-end; treat this as provisional pending Task 4's own review
 * (toast wording, replay ordering assumptions) rather than a closed
 * decision.
 *
 * previous/displaced/deleted are captured from the grid's pre-mutation
 * session objects at click time, same convention as the rota entries in
 * undoStack.ts.
 */
export interface MasterEditUndoEntry {
  kind: "edit";
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
  /** The session the forward create produced - undo deletes it. */
  createdSessionId: number;
  /** Same shape/semantics as MasterEditUndoEntry.displaced - a session
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
  /** Full pre-delete session data - undo recreates it via POST with
   * these exact fields. "Remove session" (the forward action) is a
   * direct, unconfirmed, non-steal action (M4.4 Task 3), so there is no
   * displaced session to also restore here. */
  deleted: {
    doctorId: number;
    week: number;
    day: Day;
    period: Period;
    sessionType: MasterSessionType;
    roomId: number | null;
  };
}

export type MasterUndoEntry = MasterEditUndoEntry | MasterCreateUndoEntry | MasterDeleteUndoEntry;

export type MasterReplayStep =
  | { action: "patch"; sessionId: number; sessionType: MasterSessionType; roomId: number | null }
  | { action: "create"; doctorId: number; week: number; day: Day; period: Period; sessionType: MasterSessionType; roomId: number | null }
  | { action: "delete"; sessionId: number };

/**
 * Builds the ordered replay actions for any MasterUndoEntry kind.
 *
 * "edit": displaced first, then target - the original M4.3 ordering
 * (restore the session that got stolen from before restoring the one
 * that did the stealing). Restoring the displaced session to
 * PRE_ASSIGNED + its room will itself auto-displace the target
 * server-side (still holding that room from the forward edit) - harmless,
 * because the very next step overwrites the target with its exact
 * previous pair, which is not the room that was just re-displaced.
 *
 * "create": same displaced-first rationale applies - restoring the
 * displaced session's room will auto-displace the still-live created
 * session (clearing its room), which is immaterial since the following
 * step deletes that row outright.
 *
 * "delete": a single recreate step - "Remove session" never displaces
 * anything (direct action, no room-steal concept for a plain removal),
 * so there is nothing else to restore.
 */
export function buildMasterReplaySteps(entry: MasterUndoEntry): MasterReplayStep[] {
  if (entry.kind === "edit") {
    const steps: MasterReplayStep[] = [];
    if (entry.displaced) {
      steps.push({
        action: "patch",
        sessionId: entry.displaced.sessionId,
        sessionType: entry.displaced.sessionType,
        roomId: entry.displaced.roomId,
      });
    }
    steps.push({
      action: "patch",
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
        action: "patch",
        sessionId: entry.displaced.sessionId,
        sessionType: entry.displaced.sessionType,
        roomId: entry.displaced.roomId,
      });
    }
    steps.push({ action: "delete", sessionId: entry.createdSessionId });
    return steps;
  }

  return [
    {
      action: "create",
      doctorId: entry.deleted.doctorId,
      week: entry.deleted.week,
      day: entry.deleted.day,
      period: entry.deleted.period,
      sessionType: entry.deleted.sessionType,
      roomId: entry.deleted.roomId,
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