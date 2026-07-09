import type { PatchSessionPayload, SwapPayload } from "@/api/rota";
import type { UndoEntry } from "@/lib/undoStack";

/**
 * The replay request for one UndoEntry. swap-roles/swap-rooms repeat the
 * identical call with the same two session ids - both endpoints are
 * self-inverse for swaps and moves alike (see rota.ts docstrings on
 * useSwapRoles/useSwapRooms). patch replays with the entry's *previous*
 * is_wfh/notes, restoring the pre-edit state rather than repeating
 * anything.
 */
export type ReplayRequest =
  | { kind: "swap-roles" | "swap-rooms"; payload: SwapPayload }
  | { kind: "patch"; payload: PatchSessionPayload };

export function buildReplayRequest(entry: UndoEntry, rotaId: number): ReplayRequest {
  if (entry.kind === "swap-roles" || entry.kind === "swap-rooms") {
    return {
      kind: entry.kind,
      payload: { rotaId, sessionAId: entry.sessionAId, sessionBId: entry.sessionBId },
    };
  }

  return {
    kind: "patch",
    payload: {
      rotaId,
      sessionId: entry.sessionId,
      isWfh: entry.previousIsWfh,
      notes: entry.previousNotes,
    },
  };
}