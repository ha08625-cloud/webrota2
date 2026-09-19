import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import type { FormEvent } from "react";
import { z } from "zod";

import type { ApiError, Doctor } from "@/api/types";

import { useCreateNurse, useUpdateNurse } from "./api";
import type { NurseIn } from "./types";

/**
 * Create/edit one nurse: code and the optional employment window, and
 * nothing else.
 *
 * A clone of `ReceptionStaffFormDialog` rather than a conditioned-down
 * `DoctorFormDialog`. That component is 428 lines built around the full
 * doctor shape - type select, preference selects, preferred-rooms list,
 * sessions stepper - and every one of those is either a hole in this
 * section's boundary (`doctor_type`) or meaningless for a nurse. Hiding
 * them all would mean editing a live clinical component for a rule that
 * belongs here; `documentation/architecture.md` puts a section's own
 * components in `src/features/<section>/`.
 *
 * `sessions_per_week`, `supervision_preference` and `wfh_preference` are
 * absent from the form because they are absent from `NurseIn`: they take
 * their model defaults, feed engine mechanisms no nurse is considered by,
 * and `DoctorsPage` already hides all three for nurses.
 */

const nurseFormSchema = z
  .object({
    code: z.string().min(1, "Name is required"),
    /**
     * Held as "" rather than null, because that is what an empty
     * `<input type="date">` reports; `toWirePayload` is the single place
     * "" becomes the wire's null, so an empty field can never be sent as
     * an empty string the server would reject as an invalid date. Same
     * convention as `lib/doctorSchema.ts`.
     */
    startDate: z.string(),
    endDate: z.string(),
  })
  .refine((v) => !(v.startDate && v.endDate) || v.startDate <= v.endDate, {
    // Mirrors the router's own 422 ("start_date must not be after
    // end_date"), which stays the authority - this only saves a
    // round-trip. Reported on endDate for the reason doctorSchema gives.
    path: ["endDate"],
    message: "End date must not be before the start date",
  });

type NurseFormValues = z.infer<typeof nurseFormSchema>;

function emptyFormValues(): NurseFormValues {
  return { code: "", startDate: "", endDate: "" };
}

function formValuesFromNurse(nurse: Doctor): NurseFormValues {
  return {
    code: nurse.code,
    startDate: nurse.start_date ?? "",
    endDate: nurse.end_date ?? "",
  };
}

function toWirePayload(values: NurseFormValues): NurseIn {
  return {
    code: values.code,
    // Sent explicitly rather than omitted so the PATCH path can *clear* a
    // window that was previously set: NursePatch applies exclude_unset, so
    // an omitted key would leave the old date in place.
    start_date: values.startDate || null,
    end_date: values.endDate || null,
  };
}

function mapZodFieldErrors(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !(key in fieldErrors)) {
      fieldErrors[key] = issue.message;
    }
  }
  return fieldErrors;
}

interface NurseFormDialogProps {
  /** undefined = create mode. Render with a `key` on the nurse's id (or
   * "new") from the parent, so switching which record is being edited
   * remounts this component and its form state resets cleanly - the
   * convention every other form dialog here follows. */
  nurse?: Doctor;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function NurseFormDialog({ nurse, open, onOpenChange }: NurseFormDialogProps) {
  const createNurse = useCreateNurse();
  const updateNurse = useUpdateNurse();

  const [values, setValues] = useState<NurseFormValues>(() =>
    nurse ? formValuesFromNurse(nurse) : emptyFormValues(),
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const isSaving = createNurse.isPending || updateNurse.isPending;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFieldErrors({});
    setFormError(null);

    const result = nurseFormSchema.safeParse(values);
    if (!result.success) {
      setFieldErrors(mapZodFieldErrors(result.error));
      return;
    }
    const payload = toWirePayload(result.data);

    // The 409 detail is shown verbatim. `doctors.code` is unique over the
    // whole table, so the collision may be with a doctor this section
    // never shows; the backend's message says "Staff code", deliberately,
    // rather than /doctors' "Doctor code" - see the nurse endpoints in
    // routers/nurse_rota.py. It is written to be read, so it is not
    // replaced with a generic one here.
    const onError = (err: ApiError) => {
      const message = typeof err.detail === "string" ? err.detail : "Could not save this nurse.";
      if (err.status === 409) {
        setFieldErrors({ code: message });
      } else {
        setFormError(message);
      }
    };

    if (!nurse) {
      createNurse.mutate(payload, { onSuccess: () => onOpenChange(false), onError });
      return;
    }

    updateNurse.mutate({ id: nurse.id, payload }, { onSuccess: () => onOpenChange(false), onError });
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-96 -translate-x-1/2 -translate-y-1/2 rounded bg-surface p-5 shadow-lg">
          <Dialog.Title className="text-lg font-semibold">
            {nurse ? `Edit ${nurse.code}` : "New Nurse"}
          </Dialog.Title>

          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            {formError ? <p className="rounded bg-red-50 p-2 text-sm text-red-700">{formError}</p> : null}

            {/* Labelled "Name" but bound to `code`: it is the identifier
                every grid row header shows, so it wants to be short. */}
            <div>
              <label className="block text-sm font-medium" htmlFor="nurse-name">
                Name
              </label>
              <input
                id="nurse-name"
                type="text"
                value={values.code}
                onChange={(e) => setValues((v) => ({ ...v, code: e.target.value }))}
                className="mt-1 w-full rounded border border-border p-1 text-sm"
              />
              {fieldErrors.code ? <p className="mt-1 text-xs text-red-700">{fieldErrors.code}</p> : null}
            </div>

            <fieldset>
              <legend className="text-sm font-medium">Employment dates</legend>
              <p className="mt-1 text-xs text-ink/50">Leave blank for no limit.</p>
              <div className="mt-2 flex gap-3">
                <div className="flex-1">
                  <label className="block text-xs text-ink/70" htmlFor="nurse-start-date">
                    Start date
                  </label>
                  <input
                    id="nurse-start-date"
                    type="date"
                    value={values.startDate}
                    onChange={(e) => setValues((v) => ({ ...v, startDate: e.target.value }))}
                    className="mt-1 w-full rounded border border-border p-1 text-sm"
                  />
                  {fieldErrors.startDate ? (
                    <p className="mt-1 text-xs text-red-700">{fieldErrors.startDate}</p>
                  ) : null}
                </div>
                <div className="flex-1">
                  <label className="block text-xs text-ink/70" htmlFor="nurse-end-date">
                    End date
                  </label>
                  <input
                    id="nurse-end-date"
                    type="date"
                    value={values.endDate}
                    onChange={(e) => setValues((v) => ({ ...v, endDate: e.target.value }))}
                    className="mt-1 w-full rounded border border-border p-1 text-sm"
                  />
                  {fieldErrors.endDate ? (
                    <p className="mt-1 text-xs text-red-700">{fieldErrors.endDate}</p>
                  ) : null}
                </div>
              </div>
            </fieldset>

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
