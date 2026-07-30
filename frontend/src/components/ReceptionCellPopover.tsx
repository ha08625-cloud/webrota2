import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";
import type { ReactNode } from "react";

import type { ReceptionRole } from "@/api/types";
import type { ReceptionCellData } from "@/lib/pivotReception";
import { RECEPTION_ROLE_LABELS, RECEPTION_ROLE_ORDER } from "@/lib/receptionRoles";

interface ReceptionCellPopoverProps<T extends ReceptionCellData> {
  /**
   * null in create mode: an absent cell has no existing row to read the
   * current role/note off of - the popover opens with role defaulted to
   * "phones" and an empty note, same as MasterCellEditPopover's create
   * mode always-unselected menu.
   */
  session: T | null;
  children: ReactNode;
  onSave: (role: ReceptionRole, note: string | null) => void;
  /** Shown and wired only when canDelete is true. Direct action, no confirm dialog - there is no steal/displacement concept here (Decision 6: several staff can share an hour), unlike MasterCellEditPopover's room picks. */
  onDelete?: () => void;
  /**
   * True when any hour in the edited range has a session to remove - drives the Remove
   * button independently of `session`, which only seeds the form. Defaults to false.
   */
  canDelete?: boolean;
  /** Number of hours this popover edits - a shift-click range, or 1 for a single cell. */
  hourCount?: number;
  saving: boolean;
}

/**
 * Sibling of MasterCellEditPopover, not a generalisation of it - the
 * reception slot's data model (role + free-text note only, no room, no
 * session_type, no displacement) shares nothing with MasterRotaSession's
 * edit surface beyond "a cell that opens a popover" (reception rota plan,
 * Task 7). Deliberate duplication, not a missed abstraction - see
 * ReceptionGrid's docstring for the fuller rationale, which applies here
 * too.
 *
 * Unlike MasterCellEditPopover, role/note are edited together and
 * committed with one explicit Save action rather than firing on every
 * pick - a free-text note can't fire onSave keystroke by keystroke, so
 * there is no direct-pick path to mirror.
 *
 * Edits a selection, which is usually one cell but may be a shift-click
 * range spanning several hours in one staff row - `hourCount` says how
 * many, `session` only ever seeds role/note (from the focus cell, or the
 * anchor, or the "phones"/empty defaults - ReceptionGrid decides which).
 */
export function ReceptionCellPopover<T extends ReceptionCellData>({
  session,
  children,
  onSave,
  onDelete,
  canDelete = false,
  hourCount = 1,
  saving,
}: ReceptionCellPopoverProps<T>) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<ReceptionRole>(session?.role ?? "phones");
  const [note, setNote] = useState(session?.note ?? "");

  function handleOpenChange(next: boolean) {
    if (next) {
      // Reset to the session's current values each time it opens, in case
      // a prior edit elsewhere changed them since last open (mirrors
      // MasterCellEditPopover's reset-on-open).
      setRole(session?.role ?? "phones");
      setNote(session?.note ?? "");
    }
    setOpen(next);
  }

  function handleSave() {
    const trimmed = note.trim();
    onSave(role, trimmed === "" ? null : trimmed);
    setOpen(false);
  }

  function handleDelete() {
    onDelete?.();
    setOpen(false);
  }

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={5}
          data-testid="reception-cell-edit-popover"
          className="z-50 w-64 rounded border border-border bg-surface p-3 shadow-lg"
        >
          {hourCount > 1 ? (
            <p className="text-xs font-medium text-ink/70">Editing {hourCount} hours</p>
          ) : null}

          <label className="block text-xs font-medium text-ink/70" htmlFor="reception-cell-role">
            Role
          </label>
          <select
            id="reception-cell-role"
            value={role}
            disabled={saving}
            onChange={(e) => setRole(e.target.value as ReceptionRole)}
            className="mt-1 w-full rounded border border-border p-1 text-sm"
          >
            {RECEPTION_ROLE_ORDER.map((r) => (
              <option key={r} value={r}>
                {RECEPTION_ROLE_LABELS[r]}
              </option>
            ))}
          </select>

          <label className="mt-2 block text-xs font-medium text-ink/70" htmlFor="reception-cell-note">
            Note
          </label>
          <input
            id="reception-cell-note"
            type="text"
            value={note}
            maxLength={200}
            disabled={saving}
            onChange={(e) => setNote(e.target.value)}
            className="mt-1 w-full rounded border border-border p-1 text-sm"
          />

          <div className="mt-3 flex items-center justify-between">
            {canDelete && onDelete ? (
              <button
                type="button"
                onClick={handleDelete}
                disabled={saving}
                className="rounded px-2 py-1 text-left text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                Remove
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="rounded bg-accent px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
            >
              Save
            </button>
          </div>

          <Popover.Arrow className="fill-surface" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
