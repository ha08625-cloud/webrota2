import type { PeriodOrBoth } from "@/api/types";

import { addDays } from "./date";

/**
 * Half-day options at the edges of a leave range (the Timetastic
 * pattern): a doctor who leaves at lunchtime on the first day is on
 * leave for that day's PM only; one who returns at lunchtime on the
 * last day is on leave for that day's AM only. Interior days are
 * always full days.
 */
export type FirstDayOption = "FULL" | "PM_ONLY";
export type LastDayOption = "FULL" | "AM_ONLY";

/** The single-day form of the same choice (start === end). */
export type SingleDayOption = "FULL" | "AM_ONLY" | "PM_ONLY";

/**
 * One contiguous run of leave with a uniform period - the exact shape of
 * a POST /leave/bulk or POST /leave/bulk-delete body minus doctor_id.
 */
export interface LeaveSegment {
  start_date: string;
  end_date: string;
  period: PeriodOrBoth;
}

/**
 * Expands a date range plus edge half-day options into 1-3 *disjoint*
 * segments (no date+period is ever covered by two segments), in
 * chronological order:
 *
 * - both edges FULL              -> [(start, end, BOTH)]
 * - first day PM only            -> (start, start, PM) precedes the interior
 * - last day AM only             -> (end, end, AM) follows the interior
 * - a 2-day range with both half
 *   edges has no interior at all -> exactly 2 segments (the legitimate
 *   "off Wed lunchtime, back Thu lunchtime" case)
 * - start === end                -> exactly 1 segment; the contradictory
 *   (PM_ONLY, AM_ONLY) pair throws rather than silently emitting two
 *   half-day segments for one day. The form's single "Day" select makes
 *   this state unreachable from the UI (see singleDayToEdges); the throw
 *   is a guard against future programmatic callers.
 *
 * All weekend behaviour is deliberately left to the server: bulk add
 * skips weekend dates (reported as skipped), bulk delete does not
 * weekday-filter. This function does no weekend logic of its own.
 *
 * Dates are "YYYY-MM-DD" strings throughout; lexicographic comparison
 * on that format is chronological, so no Date parsing is needed here
 * beyond what addDays does internally.
 */
export function expandLeaveRange(
  start: string,
  end: string,
  firstDay: FirstDayOption,
  lastDay: LastDayOption,
): LeaveSegment[] {
  if (start > end) {
    throw new Error("start date must not be after end date");
  }

  if (start === end) {
    if (firstDay === "PM_ONLY" && lastDay === "AM_ONLY") {
      throw new Error("contradictory half-day options for a single-day range");
    }
    if (firstDay === "PM_ONLY") return [{ start_date: start, end_date: start, period: "PM" }];
    if (lastDay === "AM_ONLY") return [{ start_date: start, end_date: start, period: "AM" }];
    return [{ start_date: start, end_date: start, period: "BOTH" }];
  }

  const segments: LeaveSegment[] = [];
  const interiorStart = firstDay === "PM_ONLY" ? addDays(start, 1) : start;
  const interiorEnd = lastDay === "AM_ONLY" ? addDays(end, -1) : end;

  if (firstDay === "PM_ONLY") {
    segments.push({ start_date: start, end_date: start, period: "PM" });
  }
  if (interiorStart <= interiorEnd) {
    segments.push({ start_date: interiorStart, end_date: interiorEnd, period: "BOTH" });
  }
  if (lastDay === "AM_ONLY") {
    segments.push({ start_date: end, end_date: end, period: "AM" });
  }
  return segments;
}

/**
 * Maps the form's single-day "Day" select onto the (firstDay, lastDay)
 * pair expandLeaveRange takes, so single-day and multi-day submissions
 * share one code path. The contradictory pair is unrepresentable through
 * this mapping - one select can't pick both halves.
 */
export function singleDayToEdges(option: SingleDayOption): {
  firstDay: FirstDayOption;
  lastDay: LastDayOption;
} {
  if (option === "AM_ONLY") return { firstDay: "FULL", lastDay: "AM_ONLY" };
  if (option === "PM_ONLY") return { firstDay: "PM_ONLY", lastDay: "FULL" };
  return { firstDay: "FULL", lastDay: "FULL" };
}

/**
 * Expands segments into the set of individual (date, period) sessions
 * they cover, keyed "YYYY-MM-DD|AM" / "YYYY-MM-DD|PM". Used by the
 * calendar preview for membership tests, and by tests to assert the
 * disjointness property directly. Weekend dates are included (the
 * caller decides what to do with them - the preview simply never
 * renders a weekend cell).
 */
export function segmentsToSessionKeys(segments: LeaveSegment[]): Set<string> {
  const keys = new Set<string>();
  for (const segment of segments) {
    for (let day = segment.start_date; day <= segment.end_date; day = addDays(day, 1)) {
      if (segment.period === "AM" || segment.period === "BOTH") keys.add(`${day}|AM`);
      if (segment.period === "PM" || segment.period === "BOTH") keys.add(`${day}|PM`);
    }
  }
  return keys;
}

export function sessionKey(date: string, period: "AM" | "PM"): string {
  return `${date}|${period}`;
}