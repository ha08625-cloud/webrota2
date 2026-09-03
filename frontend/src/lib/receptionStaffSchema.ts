import { z } from "zod";

import type { ReceptionStaff, ReceptionStaffIn } from "@/api/types";

/**
 * One field only. `code` is a reception staff member's sole identifier
 * (api/types.ts); the form labels it "Name", so the validation message does
 * too - the wire key is what stays `code`.
 */
export const receptionStaffFormSchema = z.object({
  code: z.string().min(1, "Name is required"),
});

export type ReceptionStaffFormValues = z.infer<typeof receptionStaffFormSchema>;

export function emptyFormValues(): ReceptionStaffFormValues {
  return { code: "" };
}

export function formValuesFromReceptionStaff(staff: ReceptionStaff): ReceptionStaffFormValues {
  return { code: staff.code };
}

export function toWirePayload(values: ReceptionStaffFormValues): ReceptionStaffIn {
  return { code: values.code };
}

/** Maps Zod's client-side validation issues onto top-level form field keys. */
export function mapZodFieldErrors(error: z.ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !(key in fieldErrors)) {
      fieldErrors[key] = issue.message;
    }
  }
  return fieldErrors;
}
