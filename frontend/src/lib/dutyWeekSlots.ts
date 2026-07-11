import { addDays } from './date';
import { Period, DutyType } from '../api/types'; // Adjust imports to match your types

export const PERIODS: Period[] = ['AM', 'PM'];
export const TUE_FRI_DAYS = ['Tuesday', 'Wednesday', 'Thursday', 'Friday'];
export const TUE_FRI_OFFSETS = [1, 2, 3, 4];

export interface Column {
  id: string;
  label: string;
  date: string;
  period: Period;
  dutyType: DutyType;
}

export interface DutySlotKey {
  date: string;
  period: Period;
  dutyType: DutyType;
}

/** 
 * Extracted from DutyGrid.tsx. 
 * Generates the 12 columns required for a standard week on the grid.
 */
export function buildColumns(weekStartDate: string): Column[] {
  const columns: Column[] = [];

  PERIODS.forEach((period) => {
    columns.push({
      id: `mon-${period.toLowerCase()}-primary`,
      label: `Monday ${period}`,
      date: weekStartDate,
      period,
      dutyType: 'primary',
    });
    columns.push({
      id: `mon-${period.toLowerCase()}-secondary`,
      label: `Monday ${period} (2nd)`,
      date: weekStartDate,
      period,
      dutyType: 'secondary',
    });

    TUE_FRI_DAYS.forEach((dayLabel, index) => {
      columns.push({
        id: `${dayLabel.toLowerCase().slice(0, 3)}-${period.toLowerCase()}-primary`,
        label: `${dayLabel} ${period}`,
        date: addDays(weekStartDate, TUE_FRI_OFFSETS[index]),
        period,
        dutyType: 'primary',
      });
    });
  });

  return columns;
}

/** All 12 duty slots for the week starting at the given Monday. */
export function weekDutySlots(weekStartDate: string): DutySlotKey[] {
  return buildColumns(weekStartDate).map((col) => ({
    date: col.date,
    period: col.period,
    dutyType: col.dutyType,
  }));
}