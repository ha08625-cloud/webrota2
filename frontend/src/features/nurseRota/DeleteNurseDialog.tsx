import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";

import type { Doctor } from "@/api/types";

import { useDeleteNurse, useNurseUsage } from "./api";

interface DeleteNurseDialogProps {
  nurse: Doctor;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}

/**
 * Confirms a permanent purge of one nurse. A dialog rather than the
 * window.confirm() the Deactivate action uses, for the reason
 * `DeleteReceptionStaffDialog` gives: consent is only informed if the
 * numbers are in front of the person deciding, and confirm() cannot render
 * them.
 *
 * The numbers matter more here than the section's users may expect. A
 * nurse is inert to the generation engine, but Phase 2 builds grid slots
 * for nurse rows like anyone else's, so a nurse accumulates rows in
 * committed rotas - rotas that have been printed and handed out, which
 * this rewrites. And nothing rejects a nurse from leave, duty or extra
 * sessions, so those four counts are reported even though they look
 * structurally zero: a confirm dialog that silently omits a count which
 * turns out to be non-zero is worse than one that shows four zeroes.
 *
 * Gated on typing the nurse's name, not the literal "DELETE": this is
 * opened from one row of a table of similar-looking rows, so the check
 * should prove the user knows *which* record they are destroying. Exact
 * match, no trimming and no case folding, same as the precedent.
 */
export function DeleteNurseDialog({ nurse, open, onOpenChange, onDeleted }: DeleteNurseDialogProps) {
  const [confirmText, setConfirmText] = useState("");
  const usage = useNurseUsage(open ? nurse.id : null);
  const deleteNurse = useDeleteNurse();

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) {
      // Cancel, overlay click and Escape all funnel through here, so a
      // reopen starts from a clean, disabled-confirm state.
      setConfirmText("");
      deleteNurse.reset();
    }
  }

  function handleConfirm() {
    deleteNurse.mutate(nurse.id, {
      onSuccess: () => {
        handleOpenChange(false);
        onDeleted?.();
      },
    });
  }

  const canConfirm = confirmText === nurse.code && !deleteNurse.isPending;

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-[30rem] -translate-x-1/2 -translate-y-1/2 rounded bg-surface p-5 shadow-lg">
          <Dialog.Title className="text-lg font-semibold text-red-700">
            Permanently delete {nurse.code}?
          </Dialog.Title>

          <p className="mt-2 text-sm text-ink/70">
            This removes them and everything recorded against them. It cannot be undone. If you
            only want them off the rota from now on, Deactivate does that and keeps the history.
          </p>

          {/* The counts are information; the delete is the action. A failed
              usage query says so and lets the delete proceed rather than
              blocking it behind a read. */}
          {usage.isLoading ? (
            <p className="mt-3 text-sm text-ink/70">Checking what this would delete...</p>
          ) : null}
          {usage.isError ? (
            <p className="mt-3 text-sm text-ink/70">
              Could not load what this would delete. You can still delete, but you will not see
              the numbers first.
            </p>
          ) : null}
          {usage.data ? (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink/70">
              <li>
                {usage.data.rota_sessions} row{usage.data.rota_sessions === 1 ? "" : "s"} on
                generated rotas, {usage.data.committed_rotas} of them committed - committed rotas
                have already been handed out, and this rewrites them.
              </li>
              <li>
                {usage.data.master_sessions} slot{usage.data.master_sessions === 1 ? "" : "s"} on
                the master template, including this section's nurse rota.
              </li>
              <li>
                {usage.data.staging_sessions} staged row
                {usage.data.staging_sessions === 1 ? "" : "s"}.
              </li>
              <li>
                {usage.data.leave_entries} leave record
                {usage.data.leave_entries === 1 ? "" : "s"}, {usage.data.duty_assignments} duty
                assignment{usage.data.duty_assignments === 1 ? "" : "s"},{" "}
                {usage.data.extra_sessions} extra session
                {usage.data.extra_sessions === 1 ? "" : "s"} and {usage.data.blocked_entries}{" "}
                blocked entr{usage.data.blocked_entries === 1 ? "y" : "ies"}.
              </li>
            </ul>
          ) : null}

          <div className="mt-4">
            <label className="block text-sm font-medium" htmlFor="delete-nurse-confirm">
              Type {nurse.code} to confirm
            </label>
            <input
              id="delete-nurse-confirm"
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="mt-1 w-full rounded border border-border p-1 text-sm"
            />
          </div>

          {deleteNurse.isError ? (
            <p className="mt-3 text-sm text-red-700">
              {typeof deleteNurse.error.detail === "string"
                ? deleteNurse.error.detail
                : "Could not delete this nurse."}
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
