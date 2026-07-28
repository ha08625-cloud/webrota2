import type { Day } from "@/api/types";
import { addDays } from "@/lib/date";

/** Monday..Friday offsets in days from the week's Monday. Mirrors the
 * backend's week_map.DAY_ORDER exactly. */
const DAY_OFFSETS: Record<Day, number> = {
  Monday: 0,
  Tuesday: 1,
  Wednesday: 2,
  Thursday: 3,
  Friday: 4,
};

/**
 * Maps a rota's (generation week, day) onto a calendar date, given the
 * rota's start_date (a Monday) - the frontend mirror of the backend's
 * week_map.build_week_dates. RotaGrid needs this
 * to know which calendar date a given day column represents, so it can
 * check that date against rota.closed_slots.
 *
 * genWeek is 1-indexed, matching RotaSession.week.
 */
export function rotaDate(startDate: string, genWeek: number, day: Day): string {
  const weekMonday = addDays(startDate, (genWeek - 1) * 7);
  return addDays(weekMonday, DAY_OFFSETS[day]);
}