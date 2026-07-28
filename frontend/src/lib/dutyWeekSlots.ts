import type { Closure, DutyAssignment, DutyType, Period } from "@/api/types";
import { addDays } from "@/lib/date";
import { isDayFullyClosed, isSlotClosed, toClosedSlotSet } from "@/lib/closedSlots";

const WEEKDAY_OFFSETS = [0, 1, 2, 3, 4];
const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

const PERIODS: Period[] = ["AM", "PM"];

/**
 * One of the duty board's layout columns for a week. Periods are grid
 * rows, not columns - so this deliberately has no period field.
 *
 * `fullyClosed` marks an inert column for a weekday closed on both AM and
 * PM: duty is never expected there, so `dutyType` is null. A day closed on
 * only one period is an ordinary open column (`fullyClosed: false`) - see
 * `weekDutySlots`, which drops just the closed period's slot for it.
 */
export interface Column {
  key: string;
  label: string;
  date: string;
  dutyType: DutyType | null;
  fullyClosed: boolean;
}

function weekdayDate(weekStartDate: string, offset: number): string {
  return addDays(weekStartDate, offset);
}

/**
 * The first weekday (Mon..Fri) of the week starting at weekStartDate that
 * is *fully* open - neither its AM nor its PM slot is closed - or null if
 * no weekday qualifies.
 *
 * Frontend mirror of the backend's week_map.build_first_open_weekday
 * (half-day closures plan, Design Decision 4) - deliberately reimplemented
 * rather than shared, since the two run in different languages; see
 * dutyWeekSlots.test.ts for the matching case matrix (open week, closed
 * Monday, closed Mon+Tue, fully closed week, partly closed Monday) that
 * keeps the two from drifting apart. A day is required to be fully open,
 * not merely partly, because secondary duty needs both periods of its day
 * (Phase 12's `_expected_duty_counts` is period-independent for
 * `expected_secondary`, and the `(1st)`/`(2nd)` column split below assumes
 * both AM and PM exist).
 */
export function firstOpenWeekday(weekStartDate: string, closedSet: Set<string>): string | null {
  for (const offset of WEEKDAY_OFFSETS) {
    const date = weekdayDate(weekStartDate, offset);
    if (!isSlotClosed(closedSet, date, "AM") && !isSlotClosed(closedSet, date, "PM")) return date;
  }
  return null;
}

/**
 * Builds one week's duty-board columns for a given week-start Monday.
 * Normally 6 columns (Mon-primary, Mon-secondary, Tue..Fri primary-only).
 *
 * Closure-aware: a fully closed weekday becomes one inert column (no duty
 * type, nothing to fill), and the secondary-duty pair attaches to the
 * week's first *fully open* weekday instead of always Monday. A weekday
 * closed on only one period is an ordinary primary-only column, exactly
 * like an open day - it can never be the first fully-open weekday, so it
 * never needs the `(1st)`/`(2nd)` split (Design Decision 4). With no
 * closures this reduces exactly to the pre-M5 behaviour: firstOpenWeekday
 * is always Monday, so labels and columns are unchanged.
 */
export function buildColumns(weekStartDate: string, closures: Closure[] = []): Column[] {
  const closedSet = toClosedSlotSet(closures);
  const firstOpen = firstOpenWeekday(weekStartDate, closedSet);

  const columns: Column[] = [];
  WEEKDAY_OFFSETS.forEach((offset) => {
    const date = weekdayDate(weekStartDate, offset);
    const label = WEEKDAY_LABELS[offset];

    if (isDayFullyClosed(closedSet, date)) {
      columns.push({ key: `closed-${date}`, label, date, dutyType: null, fullyClosed: true });
      return;
    }

    if (date === firstOpen) {
      columns.push({
        key: `${date}-primary`, label: `${label} (1st)`, date, dutyType: "primary", fullyClosed: false,
      });
      columns.push({
        key: `${date}-secondary`, label: `${label} (2nd)`, date, dutyType: "secondary", fullyClosed: false,
      });
      return;
    }

    columns.push({ key: date, label, date, dutyType: "primary", fullyClosed: false });
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
 * every *open* column x its open period(s). A fully closed weekday's
 * column is still rendered (inert) in the grid but contributes no required
 * slots here; a partly closed weekday's column contributes only its open
 * period's slot. Canonical completion rule: a week is fully staffed iff
 * every one of these slots has a DutyAssignment. Phase 0's
 * duty_on_closed_date check and Phase 12's closure-aware expected counts
 * are the server-side versions of this same rule.
 */
export function weekDutySlots(weekStartDate: string, closures: Closure[] = []): DutySlotKey[] {
  const closedSet = toClosedSlotSet(closures);
  return buildColumns(weekStartDate, closures)
    .filter((col): col is Column & { dutyType: DutyType } => col.dutyType !== null)
    .flatMap((col) =>
      PERIODS.filter((period) => !isSlotClosed(closedSet, col.date, period)).map((period) => ({
        date: col.date,
        period,
        dutyType: col.dutyType,
      })),
    );
}

/** True iff some assignment fills the given slot exactly. Doctor identity
 * is irrelevant; assignments outside the slot are ignored. */
export function slotFilled(slot: DutySlotKey, assignments: DutyAssignment[]): boolean {
  return assignments.some(
    (a) => a.date === slot.date && a.period === slot.period && a.duty_type === slot.dutyType,
  );
}
