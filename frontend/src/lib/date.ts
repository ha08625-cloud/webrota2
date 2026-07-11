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

export function formatDateWithDay(dateString: string): string {
  // Uses parseLocalDate to avoid the UTC midnight parsing bug 
  // that occurs when using the native Date constructor on "YYYY-MM-DD" strings.
  const dayName = parseLocalDate(dateString).toLocaleDateString("en-GB", { weekday: "short" });
  return `${dayName}, ${dateString}`;
}