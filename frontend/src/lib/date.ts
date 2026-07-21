/**
 * Parses a "YYYY-MM-DD" date-only string into a local Date at midnight.
 *
 * Deliberately not `new Date(dateString)`: that form parses date-only
 * strings as UTC midnight, which renders as the previous day in any
 * timezone with a negative UTC offset - silently misjudging which weekday
 * it is. Constructing from the individual components keeps it local.
 */
export function parseLocalDate(dateString: string): Date {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function isMonday(dateString: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    return false;
  }
  return parseLocalDate(dateString).getDay() === 1;
}

export function formatDate(dateString: string): string {
  return parseLocalDate(dateString).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(isoString: string): string {
  return new Date(isoString).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Formats a local Date back into a "YYYY-MM-DD" string. The inverse of
 * parseLocalDate - kept private since every public function here works
 * in terms of the date-only string, not a raw Date, to stay consistent
 * with the rest of the module's contract.
 */
function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Adds (or subtracts, if negative) whole days to a "YYYY-MM-DD" string,
 * returning a "YYYY-MM-DD" string. Built on parseLocalDate + Date's own
 * local-time month/year rollover (setDate), so this never drifts a day
 * at a month or year boundary the way UTC-based arithmetic could.
 */
export function addDays(dateString: string, days: number): string {
  const date = parseLocalDate(dateString);
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

/**
 * Returns `count` upcoming Mondays as "YYYY-MM-DD" strings, starting
 * from `from` (defaults to today) and moving forward. If `from` is
 * itself a Monday it is included as the first result - "today's date
 * forward" per the duty grid's week selector, not "next week onward".
 */
export function getUpcomingMondays(count: number, from: Date = new Date()): string[] {
  let cursor = toDateKey(from);
  while (!isMonday(cursor)) {
    cursor = addDays(cursor, 1);
  }
  const mondays: string[] = [];
  for (let i = 0; i < count; i++) {
    mondays.push(cursor);
    cursor = addDays(cursor, 7);
  }
  return mondays;
}

/**
 * Formats a "YYYY-MM-DD" Monday as "w/c 13 Jul 2026" for the duty grid's
 * week selector. Deliberately pinned to "en-GB" for the month name
 * rather than the `undefined`-locale pattern formatDate/formatDateTime
 * use elsewhere - a select list of week options needs one fixed,
 * unambiguous day-month-year order across every user, not a
 * locale-dependent one.
 */
export function formatWeekLabel(dateString: string): string {
  const date = parseLocalDate(dateString);
  const day = date.getDate();
  const month = date.toLocaleDateString("en-GB", { month: "short" });
  const year = date.getFullYear();
  return `w/c ${day} ${month} ${year}`;
}

/**
 * The fixed origin of the 4-weekly duty period cycle - a Monday. The
 * practice is not currently running a 4-weekly cycle, so this is simply
 * the Monday of the week this feature was written; every period start is
 * `anchor + n * 28 days`. Changing the phase later means editing this
 * constant and redeploying.
 */
export const DUTY_PERIOD_ANCHOR = "2026-07-20";

/** Length of a duty period in weeks. Drives both the dropdown window and
 * the counter date range, so the two can never drift apart. */
export const DUTY_PERIOD_WEEKS = 4;

/**
 * Converts a "YYYY-MM-DD" string to a UTC epoch value for period-index
 * arithmetic. Deliberately UTC, not local: `floor((date - anchor) / 28
 * days)` computed over local millisecond values is off by one for any
 * 28-day span that crosses a DST change (that span is 28 days minus or
 * plus one hour locally). UTC values have no DST, so the index is always
 * an exact multiple of 28 days. Do not "simplify" this back to local-time
 * subtraction.
 */
function toUtcMs(dateString: string): number {
  const [year, month, day] = dateString.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/**
 * Returns the "YYYY-MM-DD" start date of the fixed 4-weekly duty period
 * containing `dateString`. Uses `Math.floor`, not truncating division, so
 * dates before the anchor resolve to the correct (negative) period index
 * rather than rounding toward the anchor.
 */
export function getDutyPeriodStart(dateString: string): string {
  const periodMs = DUTY_PERIOD_WEEKS * 7 * 86_400_000;
  const index = Math.floor((toUtcMs(dateString) - toUtcMs(DUTY_PERIOD_ANCHOR)) / periodMs);
  return addDays(DUTY_PERIOD_ANCHOR, index * DUTY_PERIOD_WEEKS * 7);
}

/**
 * Returns the "YYYY-MM-DD" start dates of `pastCount` periods before,
 * the period containing `from` (defaults to today), and `futureCount`
 * periods after - ascending. Mirrors getUpcomingMondays' `Date` parameter
 * so both can be driven by the same kind of test fixture.
 */
export function getDutyPeriodStarts(pastCount: number, futureCount: number, from: Date = new Date()): string[] {
  const currentStart = getDutyPeriodStart(toDateKey(from));
  const starts: string[] = [];
  for (let i = -pastCount; i <= futureCount; i++) {
    starts.push(addDays(currentStart, i * DUTY_PERIOD_WEEKS * 7));
  }
  return starts;
}

/**
 * Formats a "YYYY-MM-DD" period start as its inclusive span, e.g.
 * "20 Jul - 16 Aug 2026" or, crossing a year, "21 Dec 2026 - 17 Jan 2027".
 * Pinned to "en-GB" for month names for the same reason formatWeekLabel
 * is - a select list needs one unambiguous day-month-year order for
 * every user, not a locale-dependent one.
 */
export function formatPeriodLabel(startDateString: string): string {
  const endDateString = addDays(startDateString, DUTY_PERIOD_WEEKS * 7 - 1);
  const start = parseLocalDate(startDateString);
  const end = parseLocalDate(endDateString);

  const startDay = start.getDate();
  const startMonth = start.toLocaleDateString("en-GB", { month: "short" });
  const startYear = start.getFullYear();
  const endDay = end.getDate();
  const endMonth = end.toLocaleDateString("en-GB", { month: "short" });
  const endYear = end.getFullYear();

  const startLabel = startYear === endYear ? `${startDay} ${startMonth}` : `${startDay} ${startMonth} ${startYear}`;
  return `${startLabel} - ${endDay} ${endMonth} ${endYear}`;
}