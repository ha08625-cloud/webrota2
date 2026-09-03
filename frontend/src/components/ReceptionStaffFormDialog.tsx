import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import type { FormEvent } from "react";

import { useCreateReceptionStaff, useUpdateReceptionStaff } from "@/api/reception";
import type { ApiError, ReceptionStaff } from "@/api/types";
import {
  type ReceptionStaffFormValues,
  emptyFormValues,
  formValuesFromReceptionStaff,
  mapZodFieldErrors,
  receptionStaffFormSchema,
  toWirePayload,
} from "@/lib/receptionStaffSchema";

interface ReceptionStaffFormDialogProps {
  /** undefined = create mode. Render with a `key` on the staff member's id
   * (or "new") from the parent, so switching which record is being
   * edited remounts this component and its form state resets cleanly -
   * same convention as DoctorFormDialog/UserFormDialog. */
  staff?: ReceptionStaff;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ReceptionStaffFormDialog({ staff, open, onOpenChange }: ReceptionStaffFormDialogProps) {
  const createStaff = useCreateReceptionStaff();
  const updateStaff = useUpdateReceptionStaff();

  const [values, setValues] = useState<ReceptionStaffFormValues>(() =>
    staff ? formValuesFromReceptionStaff(staff) : emptyFormValues(),
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const isSaving = createStaff.isPending || updateStaff.isPending;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFieldErrors({});
    setFormError(null);

    const result = receptionStaffFormSchema.safeParse(values);
    if (!result.success) {
      setFieldErrors(mapZodFieldErrors(result.error));
      return;
    }
    const payload = toWirePayload(result.data);

    // The duplicate-name 409 (routers/reception_staff.py) names the field
    // in its message, so it is shown there rather than as a top-of-form
    // banner (reception rota plan, Task 6) - unlike DoctorFormDialog's
    // equivalent, whose 409 has no single field it unambiguously points at.
    const onError = (err: ApiError) => {
      const message = typeof err.detail === "string" ? err.detail : "Could not save this staff member.";
      if (err.status === 409) {
        setFieldErrors({ code: message });
      } else {
        setFormError(message);
      }
    };

    if (!staff) {
      createStaff.mutate(payload, { onSuccess: () => onOpenChange(false), onError });
      return;
    }

    updateStaff.mutate({ id: staff.id, payload }, { onSuccess: () => onOpenChange(false), onError });
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-96 -translate-x-1/2 -translate-y-1/2 rounded bg-surface p-5 shadow-lg">
          <Dialog.Title className="text-lg font-semibold">
            {staff ? `Edit ${staff.code}` : "New Reception Staff"}
          </Dialog.Title>

          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            {formError ? <p className="rounded bg-red-50 p-2 text-sm text-red-700">{formError}</p> : null}

            {/* Labelled "Name" but bound to `code`, the single identifier
                the record has. It is rendered in every grid row header, so
                it wants to be short - initials or a first name, with a
                surname initial only where two people would collide. */}
            <div>
              <label className="block text-sm font-medium" htmlFor="rs-name">
                Name
              </label>
              <input
                id="rs-name"
                type="text"
                value={values.code}
                onChange={(e) => setValues((v) => ({ ...v, code: e.target.value }))}
                className="mt-1 w-full rounded border border-border p-1 text-sm"
              />
              {fieldErrors.code ? <p className="mt-1 text-xs text-red-700">{fieldErrors.code}</p> : null}
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
