import type { DutyAssignment, DutyType, Period } from "@/api/types";
import { addDays } from "@/lib/date";

const TUE_FRI_DAYS = ["Tuesday", "Wednesday", "Thursday", "Friday"] as const;
const TUE_FRI_OFFSETS = [1, 2, 3, 4];

const PERIODS: Period[] = ["AM", "PM"];

/** One of the duty board's 6 layout columns for a week. Periods are grid
 * rows, not columns - so this deliberately has no period field. */
export interface Column {
  key: string;
  label: string;
  date: string;
  dutyType: DutyType;
}

/** Builds one week's 6 columns (Mon-primary, Mon-secondary, Tue..Fri) for
 * a given week-start Monday. Extracted verbatim from DutyGrid.tsx so the
 * grid layout and the completion check share one slot definition. */
export function buildColumns(weekStartDate: string): Column[] {
  const columns: Column[] = [
    { key: "mon-primary", label: "Mon (1st)", date: weekStartDate, dutyType: "primary" },
    { key: "mon-secondary", label: "Mon (2nd)", date: weekStartDate, dutyType: "secondary" },
  ];
  TUE_FRI_DAYS.forEach((day, i) => {
    columns.push({
      key: day,
      label: day.slice(0, 3),
      date: addDays(weekStartDate, TUE_FRI_OFFSETS[i]),
      dutyType: "primary",
    });
  });
  return columns;
}

/** One of the 12 concrete (date, period, duty_type) duty slots in a week. */
export interface DutySlotKey {
  date: string; // YYYY-MM-DD
  period: Period;
  dutyType: DutyType;
}

/** All 12 duty slots for the week starting at the given Monday:
 * the 6 columns x AM/PM. Canonical completion rule: a week is fully
 * staffed iff every one of these slots has a DutyAssignment. The future
 * Phase 0 hard block re-implements this same rule server-side. */
export function weekDutySlots(weekStartDate: string): DutySlotKey[] {
  return buildColumns(weekStartDate).flatMap((col) =>
    PERIODS.map((period) => ({ date: col.date, period, dutyType: col.dutyType })),
  );
}

/** True iff some assignment fills the given slot exactly. Doctor identity
 * is irrelevant; assignments outside the slot are ignored. */
export function slotFilled(slot: DutySlotKey, assignments: DutyAssignment[]): boolean {
  return assignments.some(
    (a) => a.date === slot.date && a.period === slot.period && a.duty_type === slot.dutyType,
  );
}