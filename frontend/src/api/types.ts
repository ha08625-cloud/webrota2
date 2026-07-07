/**
 * Thrown by the API client on any non-2xx response. `detail` mirrors
 * FastAPI's error body shape where possible (its `detail` field, which is
 * either a string or a Pydantic validation error list) but falls back to
 * whatever the response body actually contained.
 */
export interface ApiError {
  status: number;
  detail: unknown;
}

/**
 * The shape of one item in a standard FastAPI request-validation error
 * (422 from Pydantic parsing the request body itself, as opposed to a
 * business-logic 422 raised deliberately by a route). Distinguished from
 * ValidationIssue by its `msg`/`loc` fields.
 */
export interface FastApiValidationError {
  loc: (string | number)[];
  msg: string;
  type: string;
}

// --- Enums, mirroring backend/app/models/enums.py wire values exactly ---
// (Pydantic serialises these enums by value, e.g. "draft", not "DRAFT".)

export type Day = "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday";
export type Period = "AM" | "PM";
export type RotaStatus = "draft" | "committed";
export type SessionRole = "duty_primary" | "duty_secondary" | "clinic";
export type RoomType = "D" | "C" | "W" | "SR";
export type Site = "SHC" | "Cutteslowe" | "Wolvercote";

/**
 * MasterRotaSession.template_type (enums.py). Persisted onto
 * RotaSession as of M3.6 so NO_SURGERY/ADMIN_TIME/WFH template slots can
 * be told apart from a normal-but-currently-unassigned slot, which are
 * otherwise byte-identical (room_id/clinic_type_id/role all null).
 * REQUIRES_ROOM and PRE_ASSIGNED both render as normal sessions in the
 * Q13 colour language; only NO_SURGERY/ADMIN_TIME trigger the grey
 * background, and only when no role is present.
 */
export type MasterSessionType = "requires_room" | "no_surgery" | "admin_time" | "pre_assigned" | "wfh";

/** API shape of engine.datatypes.ValidationIssue (schemas_common.py). */
export interface ValidationIssue {
  severity: string;
  phase: string;
  check: string;
  message: string;
  week: number | null;
  day: Day | null;
  period: Period | null;
}

// --- Rooms (schemas_room.py) — read-only in M3, still read-only in M4 ---

export interface Room {
  id: number;
  code: string;
  room_type: RoomType;
  site: Site;
}

// --- Clinic types (schemas_clinic_type.py) ---
// Task 3 only needs the read shape (for the /clinic-types list used by the
// grid's category lookup). The nested create/edit shapes (ClinicTypeIn,
// ScheduleIn, DoctorEligIn, RoomEligIn, etc.) belong to Task 5, which owns
// the management form, and are deliberately not added here yet.

export interface ClinicTypeSchedule {
  id: number;
  day: Day;
  period: Period;
}

export interface ClinicTypeDoctorEligibility {
  id: number;
  doctor_id: number;
  doctor_priority: number;
}

export interface ClinicTypeRoomEligibility {
  id: number;
  room_id: number | null;
  room_type: RoomType | null;
}

export interface ClinicType {
  id: number;
  name: string;
  clinic_priority: number;
  is_enabled: boolean;
  room_required: boolean;
  /**
   * Free-text, nullable, no enforced values (clinic_type.py). The Q13
   * duty-helper-vs-named-clinic colour distinction is implemented as a
   * convention on this field ("duty_helper") rather than a schema
   * constraint - see cellStyle.ts. Anything else (including null) renders
   * as an ordinary named clinic.
   */
  category: string | null;
  schedules: ClinicTypeSchedule[];
  doctor_eligibilities: ClinicTypeDoctorEligibility[];
  room_eligibilities: ClinicTypeRoomEligibility[];
}

// --- Doctors (schemas_doctor.py) ---
// Task 3 only needs the read shape (for grid row ordering). Preferred-room
// editing and the nested DoctorDetailOut belong to Task 6.

export type DoctorType = "Partner" | "Salaried" | "Trainee" | "AHP";

export interface Doctor {
  id: number;
  code: string;
  doctor_type: DoctorType;
  sessions_per_week: string;
  active: boolean;
}

// --- Rota (schemas_rota.py) ---
// Deliberately named `rota_id` throughout, matching the wire field exactly
// - not normalised to `id`. A silent `undefined` from `rota.id` (instead
// of `rota.rota_id`) is the classic failure mode this guards against.

export interface RotaSummary {
  rota_id: number;
  status: RotaStatus;
  created_at: string;
  start_date: string;
  num_weeks: number;
  template_start_week: number;
}

export interface RotaSession {
  session_id: number;
  doctor_id: number;
  doctor_code: string;
  week: number;
  day: Day;
  period: Period;
  room_id: number | null;
  room_code: string | null;
  clinic_type_id: number | null;
  clinic_type_name: string | null;
  role: SessionRole | null;
  /**
   * M3.6 addition. null covers both a legacy pre-M3.6 row and a
   * manually-nulled one; either way it renders as a normal session, same
   * as the backend's own null-handling (see RotaSessionOut docstring).
   */
  template_type: MasterSessionType | null;
  is_wfh: boolean;
  is_on_leave: boolean;
  notes: string | null;
}

export interface Rota {
  rota_id: number;
  status: RotaStatus;
  created_at: string;
  start_date: string;
  num_weeks: number;
  template_start_week: number;
  sessions: RotaSession[];
}

export interface GenerateRotaIn {
  start_date: string;
  num_weeks: 1 | 2 | 4;
  template_start_week: number;
}

export interface GenerateRotaOut {
  rota_id: number;
  status: RotaStatus;
  issues: ValidationIssue[];
}