import { z } from "zod";

import type { Doctor, DoctorIn, DoctorType, SupervisionPreference } from "@/api/types";

const doctorTypeEnum = z.enum(["Partner", "Salaried", "Trainee", "Locum", "AHP"]);
const supervisionPreferenceEnum = z.enum(["none", "less", "normal", "more"]);

export const doctorFormSchema = z
  .object({
    code: z.string().min(1, "Code is required"),
    doctorType: doctorTypeEnum,
    /**
     * Kept as a number in form state for a plain number input; converted
     * to the wire's fixed-1dp string in toWirePayload, matching
     * Doctor.sessions_per_week: string (Decimal(4,1) server-side).
     */
    sessionsPerWeek: z.number().nonnegative("Must be zero or more"),
    supervisionPreference: supervisionPreferenceEnum,
    /**
     * The optional employment window. Held as "" rather than null in form
     * state because that is what an empty `<input type="date">` reports;
     * toWirePayload is the single place "" becomes the wire's null, so an
     * empty field can never be sent as an empty string the server would
     * reject as an invalid date.
     */
    startDate: z.string(),
    endDate: z.string(),
  })
  .refine((v) => !(v.startDate && v.endDate) || v.startDate <= v.endDate, {
    // Mirrors the router's own 422 ("start_date must not be after
    // end_date"), which stays the authority - this only saves a
    // round-trip. Reported on endDate, not startDate: the user has
    // almost always just typed the end date and it is the one they
    // will want to change.
    path: ["endDate"],
    message: "End date must not be before the start date",
  });

export type DoctorFormValues = z.infer<typeof doctorFormSchema>;

export function emptyFormValues(): DoctorFormValues {
  return {
    code: "",
    doctorType: "Partner",
    sessionsPerWeek: 10.0,
    supervisionPreference: "normal",
    startDate: "",
    endDate: "",
  };
}

export function formValuesFromDoctor(doctor: Doctor): DoctorFormValues {
  return {
    code: doctor.code,
    doctorType: doctor.doctor_type,
    sessionsPerWeek: Number(doctor.sessions_per_week),
    supervisionPreference: doctor.supervision_preference,
    startDate: doctor.start_date ?? "",
    endDate: doctor.end_date ?? "",
  };
}

export function toWirePayload(values: DoctorFormValues): DoctorIn {
  return {
    code: values.code,
    doctor_type: values.doctorType as DoctorType,
    sessions_per_week: values.sessionsPerWeek.toFixed(1),
    supervision_preference: values.supervisionPreference as SupervisionPreference,
    // Blank means "no limit", which on the wire is null - never "".
    // Sent explicitly rather than omitted so the PATCH path can *clear*
    // a window that was previously set; DoctorPatch applies exclude_unset,
    // so an omitted key would leave the old date in place.
    start_date: values.startDate || null,
    end_date: values.endDate || null,
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