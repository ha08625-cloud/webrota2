import { z } from "zod";

import type { ReceptionStaff, ReceptionStaffIn, ReceptionStaffPatch } from "@/api/types";

/**
 * Reception staff has no employment window, no sessions/week, no
 * supervision preference - just the two fields a person record needs
 * (reception rota plan, Design Decision 1). Both create and edit share one
 * schema; there is no password-style "blank means unchanged" field to
 * special-case per mode, unlike userSchema.ts.
 */
export const receptionStaffFormSchema = z.object({
  code: z.string().min(1, "Code is required"),
  name: z.string().min(1, "Name is required"),
});

export type ReceptionStaffFormValues = z.infer<typeof receptionStaffFormSchema>;

export function emptyFormValues(): ReceptionStaffFormValues {
  return { code: "", name: "" };
}

export function formValuesFromReceptionStaff(staff: ReceptionStaff): ReceptionStaffFormValues {
  return { code: staff.code, name: staff.name };
}

export function toCreatePayload(values: ReceptionStaffFormValues): ReceptionStaffIn {
  return { code: values.code, name: values.name };
}

export function toPatchPayload(values: ReceptionStaffFormValues): ReceptionStaffPatch {
  return { code: values.code, name: values.name };
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
