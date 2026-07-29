/**
 * The reception day's fixed hour range, mirroring
 * RECEPTION_FIRST_HOUR/RECEPTION_LAST_HOUR in backend/app/models/reception.py.
 * Widening the practice's opening hours is a migration on the backend
 * (the check constraint) plus a change here - see the reception rota plan,
 * Design Decision 2.
 */
export const RECEPTION_HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17] as const;

/** formatHour(8) -> "08:00-09:00". The single formatter - no component builds an hour label inline. */
export function formatHour(hour: number): string {
  const pad = (h: number) => h.toString().padStart(2, "0");
  return `${pad(hour)}:00-${pad(hour + 1)}:00`;
}
