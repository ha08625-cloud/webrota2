/**
 * The reception day's fixed half-hour slots, mirroring
 * RECEPTION_FIRST_HOUR/RECEPTION_LAST_HOUR/RECEPTION_HOURS in
 * backend/app/models/reception.py. `hour` values are whole or half hours
 * (7.5, 8, 8.5, ...) - see that file's "Half-hour granularity" note for why
 * the field kept its name and int-vs-float precision is the only change.
 * Widening the practice's opening hours is a migration on the backend
 * (the check constraint) plus a change here.
 */
export const RECEPTION_HOURS = [
  7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16, 16.5, 17,
  17.5, 18,
] as const;

function hourLabel(hour: number): string {
  const whole = Math.floor(hour);
  const minutes = hour - whole >= 0.5 ? "30" : "00";
  return `${whole.toString().padStart(2, "0")}:${minutes}`;
}

/** formatHour(8) -> "08:00-08:30", formatHour(8.5) -> "08:30-09:00". The single formatter - no component builds an hour label inline. */
export function formatHour(hour: number): string {
  return `${hourLabel(hour)}-${hourLabel(hour + 0.5)}`;
}

/**
 * formatHourStart(8) -> "08:00". The grid's column headers label the tick a
 * slot starts on rather than its full range: at 22 columns the two-line
 * "08:00-08:30" was what forced every column wide enough to need horizontal
 * scrolling. The full range is still what screen readers and tooltips get -
 * see ReceptionGrid's header cells.
 */
export function formatHourStart(hour: number): string {
  return hourLabel(hour);
}
