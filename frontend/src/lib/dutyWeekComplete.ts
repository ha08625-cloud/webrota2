import { Closure, DutyAssignment } from '../api/types';
import { weekDutySlots } from './dutyWeekSlots';

/**
 * True iff every required slot for the week (per weekDutySlots) has a
 * matching DutyAssignment. Closure-aware via `closures` (M5): required
 * slots omit closed dates entirely, so a week with a closed Monday needs
 * no Monday assignment at all to read as complete - see dutyWeekSlots.ts.
 * No separate hardcoding here; completeness derives entirely from
 * weekDutySlots' required-slot list.
 */
export function isDutyWeekComplete(
  weekStartDate: string,
  assignments: DutyAssignment[],
  closures: Closure[] = []
): boolean {
  const requiredSlots = weekDutySlots(weekStartDate, closures);

  return requiredSlots.every((slot) =>
    assignments.some(
      (assignment) =>
        assignment.date === slot.date &&
        assignment.period === slot.period &&
        assignment.duty_type === slot.dutyType
    )
  );
}