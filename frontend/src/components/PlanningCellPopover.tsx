import * as Popover from "@radix-ui/react-popover";
import { useEffect, useState } from "react";

import { NOTES_MAX_LENGTH } from "@/lib/planningMonth";
import type { PlanningCellState } from "@/lib/planningMonth";

const STATE_OPTIONS: { value: PlanningCellState; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "leave", label: "Leave" },
  { value: "extra_session", label: "Extra session" },
  { value: "blocked", label: "Blocked" },
];

interface PlanningCellPopoverProps {
  /** Whether the popover is showing. Owned by `LeavePlanningGrid`, which
   * opens it on the release of a drag - see below for why this component
   * carries no trigger of its own. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The selection's prefill state (see `LeavePlanningGrid`: the shared
   * state of a uniform selection, "leave" for a mixed one). */
  state: PlanningCellState;
  /** The selection's prefill notes ("" for none). */
  notes: string;
  /** How many cells Apply will write. Shown when more than one, so a
   * ten-cell Apply is never mistaken for a one-cell one. */
  cellCount: number;
  /** Radix has no trigger to return focus to on close, so the grid
   * restores focus to the cell itself here. */
  onCloseAutoFocus?: (event: Event) => void;
  /** Fires once, on Apply - `notes` is trimmed and capped to
   * NOTES_MAX_LENGTH, empty string for "normal" regardless of what was
   * typed (there is no row left to hold it once cleared). */
  onApply: (state: PlanningCellState, notes: string) => void;
}

/**
 * The Annual Planner's cell editor: a dropdown choosing one of
 * normal/leave/extra_session/blocked, plus a free-text notes field
 * (clinical rota, "Blocked" annual planner option). Replaces the old
 * click-to-cycle interaction, which had no way to enter text.
 *
 * Deliberately renders no `Popover.Root` and no `Popover.Trigger`: the
 * grid owns both, because a drag selection has no single trigger element
 * to hang off (see `LeavePlanningGrid`'s module docstring). This is the
 * popover *body* only, and must be rendered inside the grid's Root.
 *
 * A sibling of MasterCellEditPopover/CellEditPopover, not a
 * generalisation - this one has no room submenu, no steal detection, and
 * a four-way mutually exclusive state instead of a five-value session
 * type.
 */
export function PlanningCellPopover({
  open,
  onOpenChange,
  state,
  notes,
  cellCount,
  onCloseAutoFocus,
  onApply,
}: PlanningCellPopoverProps) {
  const [draftState, setDraftState] = useState<PlanningCellState>(state);
  const [draftNotes, setDraftNotes] = useState(notes);

  // Reset to the selection's current value whenever the popover opens, or
  // whenever the selection is extended while it is open (shift+click).
  // This cannot hang off `onOpenChange` any more: the grid opens the
  // popover programmatically on mouse-up, so Radix never reports the
  // open transition. Typing in the fields changes neither prop, so an
  // in-progress edit is never clobbered.
  useEffect(() => {
    if (!open) return;
    setDraftState(state);
    setDraftNotes(notes);
  }, [open, state, notes]);

  function handleStateChange(next: PlanningCellState) {
    setDraftState(next);
    // Normal has no row to hold a note - clear it so Apply can't send a
    // stale note alongside a clear.
    if (next === "normal") setDraftNotes("");
  }

  function handleApply() {
    onApply(draftState, draftState === "normal" ? "" : draftNotes.trim());
  }

  return (
    <Popover.Portal>
      <Popover.Content
        sideOffset={5}
        data-testid="planning-cell-popover"
        onCloseAutoFocus={onCloseAutoFocus}
        onPointerDownOutside={(event) => {
          // Shift+click on another cell extends the selection rather than
          // dismissing (LeavePlanningGrid, DD7). Radix's document-level
          // pointerdown runs before React's own mousedown handler, so
          // without this the anchor would already be cleared by the time
          // the extend handler ran.
          if ((event.detail.originalEvent as PointerEvent).shiftKey) event.preventDefault();
        }}
        className="z-50 w-56 rounded border border-border bg-surface p-3 shadow-lg"
      >
        {cellCount > 1 ? (
          <p data-testid="planning-cell-selection-count" className="mb-2 text-xs text-ink/60">
            {cellCount} cells selected
          </p>
        ) : null}
        <label className="block text-xs font-medium text-ink/70">
          Status
          <select
            data-testid="planning-cell-state-select"
            value={draftState}
            onChange={(e) => handleStateChange(e.target.value as PlanningCellState)}
            className="mt-1 block w-full rounded border border-border px-2 py-1 text-sm"
          >
            {STATE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="mt-2 block text-xs font-medium text-ink/70">
          Notes
          <input
            data-testid="planning-cell-notes-input"
            type="text"
            value={draftNotes}
            maxLength={NOTES_MAX_LENGTH}
            disabled={draftState === "normal"}
            onChange={(e) => setDraftNotes(e.target.value)}
            className="mt-1 block w-full rounded border border-border px-2 py-1 text-sm disabled:bg-ink/5 disabled:text-ink/30"
            placeholder="Optional"
          />
        </label>
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded px-3 py-1 text-sm text-ink/70"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="planning-cell-apply"
            onClick={handleApply}
            className="rounded bg-accent px-3 py-1 text-sm font-medium text-white"
          >
            Apply
          </button>
        </div>
        <Popover.Arrow className="fill-surface" />
      </Popover.Content>
    </Popover.Portal>
  );
}
