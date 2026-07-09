import type { Doctor, DoctorType } from "@/api/types";

/**
 * Fixed display order for doctor-type groups across every doctor dropdown
 * in the app. Not alphabetical by design - Partner/Salaried/Trainee/AHP
 * reflects seniority convention, not the type strings' sort order.
 */
export const DOCTOR_TYPE_ORDER: DoctorType[] = ["Partner", "Salaried", "Trainee", "AHP"];

const DOCTOR_TYPE_LABELS: Record<DoctorType, string> = {
  Partner: "Partners",
  Salaried: "Salaried",
  Trainee: "Trainees",
  AHP: "AHP",
};

/**
 * Minimal shape needed to order two doctor-like things by the same
 * display convention as DOCTOR_TYPE_ORDER: grouped by type, alphabetical
 * by code within a type. Deliberately not `Doctor` itself - pivot.ts
 * sorts full Doctor objects (snake_case doctor_type/code) while
 * pivotMasterRota.ts sorts plain {doctorId, doctorCode, doctorType} rows
 * (camelCase, no full Doctor available without a second /doctors fetch -
 * see pivotMasterRota.ts). Each caller maps its own shape into this one
 * rather than the comparator trying to accept both directly.
 */
export interface DoctorDisplayOrderKey {
  type: DoctorType;
  code: string;
}

/**
 * Orders by DOCTOR_TYPE_ORDER first, then alphabetically by code within
 * a type - the single source of truth for grid row ordering (RotaGrid,
 * MasterRotaGrid) as well as this file's own grouping above.
 */
export function compareDoctorDisplayOrder(a: DoctorDisplayOrderKey, b: DoctorDisplayOrderKey): number {
  const typeDiff = DOCTOR_TYPE_ORDER.indexOf(a.type) - DOCTOR_TYPE_ORDER.indexOf(b.type);
  if (typeDiff !== 0) return typeDiff;
  return a.code.localeCompare(b.code);
}

export interface DoctorGroup {
  type: DoctorType;
  label: string;
  doctors: Doctor[];
}

/**
 * Groups the given doctors by type (fixed order: Partner, Salaried,
 * Trainee, AHP), sorted alphabetically by code within each group.
 *
 * A type with no doctors in the *input* list is omitted entirely, rather
 * than rendered as an empty group - callers that need "doctors not yet
 * added" semantics (e.g. an eligibility-add dropdown) must filter the
 * input list down to the not-yet-added doctors before calling this, so
 * that a fully-added type disappears along with any group-level bulk
 * action tied to it. Grouping never re-applies its own active/eligibility
 * filtering; it only groups and sorts whatever list it's given.
 */
export function groupDoctorsByType(doctors: Doctor[]): DoctorGroup[] {
  return DOCTOR_TYPE_ORDER.map((type) => ({
    type,
    label: DOCTOR_TYPE_LABELS[type],
    doctors: doctors.filter((d) => d.doctor_type === type).sort((a, b) => a.code.localeCompare(b.code)),
  })).filter((group) => group.doctors.length > 0);
}