import * as Popover from "@radix-ui/react-popover";
import { useEffect, useState } from "react";

import type { ExtraSessionCompensation } from "@/api/types";
import { NOTES_MAX_LENGTH } from "@/lib/planningMonth";
import type { PlanningCellState } from "@/lib/planningMonth";

const STATE_OPTIONS: { value: PlanningCellState; label: string }[] = [
  // Leave first: it is by far the commonest choice in the planner.
  { value: "leave", label: "Leave" },
  { value: "extra_session", label: "Extra session" },
  { value: "normal", label: "Normal" },
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
  /** The selection's prefill compensation, or null when it is not showing
   * an extra session - the field is only rendered for one. */
  compensation: ExtraSessionCompensation | null;
  /**
   * Whether the selected doctor's type has a leave entitlement for a TOIL
   * credit to land in. The grid's selection is single-doctor by
   * construction, so this is never ambiguous. False disables TOIL with the
   * reason stated, so the bulk endpoint's `toil_not_entitled` skip is not
   * the first line of defence.
   */
  toilAllowed: boolean;
  /** The selected doctor's type, purely to name it in that reason. */
  doctorTypeLabel: string;
  /** How many cells Apply will write. Shown when more than one, so a
   * ten-cell Apply is never mistaken for a one-cell one. */
  cellCount: number;
  /** Radix has no trigger to return focus to on close, so the grid
   * restores focus to the cell itself here. */
  onCloseAutoFocus?: (event: Event) => void;
  /** Fires once, on Apply - `notes` is trimmed and capped to
   * NOTES_MAX_LENGTH, empty string for "normal" regardless of what was
   * typed (there is no row left to hold it once cleared), and
   * `compensation` is null for every state but "extra_session". */
  onApply: (
    state: PlanningCellState,
    notes: string,
    compensation: ExtraSessionCompensation | null,
  ) => void;
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
 * **Compensation** is rendered only while the draft state is
 * "extra_session" - it is the one state it means anything for, and a
 * permanently visible select would read as a fourth thing a cell can be.
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
  compensation,
  toilAllowed,
  doctorTypeLabel,
  cellCount,
  onCloseAutoFocus,
  onApply,
}: PlanningCellPopoverProps) {
  const [draftState, setDraftState] = useState<PlanningCellState>(state);
  const [draftNotes, setDraftNotes] = useState(notes);
  // Payment for a cell that is not currently an extra session: it is the
  // status quo and the commoner case, and it is what the server writes for
  // a new row either way.
  const [draftCompensation, setDraftCompensation] = useState<ExtraSessionCompensation>(
    compensation ?? "Payment",
  );

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
    setDraftCompensation(compensation ?? "Payment");
  }, [open, state, notes, compensation]);

  function handleStateChange(next: PlanningCellState) {
    setDraftState(next);
    // Normal has no row to hold a note - clear it so Apply can't send a
    // stale note alongside a clear.
    if (next === "normal") setDraftNotes("");
  }

  function handleApply() {
    onApply(
      draftState,
      draftState === "normal" ? "" : draftNotes.trim(),
      draftState === "extra_session" ? draftCompensation : null,
    );
  }

  // A selection on a doctor with no entitlement can still hold a TOIL row
  // (the type was changed under it), so the option is disabled rather than
  // removed - otherwise the select would silently show Payment for a row
  // that says TOIL. Apply is blocked instead, with the reason on screen.
  const toilBlocked = draftState === "extra_session" && draftCompensation === "TOIL" && !toilAllowed;

  return (
    <Popover.Portal>
      <Popover.Content
        sideOffset={5}
        data-testid="planning-cell-popover"
        onCloseAutoFocus={onCloseAutoFocus}
        onPointerDownOutside={(event) => {
          // Shift+click on another cell extends the selection rather than
          // dismissing (see LeavePlanningGrid). Radix's document-level
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
        {draftState === "extra_session" ? (
          <label className="mt-2 block text-xs font-medium text-ink/70">
            Compensation
            <select
              data-testid="planning-cell-compensation-select"
              value={draftCompensation}
              onChange={(e) => setDraftCompensation(e.target.value as ExtraSessionCompensation)}
              className="mt-1 block w-full rounded border border-border px-2 py-1 text-sm"
            >
              <option value="Payment">Payment</option>
              <option value="TOIL" disabled={!toilAllowed}>
                TOIL
              </option>
            </select>
          </label>
        ) : null}
        {draftState === "extra_session" && !toilAllowed ? (
          <p className="mt-1 text-[11px] text-ink/50">
            {`${doctorTypeLabel} doctors have no leave entitlement, so a session cannot be taken in lieu - Payment only.`}
          </p>
        ) : null}
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
            disabled={toilBlocked}
            className="rounded bg-accent px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
          >
            Apply
          </button>
        </div>
        <Popover.Arrow className="fill-surface" />
      </Popover.Content>
    </Popover.Portal>
  );
}
