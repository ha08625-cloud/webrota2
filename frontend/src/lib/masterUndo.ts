import type { Day, MasterSessionType, Period } from "@/api/types";

/**
 * Master-template undo entry. Deliberately NOT a member of the rota
 * UndoEntry union and NOT routed through replayUndo.ts's
 * buildReplayRequest - that function is rota-scoped (every branch takes
 * a rotaId and builds RotaSession-shaped mutation payloads). The master
 * template has exactly one write endpoint (the session PATCH), so its
 * replay has no branching to share with the rota's four-mutation-type
 * replay logic in the first place.
 *
 * previous/displaced are captured from the grid's pre-mutation session
 * objects at click time, same convention as the rota entries in
 * undoStack.ts.
 */
export interface MasterUndoEntry {
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

export interface MasterReplayStep {
  sessionId: number;
  sessionType: MasterSessionType;
  roomId: number | null;
}

/**
 * Displaced first, then target - the same replayUndo.ts ordering
 * convention (restore the session that got stolen from before restoring
 * the one that did the stealing). Restoring the displaced session to
 * PRE_ASSIGNED + its room will itself auto-displace the target
 * server-side (still holding that room from the forward edit) - harmless,
 * because the very next step overwrites the target with its exact
 * previous pair, which is not the room that was just re-displaced.
 */
export function buildMasterReplaySteps(entry: MasterUndoEntry): MasterReplayStep[] {
  const steps: MasterReplayStep[] = [];
  if (entry.displaced) {
    steps.push({
      sessionId: entry.displaced.sessionId,
      sessionType: entry.displaced.sessionType,
      roomId: entry.displaced.roomId,
    });
  }
  steps.push({
    sessionId: entry.sessionId,
    sessionType: entry.previous.sessionType,
    roomId: entry.previous.roomId,
  });
  return steps;
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
