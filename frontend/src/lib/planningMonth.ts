import type {
  CoverageSlot,
  Day,
  Doctor,
  ExtraSessionEntry,
  LeaveEntry,
  MasterRotaSession,
  MasterSessionType,
  Period,
  PlanningAction,
  PlanningActionIn,
  SchoolHoliday,
} from "@/api/types";
import { closedSlotKey } from "@/lib/closedSlots";
import { parseLocalDate } from "@/lib/date";

/**
 * The pure half of the leave planning grid: month arithmetic, the cell
 * state machine, the batch the Save button posts, and - the reason this
 * is a module rather than component-local code - the client-side
 * recomputation of the coverage total row.
 *
 * That last one re-applies, locally, exactly the rules
 * `routers/leave_planning.py::get_coverage` applies server-side, so the
 * total updates as cells are clicked without a round trip. The two
 * calculations have to agree, which is only checkable if this one is
 * testable on its own - hence a pure module tested against the same case
 * matrix as `tests/test_api/test_leave_planning.py::TestCoverage`.
 *
 * Nothing here touches React, the network, or `new Date(dateString)` -
 * every date is a "YYYY-MM-DD" string, compared as a string (ISO dates
 * sort chronologically) or constructed component-wise per lib/date.ts.
 */

export const PLANNING_PERIODS: Period[] = ["AM", "PM"];

/** Mon-Fri, indexed by `Date.getDay() - 1`. The grid has no weekend columns. */
const WEEKDAY_NAMES: Day[] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

/**
 * The template types the staging copy loop converts *into* requires_room
 * when an extra session lands on them - `_OVERRIDABLE_TYPES` in
 * routers/staging.py. Absence of a template row is overridable too (the
 * copy loop's new-row branch), handled separately below since there is no
 * value to put in this set for it.
 */
const OVERRIDABLE_TYPES = new Set<MasterSessionType>(["no_surgery", "admin_time", "wfh"]);

/**
 * The two types that mean "this doctor is clinically working this slot"
 * (Design Decision 3). no_surgery / admin_time / wfh / no template row all
 * count as zero - exactly the set OVERRIDABLE_TYPES (plus absence)
 * converts into requires_room, so the two halves of the grid agree with
 * each other by construction.
 */
const COUNTED_TYPES = new Set<MasterSessionType>(["requires_room", "pre_assigned"]);

/**
 * What a cell shows. Distinct from `PlanningAction`, which is what the
 * wire calls the transition into that state - "normal" has no action of
 * its own, it is the result of a "clear".
 */
export type PlanningCellState = "normal" | "leave" | "extra_session";

/** Click order: normal -> leave -> extra planned -> normal. */
const NEXT_STATE: Record<PlanningCellState, PlanningCellState> = {
  normal: "leave",
  leave: "extra_session",
  extra_session: "normal",
};

/** Which server rows exist for one (doctor, date, period). Both can be
 * present at once - leave never deletes an extra session, it supersedes
 * it - so this is deliberately not collapsed to a single state until
 * `toCellState` below. */
export interface ServerSlotRows {
  hasLeave: boolean;
  hasExtra: boolean;
}

interface DoctorWindow {
  start_date: string | null;
  end_date: string | null;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Every Mon-Fri date of the weeks that touch the given month, as
 * "YYYY-MM-DD", ascending. `month` is 1-12.
 *
 * A month rarely starts or ends on a Monday, so the first and last weeks
 * of the grid would otherwise be shown cut in half. This fills each partial
 * week out to a full Monday-Friday span by borrowing weekday dates from the
 * adjacent month - `isInMonth` tells the grid which columns those are, so
 * they can be rendered dimmed rather than looking like a data error.
 *
 * `new Date(year, month, 0)` is day zero of the *following* month, i.e.
 * the last day of this one; out-of-range day numbers below roll over into
 * the neighbouring month/year the same way - component-wise construction
 * throughout, per lib/date.ts's rule against `new Date(dateString)`.
 */
export function weekdaysInMonth(year: number, month: number): string[] {
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const lastWeekday = new Date(year, month - 1, daysInMonth).getDay();

  // Sun/Sat first days already align to a following Monday - nothing to
  // borrow. Tue-Fri first days leave a gap back to that week's Monday.
  const leadingDays = firstWeekday >= 2 && firstWeekday <= 5 ? firstWeekday - 1 : 0;
  // Sun/Sat last days already align to a preceding Friday. Mon-Thu last
  // days leave a gap forward to that week's Friday.
  const trailingDays = lastWeekday >= 1 && lastWeekday <= 4 ? 5 - lastWeekday : 0;

  const dates: string[] = [];
  for (let day = 1 - leadingDays; day <= daysInMonth + trailingDays; day++) {
    const date = new Date(year, month - 1, day);
    const weekday = date.getDay();
    if (weekday >= 1 && weekday <= 5) {
      dates.push(formatDate(date));
    }
  }
  return dates;
}

/** Whether `date` ("YYYY-MM-DD") falls within the given calendar month, as
 * opposed to being a lead-in/lead-out day borrowed from the adjacent month
 * to complete a week in `weekdaysInMonth`'s output. */
export function isInMonth(date: string, year: number, month: number): boolean {
  return date.startsWith(`${year}-${pad2(month)}-`);
}

/** The template `Day` a date falls on, or null for a weekend. */
export function weekdayName(date: string): Day | null {
  const index = parseLocalDate(date).getDay();
  return index >= 1 && index <= 5 ? WEEKDAY_NAMES[index - 1] : null;
}

/** Cell identity, used as the pending-edit map's key and for the leave /
 * extra-session membership sets. Parsed back apart by
 * `parsePlanningCellKey`, so the separator must not appear in a date. */
export function planningCellKey(doctorId: number, date: string, period: Period): string {
  return `${doctorId}|${date}|${period}`;
}

export interface PlanningCell {
  doctorId: number;
  date: string;
  period: Period;
}

export function parsePlanningCellKey(key: string): PlanningCell | null {
  const [doctorId, date, period] = key.split("|");
  if (date === undefined || (period !== "AM" && period !== "PM")) return null;
  const parsed = Number(doctorId);
  return Number.isFinite(parsed) ? { doctorId: parsed, date, period } : null;
}

/** Membership set over LeaveEntry[] or ExtraSessionEntry[] - the two have
 * the same (doctor_id, date, period) shape for this purpose. */
export function toCellKeySet(entries: { doctor_id: number; date: string; period: Period }[]): Set<string> {
  return new Set(entries.map((e) => planningCellKey(e.doctor_id, e.date, e.period)));
}

export function serverRows(
  leaveKeys: Set<string>,
  extraKeys: Set<string>,
  key: string,
): ServerSlotRows {
  return { hasLeave: leaveKeys.has(key), hasExtra: extraKeys.has(key) };
}

/** Leave wins where both rows exist (extra sessions plan, Design Decision
 * 6) - the same precedence the engine and the coverage endpoint apply. */
export function toCellState(rows: ServerSlotRows): PlanningCellState {
  if (rows.hasLeave) return "leave";
  if (rows.hasExtra) return "extra_session";
  return "normal";
}

/** What the cell shows right now: the pending edit if there is one, the
 * server's own state otherwise. Computed at render, so a pending edit and
 * the row underneath it can never disagree. */
export function mergeCellState(
  server: PlanningCellState,
  pending: PlanningAction | undefined,
): PlanningCellState {
  if (pending === undefined) return server;
  return pending === "clear" ? "normal" : pending;
}

export function nextCellState(state: PlanningCellState): PlanningCellState {
  return NEXT_STATE[state];
}

/** The wire action that produces this state. "normal" is a clear. */
export function stateToAction(state: PlanningCellState): PlanningAction {
  return state === "normal" ? "clear" : state;
}

/** True when `date` falls inside the doctor's employment window; null at
 * either end means unbounded. ISO date strings compare chronologically,
 * so this needs no Date objects. Mirrors `app/doctor_window.py`. */
export function isWithinWindow(doctor: DoctorWindow, date: string): boolean {
  return (
    (doctor.start_date === null || doctor.start_date <= date) &&
    (doctor.end_date === null || doctor.end_date >= date)
  );
}

/**
 * True when the doctor's window overlaps the inclusive range at all.
 *
 * This, not "in window today", is what decides whether a doctor gets a
 * row: someone who leaves on the 12th must still show for the first half
 * of the month they worked, with the days after the 12th rendered inert.
 */
export function overlapsRange(doctor: DoctorWindow, from: string, to: string): boolean {
  return (
    (doctor.start_date === null || doctor.start_date <= to) &&
    (doctor.end_date === null || doctor.end_date >= from)
  );
}

/**
 * Which of `dates` (the grid's Mon-Fri columns) fall inside one of a
 * school's holidays, each mapped to the covering holiday - a school with
 * an empty result gets no planner row (Design Decision 9).
 *
 * Reuses `overlapsRange` rather than a near-duplicate range comparison:
 * a holiday's start/end are never null (unlike a doctor's window), so
 * `overlapsRange(holiday, date, date)` is exactly the "date falls inside
 * this holiday" test. First matching holiday wins where two overlap for
 * the same school - there is no ordering guarantee to pick between them,
 * and the plan treats overlapping ranges as harmless (Design Decision 5).
 */
export function schoolHolidayDatesInRange(
  dates: string[],
  holidays: SchoolHoliday[],
): Map<string, SchoolHoliday> {
  const result = new Map<string, SchoolHoliday>();
  for (const date of dates) {
    const match = holidays.find((holiday) => overlapsRange(holiday, date, date));
    if (match) result.set(date, match);
  }
  return result;
}

/** One informational row on the Annual Planner. `dates` maps each
 * in-holiday grid column to the holiday covering it, for the cell title -
 * a school with no dates in view gets no row at all (Design Decision 9). */
export interface SchoolPlannerRow {
  id: number;
  name: string;
  dates: Map<string, SchoolHoliday>;
}

function templateKey(doctorId: number, day: Day, period: Period): string {
  return `${doctorId}|${day}|${period}`;
}

/**
 * (doctor, day, period) -> session type over the template's **week 1
 * rows only** (Design Decision 1).
 *
 * Mapping a calendar date onto the 4-week cycle would need a
 * `start_week`, and the only source of one is `RotaConfig.template_start_week`
 * - a per-run value with no calendar anchor. Partner and salaried doctors
 * work the same sessions every week, so week 1 is the right answer for
 * leave planning even though the schema keeps four weeks. This matches
 * `_week_one_template` server-side; if that assumption ever changes, both
 * have to change together.
 */
export function buildTemplateIndex(sessions: MasterRotaSession[]): Map<string, MasterSessionType> {
  const index = new Map<string, MasterSessionType>();
  for (const session of sessions) {
    if (session.week !== 1) continue;
    index.set(templateKey(session.doctor_id, session.day, session.period), session.session_type);
  }
  return index;
}

/**
 * Whether this doctor counts toward the headcount for one slot, given
 * their week-1 template type and what the cell says.
 *
 * The extra-session branch is conditional, not a flat +1 (Design Decision
 * 4): a slot already requires_room or pre_assigned is untouched by the
 * override - the doctor was already working it - so counting it again
 * would over-count. The copy loop demotes an admin_time row holding a
 * room to pre_assigned rather than requires_room; both count, so that
 * branch needs no reproduction here.
 */
function isCounted(
  templateType: MasterSessionType | undefined,
  state: PlanningCellState,
): boolean {
  if (state === "leave") return false;
  let effective = templateType;
  if (state === "extra_session" && (effective === undefined || OVERRIDABLE_TYPES.has(effective))) {
    effective = "requires_room";
  }
  return effective !== undefined && COUNTED_TYPES.has(effective);
}

export interface CoverageTotalsInput {
  /** The server's baseline for the displayed range. */
  coverage: CoverageSlot[];
  /** Unsaved edits, keyed by `planningCellKey`. */
  pending: Map<string, PlanningAction>;
  /**
   * The rows the grid renders, which are exactly the doctors the server
   * counts: active, Partner or Salaried, window-overlapping the month.
   * A pending edit on any doctor outside this list contributes nothing,
   * so the on-screen total always equals the sum of the visible rows.
   */
  doctors: Doctor[];
  /** The active template's sessions; week 1 is selected internally. */
  sessions: MasterRotaSession[];
  leave: LeaveEntry[];
  extraSessions: ExtraSessionEntry[];
}

/**
 * The total row: `closedSlotKey(date, period)` -> headcount, or **null
 * for a closed slot**, which the grid renders as "-" rather than 0 so
 * "closed" is never confused with "uncovered".
 *
 * Deliberately a delta against the server's baseline rather than a
 * from-scratch recount. Recomputing from the template alone would silently
 * diverge from the endpoint for every doctor the grid does not render -
 * this way, an unedited slot always shows the server's own number, and
 * only edited (doctor, slot) pairs are adjusted.
 */
export function applyPendingToCoverage({
  coverage,
  pending,
  doctors,
  sessions,
  leave,
  extraSessions,
}: CoverageTotalsInput): Map<string, number | null> {
  const totals = new Map<string, number | null>();
  for (const slot of coverage) {
    totals.set(closedSlotKey(slot.date, slot.period), slot.is_closed ? null : slot.headcount);
  }

  const template = buildTemplateIndex(sessions);
  const leaveKeys = toCellKeySet(leave);
  const extraKeys = toCellKeySet(extraSessions);
  const doctorsById = new Map(doctors.map((d) => [d.id, d]));

  for (const [key, action] of pending) {
    const cell = parsePlanningCellKey(key);
    if (cell === null) continue;

    const doctor = doctorsById.get(cell.doctorId);
    // Not a counted row (a Trainee edited through some other path, or a
    // doctor outside the displayed month), or a date this doctor does not
    // work - either way the server would not count them, so neither do we.
    if (doctor === undefined || !isWithinWindow(doctor, cell.date)) continue;

    const slot = closedSlotKey(cell.date, cell.period);
    const base = totals.get(slot);
    // undefined: outside the fetched range. null: closed, and a closed
    // slot has no headcount to adjust - Phase 2 creates no session there.
    if (base === undefined || base === null) continue;

    const before = toCellState(serverRows(leaveKeys, extraKeys, key));
    const after = mergeCellState(before, action);
    if (before === after) continue;

    const day = weekdayName(cell.date);
    const templateType =
      day === null ? undefined : template.get(templateKey(cell.doctorId, day, cell.period));

    totals.set(
      slot,
      base + (isCounted(templateType, after) ? 1 : 0) - (isCounted(templateType, before) ? 1 : 0),
    );
  }

  return totals;
}

export interface PlanningActionsInput {
  pending: Map<string, PlanningAction>;
  leaveKeys: Set<string>;
  extraKeys: Set<string>;
}

/**
 * The batch POST /leave-planning/bulk gets: the actions that move each
 * edited cell from its server state to the state the grid is showing.
 *
 * Usually one action per cell, but moving *between* leave and extra
 * planned emits a `clear` first. The bulk endpoint applies clears, then
 * leave, then extra sessions (Design Decision 9), so a `clear` paired
 * with the new state in the same batch removes the old row before the new
 * one is written. Without the clear the endpoint would skip the action -
 * `leave_exists` in one direction, a surviving superseded extra session
 * in the other - and the saved state would not match the grid, which is
 * the one thing a state-setting grid must not do.
 *
 * A cell whose pending state equals its server state emits nothing; the
 * page also drops such keys from the pending map as they happen, so this
 * is a belt-and-braces filter rather than the only guard.
 */
export function buildPlanningActions({
  pending,
  leaveKeys,
  extraKeys,
}: PlanningActionsInput): PlanningActionIn[] {
  const actions: PlanningActionIn[] = [];

  for (const [key, action] of pending) {
    const cell = parsePlanningCellKey(key);
    if (cell === null) continue;

    const rows = serverRows(leaveKeys, extraKeys, key);
    const before = toCellState(rows);
    const after = mergeCellState(before, action);
    if (before === after) continue;

    const base = { doctor_id: cell.doctorId, date: cell.date, period: cell.period };
    const needsClear =
      after === "normal" ||
      (after === "leave" && rows.hasExtra) ||
      (after === "extra_session" && rows.hasLeave);

    if (needsClear) actions.push({ ...base, action: "clear" });
    if (after !== "normal") actions.push({ ...base, action: stateToAction(after) });
  }

  return actions;
}
