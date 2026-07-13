import type { Closure, DutyAssignment, DutyType, Period } from "@/api/types";
import { addDays } from "@/lib/date";

const WEEKDAY_OFFSETS = [0, 1, 2, 3, 4];
const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

const PERIODS: Period[] = ["AM", "PM"];

/**
 * One of the duty board's layout columns for a week. Periods are grid
 * rows, not columns - so this deliberately has no period field.
 *
 * `closed` (M5) marks an inert column for a closed weekday: duty is never
 * expected on a closed date, so `dutyType` is null there and non-null for
 * every open column.
 */
export interface Column {
  key: string;
  label: string;
  date: string;
  dutyType: DutyType | null;
  closed: boolean;
}

function weekdayDate(weekStartDate: string, offset: number): string {
  return addDays(weekStartDate, offset);
}

/**
 * The first weekday (Mon..Fri) of the week starting at weekStartDate that
 * is not closed, or null if the whole week is closed.
 *
 * Frontend mirror of the backend's week_map.build_first_open_weekday (M5
 * plan review note 2) - deliberately reimplemented rather than shared,
 * since the two run in different languages; see weekDutySlots_test.ts for
 * the matching case matrix (open week, closed Monday, closed Mon+Tue,
 * fully closed week) that keeps the two from drifting apart.
 */
export function firstOpenWeekday(weekStartDate: string, closedDates: Set<string>): string | null {
  for (const offset of WEEKDAY_OFFSETS) {
    const date = weekdayDate(weekStartDate, offset);
    if (!closedDates.has(date)) return date;
  }
  return null;
}

/**
 * Builds one week's duty-board columns for a given week-start Monday.
 * Normally 6 columns (Mon-primary, Mon-secondary, Tue..Fri primary-only).
 *
 * Closure-aware (M5): a closed weekday becomes one inert `closed` column
 * (no duty type, nothing to fill), and the secondary-duty pair attaches
 * to the week's first *open* weekday instead of always Monday - this is
 * the frontend counterpart of Phase 12's `_expected_duty_counts`
 * (phase12.py). With no closures this reduces exactly to the pre-M5
 * behaviour: firstOpenWeekday is always Monday, so labels and columns are
 * unchanged.
 */
export function buildColumns(weekStartDate: string, closures: Closure[] = []): Column[] {
  const closedDates = new Set(closures.map((c) => c.date));
  const firstOpen = firstOpenWeekday(weekStartDate, closedDates);

  const columns: Column[] = [];
  WEEKDAY_OFFSETS.forEach((offset) => {
    const date = weekdayDate(weekStartDate, offset);
    const label = WEEKDAY_LABELS[offset];

    if (closedDates.has(date)) {
      columns.push({ key: `closed-${date}`, label, date, dutyType: null, closed: true });
      return;
    }

    if (date === firstOpen) {
      columns.push({
        key: `${date}-primary`, label: `${label} (1st)`, date, dutyType: "primary", closed: false,
      });
      columns.push({
        key: `${date}-secondary`, label: `${label} (2nd)`, date, dutyType: "secondary", closed: false,
      });
      return;
    }

    columns.push({ key: date, label, date, dutyType: "primary", closed: false });
  });
  return columns;
}

/** One of the concrete (date, period, duty_type) duty slots required in a
 * week. */
export interface DutySlotKey {
  date: string; // YYYY-MM-DD
  period: Period;
  dutyType: DutyType;
}

/**
 * All required duty slots for the week starting at the given Monday:
 * every *open* column x AM/PM. A closed weekday's column is still
 * rendered (inert) in the grid but contributes no required slots here -
 * canonical completion rule: a week is fully staffed iff every one of
 * these slots has a DutyAssignment. Phase 0's duty_on_closed_date check
 * and Phase 12's closure-aware expected counts are the server-side
 * versions of this same rule.
 */
export function weekDutySlots(weekStartDate: string, closures: Closure[] = []): DutySlotKey[] {
  return buildColumns(weekStartDate, closures)
    .filter((col): col is Column & { dutyType: DutyType } => col.dutyType !== null)
    .flatMap((col) => PERIODS.map((period) => ({ date: col.date, period, dutyType: col.dutyType })));
}

/** True iff some assignment fills the given slot exactly. Doctor identity
 * is irrelevant; assignments outside the slot are ignored. */
export function slotFilled(slot: DutySlotKey, assignments: DutyAssignment[]): boolean {
  return assignments.some(
    (a) => a.date === slot.date && a.period === slot.period && a.duty_type === slot.dutyType,
  );
}