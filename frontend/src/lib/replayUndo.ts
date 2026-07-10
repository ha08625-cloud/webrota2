import type { PatchSessionPayload, SetRolePayload, SetRoomPayload, SwapPayload } from "@/api/rota";
import type { UndoEntry } from "@/lib/undoStack";

/**
 * The replay request(s) for one UndoEntry. swap-roles/swap-rooms repeat
 * the identical call with the same two session ids - both endpoints are
 * self-inverse for swaps and moves alike (see rota.ts docstrings on
 * useSwapRoles/useSwapRooms). patch replays with the entry's *previous*
 * is_wfh/notes, restoring the pre-edit state rather than repeating
 * anything.
 *
 * set-room and set-role can replay as up to two/three calls -
 * buildReplayRequest returns the full sequence (length 1 for the three
 * pre-M4.1 kinds, more for the two new ones) so RotaDetailPage can
 * execute it serially. Ordering rule: restore the displaced session
 * first, then the target - see set-room/set-role below.
 *
 * patch's own possible room-restore follow-up is deliberately NOT part
 * of this pre-built sequence: whether it's needed depends on the PATCH
 * replay's actual response (is_wfh clearing the room is a function of
 * the *forward* edit's target value, which the entry doesn't carry), so
 * RotaDetailPage inspects that response directly, the same way it always
 * has - see its handleUndo.
 */
export type ReplayRequest =
  | { kind: "swap-roles" | "swap-rooms"; payload: SwapPayload }
  | { kind: "patch"; payload: PatchSessionPayload }
  | { kind: "set-room"; payload: SetRoomPayload }
  | { kind: "set-role"; payload: SetRolePayload };

export function buildReplayRequest(entry: UndoEntry, rotaId: number): ReplayRequest[] {
  // Branch on the single-literal members ("patch", "set-room", "set-role")
  // before the swap/move member (whose discriminant is itself a union of
  // two literals, "swap-roles" | "swap-rooms") - TypeScript's
  // discriminated-union narrowing does not reliably exclude a
  // union-of-literals member from the negated/else branch of an `||`
  // check, so branching on each single-literal member first sidesteps
  // that rather than working around it with a type assertion.
  if (entry.kind === "patch") {
    return [
      {
        kind: "patch",
        payload: {
          rotaId,
          sessionId: entry.sessionId,
          isWfh: entry.previousIsWfh,
          notes: entry.previousNotes,
        },
      },
    ];
  }

  if (entry.kind === "set-room") {
    const requests: ReplayRequest[] = [];
    if (entry.displaced) {
      requests.push({
        kind: "set-room",
        payload: { rotaId, sessionId: entry.displaced.sessionId, roomId: entry.displaced.roomId },
      });
    }
    // WFH implies the previous room was null (the PATCH invariant), and
    // setting WFH back on clears whatever room the forward op assigned -
    // so restoring WFH via PATCH is sufficient; no set-room call is
    // needed for the target at all in that branch.
    if (entry.previousIsWfh) {
      requests.push({
        kind: "patch",
        payload: { rotaId, sessionId: entry.sessionId, isWfh: true, notes: entry.previousNotes },
      });
    } else {
      requests.push({
        kind: "set-room",
        payload: { rotaId, sessionId: entry.sessionId, roomId: entry.previousRoomId },
      });
    }
    return requests;
  }

  if (entry.kind === "set-role") {
    const requests: ReplayRequest[] = [];
    if (entry.displaced) {
      requests.push({
        kind: "set-role",
        payload: {
          rotaId,
          sessionId: entry.displaced.sessionId,
          triple: {
            role: entry.displaced.role,
            clinicTypeId: entry.displaced.clinicTypeId,
            templateType: entry.displaced.templateType,
          },
        },
      });
    }
    requests.push({
      kind: "set-role",
      payload: {
        rotaId,
        sessionId: entry.sessionId,
        triple: {
          role: entry.previous.role,
          clinicTypeId: entry.previous.clinicTypeId,
          templateType: entry.previous.templateType,
        },
      },
    });
    // roomWasCleared is captured at push time (RotaGrid.handleSetRole),
    // from the forward mutation's own response - it is true only when
    // the forward pick was a template shape (no_surgery/admin_time) that
    // triggered the server's auto-clear rule. Restoring the previous
    // triple in the call above never itself restores a room (set-role
    // only ever clears room_id, never sets it), so an explicit set-room
    // call is the only way to get it back.
    if (entry.roomWasCleared && entry.previous.roomId !== null) {
      requests.push({
        kind: "set-room",
        payload: { rotaId, sessionId: entry.sessionId, roomId: entry.previous.roomId },
      });
    }
    return requests;
  }

  return [
    {
      kind: entry.kind,
      payload: { rotaId, sessionAId: entry.sessionAId, sessionBId: entry.sessionBId },
    },
  ];
}