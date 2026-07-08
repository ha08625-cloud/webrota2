import type { FastApiValidationError } from "@/api/types";

/** Wire field name -> form field name (camelCase). Only top-level scalars. */
const LOC_TO_FIELD: Record<string, string> = {
  name: "name",
  clinic_priority: "clinicPriority",
};

export interface MappedValidationErrors {
  fieldErrors: Record<string, string>;
  /** Anything that couldn't be mapped to a known top-level field. */
  formErrors: string[];
}

/**
 * Maps a 422's FastApiValidationError[] onto the clinic type form's
 * field names. loc[0] is always "body" for a JSON request-body
 * validation error - stripped before matching.
 *
 * Deliberately does NOT attempt to map anything deeper than a top-level
 * scalar (schedules/doctor_eligibilities/room_eligibilities errors, e.g.
 * the RoomEligIn XOR validator firing on a specific row). The client-side
 * Zod schema and the form's own structure (two separate add buttons,
 * discriminated row shape) already prevent constructing the payloads
 * that would trigger those - if one appears anyway, something has
 * bypassed the form's own validation, and guessing which row/field a
 * nested loc path refers to would risk misattributing the error rather
 * than surfacing it honestly. Those go to formErrors as a generic
 * top-of-form message instead.
 */
export function mapValidationErrors(errors: FastApiValidationError[]): MappedValidationErrors {
  const fieldErrors: Record<string, string> = {};
  const formErrors: string[] = [];

  for (const error of errors) {
    const path = error.loc[0] === "body" ? error.loc.slice(1) : error.loc;
    const fieldName = path.length === 1 && typeof path[0] === "string" ? LOC_TO_FIELD[path[0]] : undefined;
    if (fieldName) {
      fieldErrors[fieldName] = error.msg;
    } else {
      formErrors.push(error.msg);
    }
  }

  return { fieldErrors, formErrors };
}