import { z } from "zod";

import type { Doctor, DoctorIn, DoctorType, SupervisionPreference } from "@/api/types";

const doctorTypeEnum = z.enum(["Partner", "Salaried", "Trainee", "Locum", "AHP"]);
const supervisionPreferenceEnum = z.enum(["none", "less", "normal", "more"]);

export const doctorFormSchema = z.object({
  code: z.string().min(1, "Code is required"),
  doctorType: doctorTypeEnum,
  /**
   * Kept as a number in form state for a plain number input; converted
   * to the wire's fixed-1dp string in toWirePayload, matching
   * Doctor.sessions_per_week: string (Decimal(4,1) server-side).
   */
  sessionsPerWeek: z.number().nonnegative("Must be zero or more"),
  supervisionPreference: supervisionPreferenceEnum,
});

export type DoctorFormValues = z.infer<typeof doctorFormSchema>;

export function emptyFormValues(): DoctorFormValues {
  return { code: "", doctorType: "Partner", sessionsPerWeek: 10.0, supervisionPreference: "normal" };
}

export function formValuesFromDoctor(doctor: Doctor): DoctorFormValues {
  return {
    code: doctor.code,
    doctorType: doctor.doctor_type,
    sessionsPerWeek: Number(doctor.sessions_per_week),
    supervisionPreference: doctor.supervision_preference,
  };
}

export function toWirePayload(values: DoctorFormValues): DoctorIn {
  return {
    code: values.code,
    doctor_type: values.doctorType as DoctorType,
    sessions_per_week: values.sessionsPerWeek.toFixed(1),
    supervision_preference: values.supervisionPreference as SupervisionPreference,
  };
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