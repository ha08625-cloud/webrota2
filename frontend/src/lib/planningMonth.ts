import type {
  BlockedEntry,
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

/** Matches `NOTES_MAX_LENGTH` in app/models/blocked.py -- there is very
 * little room to render free text in a cell that also shows AM/PM. */
export const NOTES_MAX_LENGTH = 12;

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
 * The two types that mean "this doctor is clinically working this slot".
 * no_surgery / admin_time / wfh / no template row all count as zero -
 * exactly the set OVERRIDABLE_TYPES (plus absence) converts into
 * requires_room, so the two halves of the grid agree with each other by
 * construction.
 */
const COUNTED_TYPES = new Set<MasterSessionType>(["requires_room", "pre_assigned"]);

/**
 * What a cell shows. Distinct from `PlanningAction`, which is what the
 * wire calls the transition into that state - "normal" has no action of
 * its own, it is the result of a "clear".
 */
export type PlanningCellState = "normal" | "leave" | "extra_session" | "blocked";

/**
 * A cell's unsaved edit: the state the admin picked from the dropdown,
 * plus whatever they typed in the notes field (always a string, never
 * undefined - "" means no note). Notes are meaningless for "normal", but
 * kept in the same record rather than a parallel map so a pending edit
 * and its note can never point at different cells.
 */
export interface PendingEdit {
  action: PlanningAction;
  notes: string;
}

/** Which server rows exist for one (doctor, date, period). More than one
 * can be present at once - leave never deletes an extra session, it
 * supersedes it, and the same is true of blocked - so this is
 * deliberately not collapsed to a single state until `toCellState` below. */
export interface ServerSlotRows {
  hasLeave: boolean;
  hasExtra: boolean;
  hasBlocked: boolean;
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

/** One endpoint of a drag selection: a (date, period) half-cell within
 * a single doctor's row. */
export interface PlanningCellRef {
  date: string;
  period: Period;
}

/**
 * Every half-cell covered by a drag between two endpoints on one doctor's
 * row, ascending by (date, AM before PM).
 *
 * Normalised by date, not by click order: the two endpoints are first
 * ordered by `(index in dates, AM < PM)`, so a right-to-left drag from
 * Thursday AM back to Tuesday PM yields exactly the same cells as the
 * left-to-right drag Tuesday PM -> Thursday AM.
 *
 * The half-day edges mirror the Individual Leave tab's
 * (`lib/expandLeaveRange.ts`): starting on a PM covers only that day's PM
 * ("off at lunchtime"), ending on an AM covers only that day's AM ("back
 * at lunchtime"), and every day in between gets both halves. A stationary
 * click - both endpoints the same - therefore selects that one half and
 * nothing else, which is what preserves the grid's existing single-cell,
 * half-day editing.
 *
 * Walks the grid's own `dates` array rather than calling
 * `expandLeaveRange`: that one walks calendar days and would emit weekend
 * keys to filter out, whereas an index slice over the Mon-Fri column list
 * cannot produce a cell the grid does not render. The semantics are
 * reused, the function deliberately is not.
 *
 * An endpoint whose date is not a visible column returns nothing - the
 * grid only ever passes dates it rendered, but a month change mid-drag
 * must not throw.
 */
export function selectionCells(
  dates: string[],
  doctorId: number,
  anchor: PlanningCellRef,
  focus: PlanningCellRef,
): PlanningCell[] {
  const anchorDate = dates.indexOf(anchor.date);
  const focusDate = dates.indexOf(focus.date);
  if (anchorDate === -1 || focusDate === -1) return [];

  // Period order comes off PLANNING_PERIODS rather than a string
  // comparison, so the two cannot drift apart.
  const anchorPeriod = PLANNING_PERIODS.indexOf(anchor.period);
  const focusPeriod = PLANNING_PERIODS.indexOf(focus.period);
  const anchorIsFirst =
    anchorDate < focusDate || (anchorDate === focusDate && anchorPeriod <= focusPeriod);
  const [firstDate, firstPeriod, lastDate, lastPeriod] = anchorIsFirst
    ? [anchorDate, anchorPeriod, focusDate, focusPeriod]
    : [focusDate, focusPeriod, anchorDate, anchorPeriod];

  const cells: PlanningCell[] = [];
  for (let index = firstDate; index <= lastDate; index++) {
    // Interior days run the full period list; only the two edges are
    // clipped, and on a single-day selection both clips apply at once.
    const from = index === firstDate ? firstPeriod : 0;
    const to = index === lastDate ? lastPeriod : PLANNING_PERIODS.length - 1;
    for (let period = from; period <= to; period++) {
      cells.push({ doctorId, date: dates[index], period: PLANNING_PERIODS[period] });
    }
  }
  return cells;
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
  blockedKeys: Set<string>,
  key: string,
): ServerSlotRows {
  return {
    hasLeave: leaveKeys.has(key),
    hasExtra: extraKeys.has(key),
    hasBlocked: blockedKeys.has(key),
  };
}

/** Leave > blocked > extra_session where more than one row exists (extended to
 * blocked - see leave_planning.py's module docstring). Matches the coverage endpoint's
 * own precedence, and the bulk endpoint's skip-reason ordering
 * (leave_exists / blocked_exists) that keeps a stale-grid batch from
 * producing more than one row on a cell in normal use. */
export function toCellState(rows: ServerSlotRows): PlanningCellState {
  if (rows.hasLeave) return "leave";
  if (rows.hasBlocked) return "blocked";
  if (rows.hasExtra) return "extra_session";
  return "normal";
}

/** What the cell shows right now: the pending edit if there is one, the
 * server's own state otherwise. Computed at render, so a pending edit and
 * the row underneath it can never disagree. */
export function mergeCellState(
  server: PlanningCellState,
  pending: PendingEdit | undefined,
): PlanningCellState {
  if (pending === undefined) return server;
  return pending.action === "clear" ? "normal" : pending.action;
}

/** Membership set over BlockedEntry[] - same shape as toCellKeySet. */
export function toBlockedKeySet(entries: BlockedEntry[]): Set<string> {
  return toCellKeySet(entries);
}

/** (doctor, date, period) -> notes, over any entry list carrying one -
 * built once per fetch, not per cell. Empty/null notes are omitted, so a
 * lookup miss and "no note" both read as undefined. */
export function toNotesMap(
  entries: { doctor_id: number; date: string; period: Period; notes?: string | null }[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of entries) {
    if (entry.notes) map.set(planningCellKey(entry.doctor_id, entry.date, entry.period), entry.notes);
  }
  return map;
}

/** The note belonging to whichever server row is currently active for this
 * cell, empty string if none - same leave > blocked > extra_session
 * precedence as `toCellState`, so the note shown always matches the state
 * shown. */
export function serverNotes(
  leaveNotes: Map<string, string>,
  extraNotes: Map<string, string>,
  blockedNotes: Map<string, string>,
  key: string,
): string {
  return leaveNotes.get(key) ?? blockedNotes.get(key) ?? extraNotes.get(key) ?? "";
}

/** What the cell's notes show right now: the pending edit's notes if
 * there is one, the server's own notes otherwise - the same merge
 * `mergeCellState` does for state. */
export function mergeNotes(server: string, pending: PendingEdit | undefined): string {
  if (pending === undefined) return server;
  return pending.action === "clear" ? "" : pending.notes;
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
 * an empty result gets no planner row.
 *
 * Reuses `overlapsRange` rather than a near-duplicate range comparison: a
 * holiday's start/end are never null (unlike a doctor's window), so
 * `overlapsRange(holiday, date, date)` is exactly the "date falls inside
 * this holiday" test. First matching holiday wins where two overlap for
 * the same school - there is no ordering guarantee to pick between them,
 * and the plan treats overlapping ranges as harmless.
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
 * in-holiday grid column to the holiday covering it, for the cell title - a
 * school with no dates in view gets no row at all. */
export interface SchoolPlannerRow {
  id: number;
  name: string;
  dates: Map<string, SchoolHoliday>;
}

export function templateKey(doctorId: number, day: Day, period: Period): string {
  return `${doctorId}|${day}|${period}`;
}

/**
 * (doctor, day, period) -> session type over the template's **week 1
 * rows only**.
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
 * The extra-session branch is conditional, not a flat +1: a slot already
 * requires_room or pre_assigned is untouched by the override - the doctor
 * was already working it - so counting it again would over-count. The
 * copy loop demotes an admin_time row holding a room to pre_assigned
 * rather than requires_room; both count, so that branch needs no
 * reproduction here.
 */
/** True when the template type is one that puts the doctor in surgery -
 * the same COUNTED_TYPES test the coverage total uses, reused here purely
 * to colour a normal cell (no_surgery/admin_time/wfh/no row all read as
 * "no surgery" the same way they read as zero for coverage). */
export function isSurgerySession(templateType: MasterSessionType | undefined): boolean {
  return templateType !== undefined && COUNTED_TYPES.has(templateType);
}

function isCounted(
  templateType: MasterSessionType | undefined,
  state: PlanningCellState,
): boolean {
  // Blocked is treated exactly like leave for coverage purposes (clinical
  // rota, "Blocked" annual planner option) -- excluded from headcount,
  // without writing a LeaveEntry.
  if (state === "leave" || state === "blocked") return false;
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
  pending: Map<string, PendingEdit>;
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
  blocked: BlockedEntry[];
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
  blocked,
}: CoverageTotalsInput): Map<string, number | null> {
  const totals = new Map<string, number | null>();
  for (const slot of coverage) {
    totals.set(closedSlotKey(slot.date, slot.period), slot.is_closed ? null : slot.headcount);
  }

  const template = buildTemplateIndex(sessions);
  const leaveKeys = toCellKeySet(leave);
  const extraKeys = toCellKeySet(extraSessions);
  const blockedKeys = toCellKeySet(blocked);
  const doctorsById = new Map(doctors.map((d) => [d.id, d]));

  for (const [key, edit] of pending) {
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

    const before = toCellState(serverRows(leaveKeys, extraKeys, blockedKeys, key));
    const after = mergeCellState(before, edit);
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
  pending: Map<string, PendingEdit>;
  leaveKeys: Set<string>;
  extraKeys: Set<string>;
  blockedKeys: Set<string>;
  leaveNotes: Map<string, string>;
  extraNotes: Map<string, string>;
  blockedNotes: Map<string, string>;
}

/**
 * The batch POST /leave-planning/bulk gets: the actions that move each
 * edited cell from its server state to the state the grid is showing,
 * carrying whatever notes the admin typed.
 *
 * Usually one action per cell, but switching to a *different*
 * leave/extra/blocked state emits a `clear` first whenever another row is
 * still present. The bulk endpoint applies clears, then leave, then
 * blocked, then extra sessions (extended for blocked - see
 * leave_planning.py's module docstring), so a `clear` paired with the
 * new state in the same batch removes the old row before the new one is
 * written. Without the clear the endpoint would skip the action -
 * `leave_exists`/`blocked_exists` in one direction, a surviving
 * superseded extra session in the other - and the saved state would not
 * match the grid, which is the one thing a state-setting grid must not
 * do. A cell that keeps its state but changes only its notes needs no
 * clear - the existing row is updated in place.
 *
 * A cell whose pending state *and* notes equal the server's emits
 * nothing; the page also drops such keys from the pending map as they
 * happen, so this is a belt-and-braces filter rather than the only guard.
 */
export function buildPlanningActions({
  pending,
  leaveKeys,
  extraKeys,
  blockedKeys,
  leaveNotes,
  extraNotes,
  blockedNotes,
}: PlanningActionsInput): PlanningActionIn[] {
  const actions: PlanningActionIn[] = [];

  for (const [key, edit] of pending) {
    const cell = parsePlanningCellKey(key);
    if (cell === null) continue;

    const rows = serverRows(leaveKeys, extraKeys, blockedKeys, key);
    const before = toCellState(rows);
    const after = mergeCellState(before, edit);

    const notesBefore = serverNotes(leaveNotes, extraNotes, blockedNotes, key);
    const notesAfter = mergeNotes(notesBefore, edit);
    if (before === after && notesBefore === notesAfter) continue;

    const base = { doctor_id: cell.doctorId, date: cell.date, period: cell.period };
    const needsClear =
      after === "normal" ||
      (rows.hasLeave && after !== "leave") ||
      (rows.hasExtra && after !== "extra_session") ||
      (rows.hasBlocked && after !== "blocked");

    if (needsClear) actions.push({ ...base, action: "clear" });
    if (after !== "normal") {
      actions.push({ ...base, action: stateToAction(after), notes: notesAfter || null });
    }
  }

  return actions;
}
