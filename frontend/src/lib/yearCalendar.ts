import { addDays, parseLocalDate } from "@/lib/date";

/**
 * Pure month-grid arithmetic behind the individual leave tab's year-at-a-
 * glance calendar. Unlike LeaveRangePreview's Mon-Fri grid (weekends are
 * never plannable there), this shows full Mon-Sun weeks - it is a read-only
 * overview of a whole year, so it should read like an ordinary calendar,
 * including the rare legacy weekend leave entry.
 */

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Every date, "YYYY-MM-DD", in the Mon-Sun weeks touching the given
 * calendar month, split into 7-day rows. The first/last row is padded with
 * lead-in/lead-out days borrowed from the adjacent month so every row is a
 * full week - `isInYearMonth` tells the grid which of those to dim.
 */
export function monthWeeks(year: number, month: number): string[][] {
  const monthKey = `${year}-${pad2(month)}`;
  const firstOfMonth = `${monthKey}-01`;
  const daysInMonth = new Date(year, month, 0).getDate();
  const lastOfMonth = `${monthKey}-${pad2(daysInMonth)}`;

  // getDay(): Sun=0..Sat=6; offset back to the week's Monday.
  const offsetToMonday = (parseLocalDate(firstOfMonth).getDay() + 6) % 7;
  let cursor = addDays(firstOfMonth, -offsetToMonday);

  const weeks: string[][] = [];
  while (cursor <= lastOfMonth) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(cursor, i)));
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

/** Whether `date` falls within the given calendar month, as opposed to
 * being a lead-in/lead-out day borrowed to complete a week in `monthWeeks`. */
export function isInYearMonth(date: string, year: number, month: number): boolean {
  return date.startsWith(`${year}-${pad2(month)}-`);
}

export function monthName(month: number): string {
  return new Date(2000, month - 1, 1).toLocaleDateString("en-GB", { month: "long" });
}
