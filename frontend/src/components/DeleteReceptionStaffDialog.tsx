import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";

import { useDeleteReceptionStaff, useReceptionStaffUsage } from "@/api/reception";
import type { ReceptionStaff } from "@/api/types";

interface DeleteReceptionStaffDialogProps {
  staff: ReceptionStaff;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}

/**
 * Confirms a permanent purge of one reception staff member. A dialog
 * rather than the window.confirm() the rest of this page uses, because
 * consent here is only informed if the numbers are in front of the person
 * deciding - how many generated days change, how much leave history goes -
 * and confirm() cannot render them.
 *
 * Gated on typing the staff *code*, where ForceDeleteRotaDialog (the other
 * typed-confirmation destructive action) gates on the literal "DELETE".
 * This dialog is opened from one row of a table of similar-looking rows,
 * so the check should prove the user knows *which* record they are
 * destroying, not merely that they read a word. Exact match, no trimming
 * and no case folding, same as the precedent.
 *
 * Driven by props rather than owning its trigger, since the table row
 * decides which member is being deleted - the split ReceptionStaffFormDialog
 * already uses. Render with a `key` on the staff id so state resets between
 * rows.
 */
export function DeleteReceptionStaffDialog({
  staff,
  open,
  onOpenChange,
  onDeleted,
}: DeleteReceptionStaffDialogProps) {
  const [confirmText, setConfirmText] = useState("");
  const usage = useReceptionStaffUsage(open ? staff.id : null);
  const deleteStaff = useDeleteReceptionStaff();

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) {
      // Cancel, overlay click and Escape all funnel through here, so a
      // reopen starts from a clean, disabled-confirm state.
      setConfirmText("");
      deleteStaff.reset();
    }
  }

  function handleConfirm() {
    deleteStaff.mutate(staff.id, {
      onSuccess: () => {
        handleOpenChange(false);
        onDeleted?.();
      },
    });
  }

  const canConfirm = confirmText === staff.code && !deleteStaff.isPending;

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-[30rem] -translate-x-1/2 -translate-y-1/2 rounded bg-surface p-5 shadow-lg">
          <Dialog.Title className="text-lg font-semibold text-red-700">
            Permanently delete {staff.code}?
          </Dialog.Title>

          <p className="mt-2 text-sm text-ink/70">
            This removes them and everything recorded against them. It cannot be
            undone. If you only want them off the rota from now on, Deactivate does that and
            keeps the history.
          </p>

          {/* The counts are information; the delete is the action. A failed
              usage query says so and lets the delete proceed rather than
              blocking it behind a read. */}
          {usage.isLoading ? <p className="mt-3 text-sm text-ink/70">Checking what this would delete...</p> : null}
          {usage.isError ? (
            <p className="mt-3 text-sm text-ink/70">
              Could not load what this would delete. You can still delete, but you will not
              see the numbers first.
            </p>
          ) : null}
          {usage.data ? (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink/70">
              <li>
                {usage.data.rota_sessions} row{usage.data.rota_sessions === 1 ? "" : "s"} on{" "}
                {usage.data.generated_days} already-generated day
                {usage.data.generated_days === 1 ? "" : "s"} - those days will no longer show
                what they showed before.
              </li>
              <li>
                {usage.data.master_sessions} slot{usage.data.master_sessions === 1 ? "" : "s"} on
                the weekday template.
              </li>
              <li>
                {usage.data.leave_entries} leave record{usage.data.leave_entries === 1 ? "" : "s"}.
              </li>
              <li>They disappear from the counters page entirely.</li>
            </ul>
          ) : null}

          <div className="mt-4">
            <label className="block text-sm font-medium" htmlFor="delete-staff-confirm">
              Type {staff.code} to confirm
            </label>
            <input
              id="delete-staff-confirm"
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="mt-1 w-full rounded border border-border p-1 text-sm"
            />
          </div>

          {deleteStaff.isError ? (
            <p className="mt-3 text-sm text-red-700">
              {typeof deleteStaff.error.detail === "string"
                ? deleteStaff.error.detail
                : "Could not delete this staff member."}
            </p>
          ) : null}

          <div className="mt-4 flex justify-end gap-2 border-t border-border pt-3">
            <Dialog.Close className="rounded px-3 py-1 text-sm text-ink/70">Cancel</Dialog.Close>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!canConfirm}
              className="rounded bg-red-600 px-4 py-1 text-sm font-medium text-white disabled:opacity-50"
            >
              Permanently delete
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
