import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import type { FormEvent } from "react";

import { useCreateHoliday, useUpdateHoliday } from "@/api/schools";
import type { ApiError, SchoolHoliday } from "@/api/types";

interface SchoolHolidayFormDialogProps {
  schoolId: number;
  schoolName: string;
  /** undefined = add mode. Render with a `key` on the holiday's id (or
   * "new") from the parent, matching ReceptionStaffFormDialog's
   * remount-on-switch convention. */
  holiday?: SchoolHoliday;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function extractErrorMessage(err: unknown): string {
  const detail = (err as ApiError | undefined)?.detail;
  return typeof detail === "string" ? detail : "Could not save this holiday.";
}

export function SchoolHolidayFormDialog({
  schoolId,
  schoolName,
  holiday,
  open,
  onOpenChange,
}: SchoolHolidayFormDialogProps) {
  const createHoliday = useCreateHoliday();
  const updateHoliday = useUpdateHoliday();

  const [startDate, setStartDate] = useState(holiday?.start_date ?? "");
  const [endDate, setEndDate] = useState(holiday?.end_date ?? "");
  const [name, setName] = useState(holiday?.name ?? "");
  const [error, setError] = useState<string | null>(null);

  const isSaving = createHoliday.isPending || updateHoliday.isPending;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!startDate || !endDate) {
      setError("Start and end date are required.");
      return;
    }
    // Mirrors the server's own check (SchoolHolidayIn) so the 422 is not
    // the first line of defence - same pattern as LeavePage's range cap.
    if (endDate < startDate) {
      setError("End date must not be before start date.");
      return;
    }

    const payload = { start_date: startDate, end_date: endDate, name: name || null };

    if (!holiday) {
      createHoliday.mutate(
        { schoolId, payload },
        { onSuccess: () => onOpenChange(false), onError: (err) => setError(extractErrorMessage(err)) },
      );
      return;
    }

    updateHoliday.mutate(
      { schoolId, holidayId: holiday.id, payload },
      { onSuccess: () => onOpenChange(false), onError: (err) => setError(extractErrorMessage(err)) },
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-96 -translate-x-1/2 -translate-y-1/2 rounded bg-surface p-5 shadow-lg">
          <Dialog.Title className="text-lg font-semibold">
            {holiday ? `Edit holiday for ${schoolName}` : `Add holiday for ${schoolName}`}
          </Dialog.Title>

          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            {error ? <p className="rounded bg-red-50 p-2 text-sm text-red-700">{error}</p> : null}

            <div>
              <label className="block text-sm font-medium" htmlFor="holiday-start-date">
                Start date
              </label>
              <input
                id="holiday-start-date"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="mt-1 w-full rounded border border-border p-1 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium" htmlFor="holiday-end-date">
                End date
              </label>
              <input
                id="holiday-end-date"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="mt-1 w-full rounded border border-border p-1 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-medium" htmlFor="holiday-name">
                Name (optional)
              </label>
              <input
                id="holiday-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Summer holidays"
                className="mt-1 w-full rounded border border-border p-1 text-sm"
              />
            </div>

            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Dialog.Close className="rounded px-3 py-1 text-sm text-ink/70">Cancel</Dialog.Close>
              <button
                type="submit"
                disabled={isSaving}
                className="rounded bg-accent px-4 py-1 text-sm font-medium text-white disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
