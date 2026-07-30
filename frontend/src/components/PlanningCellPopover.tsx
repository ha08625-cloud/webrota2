import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";
import type { ReactNode } from "react";

import { NOTES_MAX_LENGTH } from "@/lib/planningMonth";
import type { PlanningCellState } from "@/lib/planningMonth";

const STATE_OPTIONS: { value: PlanningCellState; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "leave", label: "Leave" },
  { value: "extra_session", label: "Extra session" },
  { value: "blocked", label: "Blocked" },
];

interface PlanningCellPopoverProps {
  /** The cell's current merged state (server + any pending edit). */
  state: PlanningCellState;
  /** The cell's current merged notes ("" for none). */
  notes: string;
  children: ReactNode;
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
 * A sibling of MasterCellEditPopover/CellEditPopover, not a
 * generalisation - this one has no room submenu, no steal detection, and
 * a four-way mutually exclusive state instead of a five-value session
 * type.
 */
export function PlanningCellPopover({ state, notes, children, onApply }: PlanningCellPopoverProps) {
  const [open, setOpen] = useState(false);
  const [draftState, setDraftState] = useState<PlanningCellState>(state);
  const [draftNotes, setDraftNotes] = useState(notes);

  function handleOpenChange(next: boolean) {
    if (next) {
      // Reset to the cell's current value each time it opens, in case a
      // prior edit elsewhere changed it since last open.
      setDraftState(state);
      setDraftNotes(notes);
    }
    setOpen(next);
  }

  function handleStateChange(next: PlanningCellState) {
    setDraftState(next);
    // Normal has no row to hold a note - clear it so Apply can't send a
    // stale note alongside a clear.
    if (next === "normal") setDraftNotes("");
  }

  function handleApply() {
    onApply(draftState, draftState === "normal" ? "" : draftNotes.trim());
    setOpen(false);
  }

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={5}
          data-testid="planning-cell-popover"
          className="z-50 w-56 rounded border border-border bg-surface p-3 shadow-lg"
        >
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
              onClick={() => setOpen(false)}
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
    </Popover.Root>
  );
}
