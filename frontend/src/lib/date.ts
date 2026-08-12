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
 * Returns `pastCount` + `futureCount` + 1 Mondays, ascending, centred on
 * the current-or-next Monday from `from` (defaults to today) - the same
 * "today forward" anchor as getUpcomingMondays, extended backward too.
 * Backs the reception day rota's week-commencing dropdown, which - unlike the forward-only staging week selector this
 * mirrors - needs recent past weeks reachable too, since an already
 * generated week stays editable indefinitely.
 */
export function getSurroundingMondays(pastCount: number, futureCount: number, from: Date = new Date()): string[] {
  const anchor = getUpcomingMondays(1, from)[0];
  const mondays: string[] = [];
  for (let i = -pastCount; i <= futureCount; i++) {
    mondays.push(addDays(anchor, i * 7));
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

export function formatDateWithDay(dateString: string): string {
  // Uses parseLocalDate to avoid the UTC midnight parsing bug
  // that occurs when using the native Date constructor on "YYYY-MM-DD" strings.
  const dayName = parseLocalDate(dateString).toLocaleDateString("en-GB", { weekday: "short" });
  return `${dayName}, ${dateString}`;
}

/**
 * Formats a school holiday's inclusive range as e.g.
 * "Monday 21/7/26 - Friday 31/8/26", or the single date alone
 * (no dash) when start and end are the same day. Full weekday name +
 * `d/m/yy`, pinned to "en-GB" like formatWeekLabel/formatPeriodLabel - no
 * existing helper produces this exact format, and the planner row tooltip
 * reuses it alongside the School Holidays page.
 */
export function formatHolidayRange(start: string, end: string): string {
  function formatOne(dateString: string): string {
    const date = parseLocalDate(dateString);
    const weekday = date.toLocaleDateString("en-GB", { weekday: "long" });
    const day = date.getDate();
    const month = date.getMonth() + 1;
    const year = String(date.getFullYear()).slice(-2);
    return `${weekday} ${day}/${month}/${year}`;
  }

  if (start === end) {
    return formatOne(start);
  }
  return `${formatOne(start)} – ${formatOne(end)}`;
}

// --- 4-weekly duty periods ---------------------------------------------

/**
 * A Monday. The team is not currently running a 4-weekly duty cycle, so
 * this phase is arbitrary - it is simply the Monday of the week this
 * constant was introduced. Every period start is anchor + n * 28 days,
 * n negative for periods before the anchor. Hardcoded rather than derived
 * from "this week's Monday", since deriving it would shift every boundary
 * forward a week whenever the week ticks over, defeating the point of a
 * fixed cycle. Changing the phase later means editing this constant and
 * redeploying.
 */
export const DUTY_PERIOD_ANCHOR = "2026-07-20";

/** Length of a duty period in weeks. Drives both the DutyGrid window and the counter date range, so the two can never drift apart. */
export const DUTY_PERIOD_WEEKS = 4;

/**
 * Converts a "YYYY-MM-DD" string to a UTC epoch value. Used only for the
 * period-index arithmetic below - see getDutyPeriodStart for why UTC
 * matters there.
 */
function toUTCEpoch(dateString: string): number {
  const [year, month, day] = dateString.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/**
 * Returns the "YYYY-MM-DD" start date of the fixed 28-day duty period
 * containing `dateString`.
 *
 * The period index is computed on UTC epoch values, not local
 * milliseconds. floor((date - anchor) / 28 days) over local Date objects
 * is off by one for any period spanning a DST change, since a 28-day span
 * containing the October UK clock change is actually 28 days + 1 hour of
 * wall-clock time in local milliseconds. Date.UTC(...) values have no DST,
 * so the index is always exactly right; the resulting start date is then
 * produced with the existing DST-safe addDays. Do not "simplify" this back
 * to local-time subtraction - that reintroduces the off-by-one.
 *
 * Math.floor (not truncating division) is required so dates before the
 * anchor produce the correct negative index.
 */
export function getDutyPeriodStart(dateString: string): string {
  const periodMs = DUTY_PERIOD_WEEKS * 7 * 86_400_000;
  const index = Math.floor((toUTCEpoch(dateString) - toUTCEpoch(DUTY_PERIOD_ANCHOR)) / periodMs);
  return addDays(DUTY_PERIOD_ANCHOR, index * DUTY_PERIOD_WEEKS * 7);
}

/**
 * Returns the "YYYY-MM-DD" start dates of the duty period containing
 * `from` (defaults to today), plus `pastCount` periods before it and
 * `futureCount` periods after it, ascending. `pastCount + futureCount + 1`
 * results in total. Takes a Date (matching getUpcomingMondays' signature)
 * so callers can pass `new Date()` directly.
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
 * Returns the "1 Jan - 31 Dec" span of the calendar year containing
 * `dateString`, as "YYYY-MM-DD" from/to strings. Backs the Duty page's
 * annual counter, which deliberately tracks a fixed calendar year rather
 * than a rolling 12 months - arbitrary cutoffs are acceptable for this
 * feature (user-confirmed). `to` is inclusive (Dec 31), matching the
 * `/duty/counts` endpoint's inclusive `to_date` semantics, so this is
 * equivalent to "up to but not including next 1 Jan" without an
 * addDays year-rollover call.
 */
export function getYearRange(dateString: string): { from: string; to: string } {
  const year = parseLocalDate(dateString).getFullYear();
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

/**
 * Formats a duty period's inclusive span, e.g. "20 Jul - 16 Aug 2026" or,
 * crossing a year boundary, "21 Dec 2026 - 17 Jan 2027". Pinned to
 * "en-GB" for month names for the same reason formatWeekLabel is - a
 * select list needs one unambiguous day-month-year order for every user,
 * not a locale-dependent one.
 */
export function formatPeriodLabel(startDateString: string): string {
  const start = parseLocalDate(startDateString);
  const end = parseLocalDate(addDays(startDateString, DUTY_PERIOD_WEEKS * 7 - 1));

  const startDay = start.getDate();
  const startMonth = start.toLocaleDateString("en-GB", { month: "short" });
  const startYear = start.getFullYear();

  const endDay = end.getDate();
  const endMonth = end.toLocaleDateString("en-GB", { month: "short" });
  const endYear = end.getFullYear();

  if (startYear === endYear) {
    return `${startDay} ${startMonth} - ${endDay} ${endMonth} ${endYear}`;
  }
  return `${startDay} ${startMonth} ${startYear} - ${endDay} ${endMonth} ${endYear}`;
}