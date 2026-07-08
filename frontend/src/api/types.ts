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
 * TanStack Query v5's mechanism for typing every query/mutation error as
 * ApiError by default, instead of the built-in default of Error. Without
 * this, `useQuery`/`useMutation` callers get `error: Error | null` and
 * any `error.status` access is a type error - apiClient's `request()`
 * throws a plain ApiError object, never a real Error instance, so
 * `Error` was never the right default here. Covers every hook in every
 * api/*.ts file; no per-hook generic annotation needed.
 */
declare module "@tanstack/react-query" {
  interface Register {
    defaultError: ApiError;
  }
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

// Write-side shapes (Task 5). POST/PUT both take the full nested
// ClinicTypeIn - PUT replaces all child rows wholesale (replace-children
// pattern), it does not diff against what's already there. There is no
// "wfh_allowed" field or room_required XOR anything - room_required is a
// plain boolean with no counterpart, despite what an earlier plan draft
// assumed; confirmed directly against clinic_type.py, schemas_clinic_type.py,
// and routers_clinic_types.py, none of which reference such a field.

export interface ScheduleIn {
  day: Day;
  period: Period;
}

export interface DoctorEligIn {
  doctor_id: number;
  doctor_priority: number;
}

/**
 * Exactly one of room_id / room_type, mirroring the DB check constraint
 * (ck_ctre_room_xor) and the Pydantic model_validator. The client never
 * constructs a row with both or neither set - ClinicTypeFormDialog's two
 * separate add buttons and discriminated form-state shape make that
 * structurally unrepresentable, not just discouraged.
 */
export interface RoomEligIn {
  room_id: number | null;
  room_type: RoomType | null;
}

export interface ClinicTypeIn {
  name: string;
  clinic_priority: number;
  is_enabled: boolean;
  room_required: boolean;
  category: string | null;
  schedules: ScheduleIn[];
  doctor_eligibilities: DoctorEligIn[];
  room_eligibilities: RoomEligIn[];
}

// --- Doctors (schemas_doctor.py) ---

export type DoctorType = "Partner" | "Salaried" | "Trainee" | "AHP";

export interface Doctor {
  id: number;
  code: string;
  doctor_type: DoctorType;
  sessions_per_week: string;
  active: boolean;
}

/** POST /doctors body. `active` is not settable here - always true server-side. */
export interface DoctorIn {
  code: string;
  doctor_type: DoctorType;
  sessions_per_week: string;
}

/**
 * PATCH /doctors/{id} body - every field optional, only supplied fields
 * are applied (DoctorPatch in schemas_doctor.py). Task 6 only ever sends
 * `active` with this (the "Deactivate instead" action on the soft-delete
 * 409 banner) - code/doctor_type/sessions_per_week edits go through the
 * same endpoint but are always sent together as a full set from
 * DoctorFormDialog, never partially.
 */
export interface DoctorPatch {
  code?: string;
  doctor_type?: DoctorType;
  sessions_per_week?: string;
  active?: boolean;
}

/**
 * Exactly one of room_id / room_type, mirroring the DB check constraint
 * (ck_dpr_room_xor) on doctor_preferred_rooms.
 */
export interface PreferredRoomOut {
  id: number;
  preference_order: number;
  room_id: number | null;
  room_type: RoomType | null;
}

export interface PreferredRoomIn {
  preference_order: number;
  room_id: number | null;
  room_type: RoomType | null;
}

/** GET /doctors/{id} - the list endpoint's DoctorOut has no preferred_rooms. */
export interface DoctorDetail extends Doctor {
  preferred_rooms: PreferredRoomOut[];
}

// --- Leave (schemas_leave.py) ---

export interface LeaveEntry {
  id: number;
  doctor_id: number;
  date: string;
  period: Period;
}

export interface LeaveIn {
  doctor_id: number;
  date: string;
  period: Period;
}

// --- Duty (schemas_duty.py) ---

export type DutyType = "primary" | "secondary";

export interface DutyAssignment {
  id: number;
  date: string;
  period: Period;
  doctor_id: number;
  duty_type: DutyType;
}

export interface DutyIn {
  date: string;
  period: Period;
  doctor_id: number;
  duty_type: DutyType;
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