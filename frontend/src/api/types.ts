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
  /**
   * Optional employment window (annual leave planning, Task 1). Null at
   * either end means unbounded, which is every doctor that predates the
   * feature. This is an *additional*, independent gate alongside
   * `active`, not a replacement for it: `active` is the soft-delete flag,
   * the window is a real employment fact, and a doctor only counts as
   * working on a date when both hold (Design Decision 6). Enforced
   * server-side at Phase 2, the POST /staging copy loop, and Phase 0 -
   * the frontend reads these fields to avoid *offering* an out-of-window
   * cell, never as the enforcement itself.
   */
  start_date: string | null;
  end_date: string | null;
}

/** POST /doctors body. `active` is not settable here - always true server-side. */
export interface DoctorIn {
  code: string;
  doctor_type: DoctorType;
  sessions_per_week: string;
  supervision_preference: SupervisionPreference;
  /** Employment window; null means unbounded at that end. */
  start_date?: string | null;
  end_date?: string | null;
}

/**
 * PATCH /doctors/{id} body - every field optional, only supplied fields
 * are applied (DoctorPatch in schemas_doctor.py). DoctorFormDialog sends
 * code/doctor_type/sessions_per_week together as a full set; the
 * "Deactivate instead" action sends `active` alone; the DoctorsPage
 * sessions/week stepper sends `sessions_per_week` alone. The DoctorsPage
 * supervision-preference dropdown sends `supervision_preference` alone,
 * the same pattern as the sessions/week stepper.
 *
 * The server applies `exclude_unset`, so an omitted `start_date`/`end_date`
 * leaves the stored window untouched while an explicit `null` clears that
 * end of it. DoctorFormDialog always sends both, which is what makes
 * blanking a date in the form actually remove it.
 */
export interface DoctorPatch {
  code?: string;
  doctor_type?: DoctorType;
  sessions_per_week?: string;
  active?: boolean;
  supervision_preference?: SupervisionPreference;
  start_date?: string | null;
  end_date?: string | null;
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
  /** Annual Planner free-text note (12-char cap); null/absent outside that grid. */
  notes?: string | null;
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

/**
 * Extra sessions superseded by this bulk-add call (extra sessions plan,
 * Task 1, Design Decision 7). Leave is created regardless - nothing here
 * is deleted automatically - this is reporting only, so LeavePage can
 * warn the admin which planned extra sessions may now be stale.
 */
export interface LeaveBulkOut {
  created: LeaveEntry[];
  skipped: LeaveBulkSkipped[];
  superseded_extra_sessions: ExtraSessionEntry[];
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

// --- Extra sessions (schemas/extra_session.py, extra sessions plan) ---
// Plans a doctor working a session they would not normally work
// (Task 1). No bulk endpoints (Design Decision 10) - a single date plus
// period covers the real workflow, unlike leave's date-range semantics.

export interface ExtraSessionEntry {
  id: number;
  doctor_id: number;
  date: string;
  period: Period;
  /** Annual Planner free-text note (12-char cap); null/absent outside that grid. */
  notes?: string | null;
}

export interface ExtraSessionIn {
  doctor_id: number;
  date: string;
  period: Period;
}

// --- Blocked (schemas/blocked.py, clinical rota "Blocked" planner option) ---
// A third Annual Planner cell state, alongside leave and extra session:
// the doctor is unavailable for clinical cover but this is deliberately
// NOT leave (a whole-day training session is the canonical case). Written
// only via POST /leave-planning/bulk - there is no ad-hoc CRUD router,
// unlike LeaveEntry/ExtraSessionEntry.

export interface BlockedEntry {
  id: number;
  doctor_id: number;
  date: string;
  period: Period;
  notes?: string | null;
}

// --- Leave planning (schemas/leave_planning.py, annual leave planning) ---
// Backs the month-at-a-time planning grid. Deliberately a separate set of
// shapes from the range-based leave ones above: /leave stays the ad-hoc,
// one-off path during the year (Design Decision 11), and these are
// cell-shaped, not range-shaped.

/**
 * One (date, period)'s clinical headcount. Counts Partner and Salaried
 * doctors only (Design Decision 2) whose effective session type is
 * requires_room or pre_assigned (Design Decision 3).
 *
 * A closed slot always reports `headcount: 0` alongside `is_closed: true`
 * (Design Decision 5) - Phase 2 creates no slot on a closed
 * (date, period), so the grid renders that as "-", never as "uncovered".
 */
export interface CoverageSlot {
  date: string;
  period: Period;
  headcount: number;
  is_closed: boolean;
}

/**
 * What POST /leave-planning/bulk does to one cell. "clear" removes
 * whichever of the LeaveEntry / ExtraSessionEntry / BlockedEntry rows
 * exists for the slot - they share the same (doctor_id, date, period)
 * key, so there is nothing to disambiguate. Precedence across the three
 * non-clear actions is leave > blocked > extra_session (see
 * leave_planning.py's module docstring).
 */
export type PlanningAction = "leave" | "extra_session" | "blocked" | "clear";

/**
 * Why the batch declined one action. Skipping rather than failing is the
 * point (Design Decision 8): one stale cell must not fail a 200-cell
 * save, so none of these are errors - the save succeeded.
 */
export type PlanningSkipReason =
  | "duplicate"
  | "outside_doctor_dates"
  | "leave_exists"
  | "blocked_exists"
  | "nothing_to_clear";

export interface PlanningActionIn {
  doctor_id: number;
  date: string;
  period: Period;
  action: PlanningAction;
  /** Free-text cell note (12-char cap). Ignored for "clear". */
  notes?: string | null;
}

export interface PlanningBulkIn {
  actions: PlanningActionIn[];
}

export interface PlanningSkipped extends PlanningActionIn {
  reason: PlanningSkipReason;
}

/**
 * `superseded_extra_sessions` are pre-existing extra sessions this
 * batch's leave now covers. They are *reported*, never deleted and never
 * a 409, exactly as /leave/bulk does - see LeaveBulkOut above.
 */
export interface PlanningBulkOut {
  applied: number;
  skipped: PlanningSkipped[];
  superseded_extra_sessions: ExtraSessionEntry[];
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

// --- Practice closures (schemas/closure.py, half-day practice closures plan) ---
// Global planning data, independent of any generated rota - see
// backend_app_models_closure.py. A rota's own closed_slots (Rota.closed_slots,
// added in M5 Task 5, made period-granular by the half-day closures plan) is
// a separate, per-rota snapshot taken at generation time, not derived from
// this list at read time. Closures are per (date, period) slots - a "full
// day" closure is two rows sharing a date, not a distinct value on `period`.

export interface Closure {
  id: number;
  date: string;
  period: Period;
  name: string | null;
}

export interface ClosureIn {
  date: string;
  period: Period;
  name?: string | null;
}

// A row of the fixed, system-wide bank-holiday list for a given year
// (routers/closures.py bank-holidays endpoints). `date` is null until an
// admin sets it for that year; setting it creates the underlying AM+PM
// Closure pair, tagged so it can be found again by key rather than name.
export interface BankHoliday {
  key: string;
  name: string;
  date: string | null;
}

/** A single closed (date, period) slot, as reported on `Rota`/`Staging` -
 * the wire shape of ClosedSlotOut (schemas/closure.py). */
export interface ClosedSlot {
  date: string;
  period: Period;
}

// --- Schools and school holidays (schemas/school.py, school holidays plan) ---
// Global planning data, purely informational - no engine coupling of any
// kind (Design Decision in school_holidays.md's implementation plan). A
// school holiday never suppresses a slot, changes a coverage total, or is
// snapshotted per-rota; it exists only so the School Holidays page and the
// Annual Planner's shading can show it. Date ranges, not per-slot rows,
// unlike Closure - nothing looks these up by (date, period).

export interface SchoolHoliday {
  id: number;
  school_id: number;
  start_date: string;
  end_date: string;
  name: string | null;
}

export interface SchoolHolidayIn {
  start_date: string;
  end_date: string;
  name?: string | null;
}

export interface School {
  id: number;
  name: string;
  holidays: SchoolHoliday[];
}

export interface SchoolIn {
  name: string;
}

// --- Recurring notes (schemas/recurring_note.py, recurring notes plan Task 4) ---
// Annotation-only: applying at generation time stamps `text` into
// RotaSession.notes for every matching doctor/week/day/period slot - see
// recurring_notes.md. doctor_ids and template_weeks are plain int lists,
// not nested child schemas, matching RecurringNoteIn/Out on the backend.

export interface RecurringNote {
  id: number;
  text: string;
  day: Day;
  period: Period;
  is_active: boolean;
  doctor_ids: number[];
  template_weeks: number[];
}

export interface RecurringNoteIn {
  text: string;
  day: Day;
  period: Period;
  is_active: boolean;
  doctor_ids: number[];
  template_weeks: number[];
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
   * M5: closed slots snapshotted at generation time (RotaClosure, not the
   * live PracticeClosure table) - deleting or adding a closure afterwards
   * does not change what this rota reports. Empty for a rota generated
   * with no closures in range. Period-granular since the half-day closures
   * plan - a full-day closure appears as two entries sharing a date.
   */
  closed_slots: ClosedSlot[];
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
//
// is_extra_session (extra sessions plan, Task 2, Design Decision 8) is
// derived the same way, from ExtraSessionEntry, and means "a planned
// extra session exists for this doctor/date/period" - not "this row was
// produced by the override". Those diverge whenever the override did not
// fire (the template row was already working, leave blocked it, the
// entry was added after staging started, or the cell was edited back),
// so the StagingGrid badge is labelled "Extra planned" rather than
// implying the row's origin.

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
  is_extra_session: boolean;
}

/**
 * GET /staging/active and the response of every staging write endpoint's
 * underlying staging. completed_at null means active; set means
 * completed (staging plan, Design Decision 2). closed_slots is live
 * PracticeClosure data in the create-to-complete range, not a snapshot
 * (Design Decision 10), period-granular since the half-day closures plan.
 */
export interface Staging {
  staging_id: number;
  config_id: number;
  start_date: string;
  num_weeks: number;
  created_at: string;
  completed_at: string | null;
  closed_slots: ClosedSlot[];
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

// --- Reception rota (reception rota plan) ---
// Independent of the clinical rota end to end - see models/reception.py's
// docstring. Wire shapes mirror backend/app/api/schemas/reception.py
// exactly, no client-side renaming, matching the convention documented at
// the top of this file. ValidationIssue (defined above) is reused as-is
// for coverage warnings - reception/schemas/common.py's ValidationIssueOut
// is the same schema the clinical rota uses, just with `week`/`period`
// always null.

export type ReceptionRole =
  | "phones"
  | "prescriptions"
  | "registrations"
  | "front_desk"
  | "admin"
  | "online_triage"
  | "rotas"
  | "tasks"
  | "lunch"
  | "not_working"
  | "other";

export interface ReceptionStaff {
  id: number;
  code: string;
  name: string;
  active: boolean;
}

/** POST /reception/staff body. `active` is not settable here - always true server-side. */
export interface ReceptionStaffIn {
  code: string;
  name: string;
}

/** PATCH /reception/staff/{id} body - every field optional, only supplied fields are applied (model_fields_set). */
export interface ReceptionStaffPatch {
  code?: string;
  name?: string;
  active?: boolean;
}

/**
 * Minimum phones headcount for one (day, hour) slot. The row set is fixed
 * by the seed (100 rows, one per weekday/half-hour combination) - there is no
 * POST or DELETE, only PATCH on `min_phones_staff` (CoverageRulePatch on
 * the backend; named with the `Reception` prefix here to avoid colliding
 * with the unrelated `CoverageSlot` leave-planning type above).
 */
export interface ReceptionCoverageRule {
  id: number;
  day: Day;
  hour: number;
  min_phones_staff: number;
}

export interface ReceptionCoverageRulePatch {
  min_phones_staff: number;
}

/**
 * One weekday master template slot (reception_master_sessions). Row
 * existence is the data - a staff member with no row for a (day, hour)
 * is not expected then. `session_id`, not `id`, since this sits in a list
 * alongside `staff_id`, matching MasterRotaSession's naming rule.
 */
export interface ReceptionMasterSession {
  session_id: number;
  staff_id: number;
  staff_code: string;
  staff_name: string;
  day: Day;
  hour: number;
  role: ReceptionRole;
  note: string | null;
}

/** POST /reception/master/sessions body - the full slot coordinates plus (role, note). */
export interface ReceptionMasterSessionCreateIn {
  staff_id: number;
  day: Day;
  hour: number;
  role?: ReceptionRole;
  note?: string | null;
}

/**
 * PATCH /reception/master/sessions/{id} body - a verbatim (role, note)
 * pair setter, not a partial update; both fields are always required
 * (note may be null).
 */
export interface ReceptionMasterSessionPatchIn {
  role: ReceptionRole;
  note: string | null;
}

/** One generated day's slot (reception_rota_sessions). Same shape as ReceptionMasterSession, minus `day` - the day is fixed by the rota it belongs to. */
export interface ReceptionRotaSession {
  session_id: number;
  staff_id: number;
  staff_code: string;
  staff_name: string;
  hour: number;
  role: ReceptionRole;
  note: string | null;
}

/**
 * GET /reception/rota?date=..., GET /reception/rota/{id}, and the response
 * of POST /reception/rota (generate): the day header plus its flat session
 * list and freshly computed coverage warnings.
 */
export interface ReceptionRota {
  rota_id: number;
  date: string;
  created_at: string;
  sessions: ReceptionRotaSession[];
  issues: ValidationIssue[];
}

/** POST /reception/rota body. Weekend dates are rejected (422) by the backend validator before generation runs. */
export interface ReceptionRotaGenerateIn {
  date: string;
}

/** POST /reception/rota/{id}/sessions body - add one staff member to one hour of an existing day. */
export interface ReceptionRotaSessionIn {
  staff_id: number;
  hour: number;
  role?: ReceptionRole;
  note?: string | null;
}

/** PATCH /reception/rota/{id}/sessions/{sid} body - same verbatim pair-setter contract as ReceptionMasterSessionPatchIn. */
export interface ReceptionRotaSessionPatchIn {
  role: ReceptionRole;
  note: string | null;
}

/**
 * Every mutating day-rota session endpoint (POST/PATCH) returns the
 * written row plus freshly recomputed coverage issues, mirroring the
 * clinical rota's mutate-then-revalidate contract - see api/reception.ts
 * for how this gets spliced into the cache.
 */
export interface ReceptionSessionWriteOut {
  session: ReceptionRotaSession;
  issues: ValidationIssue[];
}