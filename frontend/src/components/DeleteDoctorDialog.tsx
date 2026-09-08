import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";

import { useDeleteDoctor, useDoctorUsage } from "@/api/doctors";
import type { Doctor } from "@/api/types";

interface DeleteDoctorDialogProps {
  doctor: Doctor;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}

/**
 * Confirms a permanent purge of one doctor. The clinical twin of
 * DeleteReceptionStaffDialog, deliberately the same shape - the two staff
 * deletes now behave identically, so the dialogs should read identically
 * too.
 *
 * A dialog rather than the window.confirm() the rest of DoctorsPage uses,
 * because consent here is only informed if the numbers are in front of the
 * person deciding: how many already-committed rotas change, how much leave
 * and duty history goes.
 *
 * Gated on typing the doctor's code rather than the literal "DELETE"
 * (ForceDeleteRotaDialog's convention), for the reason the reception
 * dialog gives: this opens from one row of a table of similar-looking
 * rows, so the check should prove the user knows *which* record they are
 * destroying. Exact match, no trimming and no case folding.
 *
 * Driven by props rather than owning its trigger, since the table row
 * decides which doctor is being deleted. Render with a `key` on the doctor
 * id so state resets between rows.
 */
export function DeleteDoctorDialog({
  doctor,
  open,
  onOpenChange,
  onDeleted,
}: DeleteDoctorDialogProps) {
  const [confirmText, setConfirmText] = useState("");
  const usage = useDoctorUsage(open ? doctor.id : null);
  const deleteDoctor = useDeleteDoctor();

  function handleOpenChange(next: boolean) {
    onOpenChange(next);
    if (!next) {
      // Cancel, overlay click and Escape all funnel through here, so a
      // reopen starts from a clean, disabled-confirm state.
      setConfirmText("");
      deleteDoctor.reset();
    }
  }

  function handleConfirm() {
    deleteDoctor.mutate(doctor.id, {
      onSuccess: () => {
        handleOpenChange(false);
        onDeleted?.();
      },
    });
  }

  const canConfirm = confirmText === doctor.code && !deleteDoctor.isPending;

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-[30rem] -translate-x-1/2 -translate-y-1/2 rounded bg-surface p-5 shadow-lg">
          <Dialog.Title className="text-lg font-semibold text-red-700">
            Permanently delete {doctor.code}?
          </Dialog.Title>

          <p className="mt-2 text-sm text-ink/70">
            This removes them and everything recorded against them. It cannot be
            undone. If you only want them off the rota from now on, Reactivate is
            still available and keeps the history.
          </p>

          {/* The counts are information; the delete is the action. A failed
              usage query says so and lets the delete proceed rather than
              blocking it behind a read. */}
          {usage.isLoading ? (
            <p className="mt-3 text-sm text-ink/70">Checking what this would delete...</p>
          ) : null}
          {usage.isError ? (
            <p className="mt-3 text-sm text-ink/70">
              Could not load what this would delete. You can still delete, but you will not
              see the numbers first.
            </p>
          ) : null}
          {usage.data ? (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink/70">
              <li>
                {usage.data.rota_sessions} session{usage.data.rota_sessions === 1 ? "" : "s"} on
                generated rotas, {usage.data.committed_rotas} of them committed - those rotas
                will no longer show what they showed before.
              </li>
              <li>
                {usage.data.master_sessions} slot{usage.data.master_sessions === 1 ? "" : "s"} on
                the master template
                {usage.data.staging_sessions > 0
                  ? `, and ${usage.data.staging_sessions} on the staging grid`
                  : ""}
                .
              </li>
              <li>
                {usage.data.leave_entries} leave record
                {usage.data.leave_entries === 1 ? "" : "s"}, {usage.data.duty_assignments} duty
                assignment{usage.data.duty_assignments === 1 ? "" : "s"},{" "}
                {usage.data.extra_sessions} extra session
                {usage.data.extra_sessions === 1 ? "" : "s"} and {usage.data.blocked_entries}{" "}
                blocked slot{usage.data.blocked_entries === 1 ? "" : "s"}.
              </li>
              <li>
                Their counters, room preferences, clinic eligibilities and signature go too,
                and their calendar feed link stops working.
              </li>
            </ul>
          ) : null}

          <div className="mt-4">
            <label className="block text-sm font-medium" htmlFor="delete-doctor-confirm">
              Type {doctor.code} to confirm
            </label>
            <input
              id="delete-doctor-confirm"
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="mt-1 w-full rounded border border-border p-1 text-sm"
            />
          </div>

          {deleteDoctor.isError ? (
            <p className="mt-3 text-sm text-red-700">
              {typeof deleteDoctor.error.detail === "string"
                ? deleteDoctor.error.detail
                : "Could not delete this doctor."}
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
