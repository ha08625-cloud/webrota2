import { useCallback, useRef, useState } from "react";

import type { MasterSessionType, SessionRole } from "@/api/types";

export type UndoEntry =
  | {
      kind: "swap-roles" | "swap-rooms";
      sessionAId: number;
      sessionBId: number;
    }
  | {
      kind: "patch";
      sessionId: number;
      previousIsWfh: boolean;
      previousNotes: string | null;
      /**
       * Captured unconditionally at patch time, regardless of what the
       * forward patch itself changed - simplest correct behaviour, since
       * the check for whether undo can actually restore the room happens
       * afterwards (see RotaDetailPage), not by predicting in advance
       * whether this particular patch will turn out to be room-destructive.
       */
      previousRoomId: number | null;
      previousRoomCode: string | null;
    }
  | {
      /**
       * M4.1 Task 2. previousIsWfh/previousNotes exist because a room
       * pick can clear is_wfh server-side; restoring it goes through
       * PATCH, which needs both fields. displaced carries only what
       * replay needs to restore the other side (its own previous
       * room_id), not a full session snapshot.
       */
      kind: "set-room";
      sessionId: number;
      previousRoomId: number | null;
      previousIsWfh: boolean;
      previousNotes: string | null;
      displaced: { sessionId: number; roomId: number | null } | null;
    }
  | {
      /**
       * M4.1 Task 2. set-role is a verbatim triple setter, so replay must
       * echo back the full previous (role, clinicTypeId, templateType)
       * triple for both the target and (if present) the displaced
       * session - including previous.roomId, needed only alongside
       * roomWasCleared to decide whether replay needs a trailing
       * set-room call. roomWasCleared is read off the forward mutation's
       * own response (RotaGrid.handleSetRole) rather than re-derived
       * from the triple at replay time - it is true exactly when the
       * server's auto-clear rule fired (role=null, template_type in
       * no_surgery/admin_time), which set-role can only ever do, never
       * undo, so replay must restore the room explicitly when it did.
       */
      kind: "set-role";
      sessionId: number;
      previous: {
        role: SessionRole | null;
        clinicTypeId: number | null;
        templateType: MasterSessionType | null;
        roomId: number | null;
      };
      roomWasCleared: boolean;
      displaced: {
        sessionId: number;
        role: SessionRole | null;
        clinicTypeId: number | null;
        templateType: MasterSessionType | null;
      } | null;
    };

/**
 * Single-level, client-side undo. A new entry always overwrites the
 * previous one - this is a "did I just mess that up" convenience, not an
 * edit history, and a page refresh loses it (both deliberate, per the M4
 * plan).
 *
 * Generic over the entry type (M4.3 Task 4): RotaDetailPage instantiates
 * this as `useUndoStack<UndoEntry>()`, MasterRotaPage as
 * `useUndoStack<MasterUndoEntry>()` (see lib/masterUndo.ts) - the stack
 * itself has no rota-specific behaviour, only push/consume/clear on
 * whatever T the caller pushes.
 *
 * `current` (state) drives the Undo button's visibility/enabled state.
 * `ref` mirrors it for consume() - reading and clearing in one call
 * without depending on when a setState updater callback happens to run,
 * which is an implementation-detail timing guarantee rather than a
 * documented one worth relying on here.
 */
export function useUndoStack<T>() {
  const [current, setCurrent] = useState<T | null>(null);
  const ref = useRef<T | null>(null);

  const push = useCallback((entry: T) => {
    ref.current = entry;
    setCurrent(entry);
  }, []);

  const consume = useCallback((): T | null => {
    const entry = ref.current;
    ref.current = null;
    setCurrent(null);
    return entry;
  }, []);

  const clear = useCallback(() => {
    ref.current = null;
    setCurrent(null);
  }, []);

  return { current, push, consume, clear };
}
