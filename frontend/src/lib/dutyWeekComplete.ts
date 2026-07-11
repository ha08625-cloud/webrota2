import { DutyAssignment } from '../api/types';
import { weekDutySlots } from './dutyWeekSlots';

export function isDutyWeekComplete(
  weekStartDate: string,
  assignments: DutyAssignment[]
): boolean {
  const requiredSlots = weekDutySlots(weekStartDate);

  return requiredSlots.every((slot) =>
    assignments.some(
      (assignment) =>
        assignment.date === slot.date &&
        assignment.period === slot.period &&
        assignment.duty_type === slot.dutyType
    )
  );
}