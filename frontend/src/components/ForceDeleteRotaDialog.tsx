import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";

import { useForceDeleteRota } from "@/api/rota";

interface ForceDeleteRotaDialogProps {
  rotaId: number;
  onDeleted: () => void;
}

const CONFIRM_TEXT = "DELETE";

/**
 * Bug-recovery escape hatch for a committed rota that cannot be handled
 * through the normal lifecycle - most concretely, a legacy commit with
 * committed_at null, which Roll back commit can never reach. Deletes the
 * rota outright with no counter restore (see useForceDeleteRota's
 * docstring), so this is gated behind typing DELETE rather than a plain
 * window.confirm - the other rota mutations on this page use confirm(),
 * but none of them permanently desynchronise counters from history the
 * way this one does.
 *
 * Owns its own trigger and open state, unlike DoctorFormDialog, since
 * there is no separate list row driving which record is being edited -
 * the trigger button and the dialog are both scoped to this one rota.
 */
export function ForceDeleteRotaDialog({ rotaId, onDeleted }: ForceDeleteRotaDialogProps) {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const forceDeleteRota = useForceDeleteRota();

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      // Cancel, overlay click, and Escape all funnel through here, so a
      // reopen always starts from a clean, disabled-confirm state rather
      // than remembering the last attempt.
      setConfirmText("");
      forceDeleteRota.reset();
    }
  }

  function handleConfirm() {
    forceDeleteRota.mutate(rotaId, {
      onSuccess: () => {
        handleOpenChange(false);
        onDeleted();
      },
    });
  }

  const canConfirm = confirmText === CONFIRM_TEXT && !forceDeleteRota.isPending;

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Force delete rota
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-[28rem] -translate-x-1/2 -translate-y-1/2 rounded bg-surface p-5 shadow-lg">
          <Dialog.Title className="text-lg font-semibold text-red-700">Force delete this rota?</Dialog.Title>

          <p className="mt-2 text-sm text-ink/70">
            This permanently deletes this committed rota. Counters are NOT restored -- they
            will keep this rota&apos;s contributions with no rota to explain them. This exists
            only for recovering from software bugs, such as a committed rota that cannot be
            rolled back. For everyday mistakes, use Roll back commit instead if it is
            available.
          </p>

          <div className="mt-4">
            <label className="block text-sm font-medium" htmlFor="force-delete-confirm">
              Type DELETE to confirm
            </label>
            <input
              id="force-delete-confirm"
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="mt-1 w-full rounded border border-border p-1 text-sm"
            />
          </div>

          {forceDeleteRota.isError ? (
            <p className="mt-3 text-sm text-red-700">
              {typeof forceDeleteRota.error.detail === "string"
                ? forceDeleteRota.error.detail
                : "Could not delete this rota."}
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