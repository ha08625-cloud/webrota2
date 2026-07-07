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