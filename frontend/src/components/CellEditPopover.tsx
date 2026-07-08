import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";
import type { ReactNode } from "react";

import type { RotaSession } from "@/api/types";

interface CellEditPopoverProps {
  session: RotaSession;
  children: ReactNode;
  onSave: (isWfh: boolean, notes: string | null) => void;
  saving: boolean;
}

/**
 * Wraps a cell's rendered content as the popover trigger. Save always
 * sends both is_wfh and notes explicitly - SessionPatchIn supports a
 * partial update (only fields present in model_fields_set are applied),
 * but there's no correctness reason to diff against prior values here:
 * both fields are already known from the open form, so sending both is
 * simpler and behaviourally identical to a diffed subset for this form.
 * An empty notes textarea is sent as `notes: null` (explicit clear), not
 * omitted - the wire distinction between "clear" and "leave alone" only
 * matters when a field is omitted, and this form never omits either.
 */
export function CellEditPopover({ session, children, onSave, saving }: CellEditPopoverProps) {
  const [open, setOpen] = useState(false);
  const [isWfh, setIsWfh] = useState(session.is_wfh);
  const [notes, setNotes] = useState(session.notes ?? "");

  function handleOpenChange(next: boolean) {
    if (next) {
      // Reset to the session's current values each time it opens, in
      // case a swap/patch elsewhere changed them since the last open.
      setIsWfh(session.is_wfh);
      setNotes(session.notes ?? "");
    }
    setOpen(next);
  }

  function handleSave() {
    onSave(isWfh, notes.trim() === "" ? null : notes);
    setOpen(false);
  }

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={5}
          className="w-64 rounded border border-border bg-surface p-3 shadow-lg"
        >
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isWfh}
              onChange={(e) => setIsWfh(e.target.checked)}
            />
            Working from home
          </label>
          <label className="mt-2 block text-sm">
            Notes
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded border border-border p-1 text-sm"
            />
          </label>
          <div className="mt-3 flex justify-end gap-2">
            <Popover.Close className="rounded px-3 py-1 text-sm text-ink/70">Cancel</Popover.Close>
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