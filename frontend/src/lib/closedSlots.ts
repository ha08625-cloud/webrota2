import type { Period } from "@/api/types";

/**
 * Shared (date, period) closed-slot lookup, used everywhere a closure list
 * (`Closure[]` from useClosures) or a rota/staging snapshot (`ClosedSlot[]`)
 * needs to answer "is this slot closed". `Closure` and `ClosedSlot` are
 * structurally compatible for this purpose, so callers pass either.
 */

interface DateAndPeriod {
  date: string;
  period: Period;
}

export function closedSlotKey(date: string, period: Period): string {
  return `${date}|${period}`;
}

export function toClosedSlotSet(slots: DateAndPeriod[]): Set<string> {
  return new Set(slots.map((s) => closedSlotKey(s.date, s.period)));
}

export function isSlotClosed(set: Set<string>, date: string, period: Period): boolean {
  return set.has(closedSlotKey(date, period));
}

/** True iff both AM and PM are closed for this date. */
export function isDayFullyClosed(set: Set<string>, date: string): boolean {
  return isSlotClosed(set, date, "AM") && isSlotClosed(set, date, "PM");
}

/** True iff exactly one of AM/PM is closed for this date. */
export function isDayPartlyClosed(set: Set<string>, date: string): boolean {
  return isSlotClosed(set, date, "AM") !== isSlotClosed(set, date, "PM");
}

/**
 * The single closed period for a partly-closed date, for the qualified
 * header label ("Training (PM)"). Only meaningful when
 * isDayPartlyClosed(set, date) is true - returns null otherwise (nothing
 * closed, or fully closed, where the header uses the unqualified label).
 */
export function partlyClosedPeriod(set: Set<string>, date: string): Period | null {
  if (!isDayPartlyClosed(set, date)) return null;
  return isSlotClosed(set, date, "AM") ? "AM" : "PM";
}
