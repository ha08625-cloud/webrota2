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

// --- Auth and user management (schemas/auth.py) ---
// Task 5 added AuthUser/LoginIn/LoginOut. Task 6 (Users page) adds the
// write-side shapes below. AuthUser doubles as the read shape for the
// Users page's list/detail rows - it is byte-identical to UserOut, so
// api/users.ts imports it directly rather than duplicating an identical
// interface under a second name.

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  active: boolean;
  created_at: string;
}

export interface LoginIn {
  email: string;
  password: string;
}

export interface LoginOut {
  token: string;
  user: AuthUser;
}

/** POST /users body (UserIn in schemas/auth.py). Always creates an active user - `active` is not settable here. */
export interface UserIn {
  email: string;
  name: string;
  password: string;
}

/**
 * PATCH /users/{id} body (UserPatch in schemas/auth.py) - every field
 * optional, only supplied fields are applied (exclude_unset). A supplied
 * `password` re-hashes it and deletes every session belonging to that
 * user server-side (routers/users.py) - this is the password-reset
 * mechanism, there is no separate endpoint for it. A `active: false` that
 * would leave zero active users is rejected with 409.
 */
export interface UserPatch {
  email?: string;
  name?: string;
  active?: boolean;
  password?: string;
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
//
// clinic_priority is deliberately absent here: it is server-managed (a
// contiguous 1..N sequence over enabled clinic types, maintained by the
// router and the dedicated PUT /clinic-types/reorder endpoint), not
// client-settable. It still appears on ClinicType (the read shape) below.

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
  is_enabled: boolean;
  room_required: boolean;
  category: string | null;
  schedules: ScheduleIn[];
  doctor_eligibilities: DoctorEligIn[];
  room_eligibilities: RoomEligIn[];
}

/** Body for PUT /clinic-types/reorder - the full set of enabled clinic
 * type ids in the desired order. The server rejects anything that isn't
 * exactly the current enabled set (missing id, extra id, duplicate,
 * or a disabled id included) with a 409.
 */
export interface ClinicTypeReorderIn {
  ordered_ids: number[];
}

/**
 * Body for PATCH /clinic-types/{id} - partial update for the two booleans
 * only (ClinicTypePatch in schemas/clinic_type.py). name/category stay
 * PUT-only. Both fields optional; only supplied fields are applied
 * server-side (exclude_unset).
 */
export interface ClinicTypePatch {
  is_enabled?: boolean;
  room_required?: boolean;
}

// --- Doctors (schemas_doctor.py) ---

export type DoctorType = "Partner" | "Salaried" | "Trainee" | "Locum" | "AHP";

/**
 * Doctor.supervision_preference (enums.py). Multiplies the doctor's
 * weighted SUPERVISION score in Phase 9C's fallback pool selection -
 * "none" deprioritises heavily but does not exclude, "more" prioritises.
 * Default "normal" leaves the score unweighted.
 */
export type SupervisionPreference = "none" | "less" | "normal" | "more";

export interface Doctor {
  id: number;
  code: string;
  doctor_type: DoctorType;
  sessions_per_week: string;
  active: boolean;
  supervision_preference: SupervisionPreference;
}

/** POST /doctors body. `active` is not settable here - always true server-side. */
export interface DoctorIn {
  code: string;
  doctor_type: DoctorType;
  sessions_per_week: string;
  supervision_preference: SupervisionPreference;
}

/**
 * PATCH /doctors/{id} body - every field optional, only supplied fields
 * are applied (DoctorPatch in schemas_doctor.py). DoctorFormDialog sends
 * code/doctor_type/sessions_per_week together as a full set; the
 * "Deactivate instead" action sends `active` alone; the DoctorsPage
 * sessions/week stepper sends `sessions_per_week` alone. The DoctorsPage
 * supervision-preference dropdown sends `supervision_preference` alone,
 * the same pattern as the sessions/week stepper.
 */
export interface DoctorPatch {
  code?: string;
  doctor_type?: DoctorType;
  sessions_per_week?: string;
  active?: boolean;
  supervision_preference?: SupervisionPreference;
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

export type PeriodOrBoth = Period | "BOTH";

export interface LeaveBulkIn {
  doctor_id: number;
  start_date: string;
  end_date: string;
  period: PeriodOrBoth;
}

export interface LeaveBulkSkipped {
  date: string;
  period: Period;
  reason: "weekend" | "duplicate";
}

export interface LeaveBulkOut {
  created: LeaveEntry[];
  skipped: LeaveBulkSkipped[];
}

export interface LeaveBulkDeleteIn {
  doctor_id: number;
  start_date: string;
  end_date: string;
  period: PeriodOrBoth;
}

export interface LeaveBulkDeleteOut {
  deleted_count: number;
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

export interface DutyCount {
  doctor_id: number;
  doctor_code: string;
  raw_count: number;
}

// --- Practice closures (schemas/closure.py, M5 bank-holiday weeks) ---
// Global planning data, independent of any generated rota - see
// backend_app_models_closure.py. A rota's own closed_dates (Rota.closed_dates,
// added in M5 Task 5) is a separate, per-rota snapshot taken at generation
// time, not derived from this list at read time.

export interface Closure {
  id: number;
  date: string;
  name: string | null;
}

export interface ClosureIn {
  date: string;
  name?: string | null;
}

// --- Counters (schemas_counter.py) ---
// Read-only: "mutation happens only through generation and swap-roles"
// (routers_counters.py docstring) - no write hooks in api/counters.ts.
// Neither schema includes a weighted score; counter.py's docstring
// documents raw_count / doctor.sessions_per_week as "computed at query
// time, not stored", but that computation currently lives only in the
// engine (datatypes.py's weighted_clinic_score/weighted_system_score),
// not in these API responses. CountersPage computes it client-side from
// the joined doctor's sessions_per_week, replicating the engine's own
// spw===0 -> Infinity rule (never "no data") for fidelity with how the
// allocator actually treats that doctor.

export interface ClinicCounter {
  id: number;
  doctor_id: number;
  doctor_code: string;
  clinic_type_id: number;
  clinic_type_name: string;
  raw_count: number;
}

export interface SystemCounter {
  id: number;
  doctor_id: number;
  doctor_code: string;
  counter_type: SystemCounterKind;
  raw_count: number;
}

/** SystemCounterType (enums.py) - named with a `Kind` suffix here since `SystemCounter` is already taken by the row type above. */
export type SystemCounterKind = "room_move" | "supervision";

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
  /**
   * M3.7 addition. Null for a draft, and also null for a committed rota
   * that predates rollback support - see RotaOut.committed_at and
   * RotaDetailPage's rollback-eligibility check.
   */
  committed_at: string | null;
  /**
   * M6 addition. Null unless the rota has been archived; only ever
   * non-null on a committed rota. Set via POST /rota/{id}/archive,
   * cleared via /unarchive or automatically by rollback-commit. This
   * endpoint returns archived rotas unfiltered - the frontend uses this
   * field to split committed history into "Committed" and "Archived"
   * tabs purely client-side.
   */
  archived_at: string | null;
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
  is_supervising: boolean;
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
  /**
   * M5: closed dates snapshotted at generation time (RotaClosure, not the
   * live PracticeClosure table) - deleting or adding a closure afterwards
   * does not change what this rota reports. Empty for a rota generated
   * with no closures in range.
   */
  closed_dates: string[];
  /**
   * M3.7 addition. Null for a draft, including one produced by rolling
   * back a commit, and also null for a committed rota that predates
   * rollback support - see RotaSummary.committed_at.
   */
  committed_at: string | null;
  /**
   * M6 addition. Null unless the rota has been archived; only ever
   * non-null on a committed rota. Cleared automatically by
   * rollback-commit alongside committed_at - see RotaSummary.archived_at.
   */
  archived_at: string | null;
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

// --- Cell edit menu (M4.1 Task 1) ---
// set-room and set-role mirror backend_app_api_schemas_rota.py exactly.
// Both endpoints return the target session, an optional displaced
// session (the one they stole from), and a fresh issues list.

export interface SetRoomIn {
  room_id: number | null;
}

export interface SetRoomOut {
  session: RotaSession;
  displaced_session: RotaSession | null;
  issues: ValidationIssue[];
}

/**
 * Verbatim setter of the full (role, clinic_type_id, template_type)
 * triple - all three fields are required (nullable, but must be present).
 * See SetRoleIn's backend docstring: the caller (this frontend) is
 * responsible for echoing the session's current template_type when the
 * menu shape is meant to preserve it (duty/clinic picks) versus
 * overwriting it (no_surgery/admin_time picks).
 */
export interface SetRoleIn {
  role: SessionRole | null;
  clinic_type_id: number | null;
  template_type: MasterSessionType | null;
}

export interface SetRoleOut {
  session: RotaSession;
  displaced_session: RotaSession | null;
  issues: ValidationIssue[];
}

// --- Generation decision log (schemas/rota.py's GenerationLogEntryOut) ---
// API shape of engine.datatypes.DecisionLogEntry, 1:1 fields. Written once
// per rota, in the same transaction as the rota itself
// (generate._write_to_db()), and never mutated afterwards - unlike
// ValidationIssue, which is re-derived live on every /issues request. See
// GET /rota/{id}/log in api/rota.ts.

export interface GenerationLogEntry {
  sequence: number;
  phase: string;
  action: string;
  message: string;
  week: number | null;
  day: Day | null;
  period: Period | null;
  doctor_id: number | null;
  related_doctor_id: number | null;
  room_id: number | null;
  related_room_id: number | null;
  clinic_type_id: number | null;
}

// --- Master rota (schemas/master_rota.py) ---
// Read-only view of the active template. Named session_id/template_id,
// matching RotaSession/Rota's convention (not the plain `id` used by
// standalone CRUD entity schemas) - these objects sit in a list
// alongside other _id fields (doctor_id, room_id).

export interface MasterRotaSession {
  session_id: number;
  doctor_id: number;
  doctor_code: string;
  doctor_type: DoctorType;
  week: number;
  day: Day;
  period: Period;
  session_type: MasterSessionType;
  room_id: number | null;
  room_code: string | null;
}

export interface MasterRotaTemplate {
  template_id: number;
  name: string;
  sessions: MasterRotaSession[];
}

// --- Staging (schemas/staging.py, staging plan) ---
// The editable one-off holiday-cover surface between the master template
// and generation (Task 5). StagingSession is MasterRotaSession's shape
// plus is_on_leave - a staging row has a real calendar date (via its
// config's start_date), so leave is something the editor can and should
// show, unlike the dateless master template.

export interface StagingSession {
  session_id: number;
  doctor_id: number;
  doctor_code: string;
  doctor_type: DoctorType;
  week: number;
  day: Day;
  period: Period;
  session_type: MasterSessionType;
  room_id: number | null;
  room_code: string | null;
  is_on_leave: boolean;
}

/**
 * GET /staging/active and the response of every staging write endpoint's
 * underlying staging. completed_at null means active; set means
 * completed (staging plan, Design Decision 2). closed_dates is live
 * PracticeClosure data in the create-to-complete range, not a snapshot
 * (Design Decision 10).
 */
export interface Staging {
  staging_id: number;
  config_id: number;
  start_date: string;
  num_weeks: number;
  created_at: string;
  completed_at: string | null;
  closed_dates: string[];
  sessions: StagingSession[];
}

/** POST /staging body. Same shape as GenerateRotaIn - a staging is created
 * from exactly the inputs generation would take, before generation runs. */
export interface CreateStagingIn {
  start_date: string;
  num_weeks: 1 | 2 | 4;
  template_start_week: number;
}

export interface StagingSessionWriteOut {
  session: StagingSession;
  displaced_session: StagingSession | null;
}

// --- Signatures (schemas/signature.py) ---
// Metadata only - the image itself never travels as JSON. Uploaded via
// apiClient.postForm, fetched via apiClient.getBlob, see api/signatures.ts.

export interface SignatureMeta {
  doctor_id: number;
  content_type: string;
  uploaded_at: string;
}