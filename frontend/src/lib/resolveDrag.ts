import type { RotaSession } from "@/api/types";

import { type ChipType, canDrop } from "./dragRules";
import type { UndoEntry } from "./undoStack";

export interface ActiveChip {
  type: ChipType;
  session: RotaSession;
}

export interface DropTarget {
  session: RotaSession;
}

export interface DragOutcome {
  chipType: ChipType;
  sessionAId: number;
  sessionBId: number;
  undoEntry: UndoEntry;
}

/**
 * Pure resolution of a dnd-kit onDragEnd event's active/over data into
 * either nothing to do, or a swap-roles/swap-rooms call to dispatch.
 * Kept separate from RotaGrid's handleDragEnd specifically so this logic
 * - the actual eligibility and self-drop guards - is unit-testable
 * without needing real dnd-kit pointer simulation, which requires
 * bounding rects jsdom doesn't provide.
 */
export function resolveDragOutcome(
  active: ActiveChip | undefined,
  over: DropTarget | undefined,
): DragOutcome | null {
  if (!active || !over) return null;
  if (active.session.session_id === over.session.session_id) return null;
  if (!canDrop(active.type, active.session, over.session)) return null;

  return {
    chipType: active.type,
    sessionAId: active.session.session_id,
    sessionBId: over.session.session_id,
    undoEntry: {
      kind: active.type === "role" ? "swap-roles" : "swap-rooms",
      sessionAId: active.session.session_id,
      sessionBId: over.session.session_id,
    },
  };
}