import { useCallback, useRef, useState } from "react";

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
    };

/**
 * Single-level, client-side undo. A new entry always overwrites the
 * previous one - this is a "did I just mess that up" convenience, not an
 * edit history, and a page refresh loses it (both deliberate, per the M4
 * plan).
 *
 * `current` (state) drives the Undo button's visibility/enabled state.
 * `ref` mirrors it for consume() - reading and clearing in one call
 * without depending on when a setState updater callback happens to run,
 * which is an implementation-detail timing guarantee rather than a
 * documented one worth relying on here.
 */
export function useUndoStack() {
  const [current, setCurrent] = useState<UndoEntry | null>(null);
  const ref = useRef<UndoEntry | null>(null);

  const push = useCallback((entry: UndoEntry) => {
    ref.current = entry;
    setCurrent(entry);
  }, []);

  const consume = useCallback((): UndoEntry | null => {
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