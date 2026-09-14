import type { Day, Doctor, Period, RotaSession } from "@/api/types";
import {
  getSessionCell,
  pivotSessions,
  weekNumbers,
  type PivotedSessionGrid,
} from "@/lib/pivotSessions";

export { weekNumbers };
export type { GridRow } from "@/lib/pivotSessions";

export const DAYS: Day[] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
export const PERIODS: Period[] = ["AM", "PM"];

/**
 * The generated rota's grid. Its week domain is RotaConfig.num_weeks,
 * which callers turn into tabs/pages with weekNumbers - it is not carried
 * on the grid, unlike pivotMasterRota's fixed weeks.
 */
export type PivotedGrid = PivotedSessionGrid<RotaSession>;

/**
 * Builds the pivoted grid for one generated rota. See pivotSessions for
 * the row-ordering and absent-cell rules, which are shared with the
 * master template and staging grids. `doctors` should be the full list
 * (active_only=false) so inactive-but-present doctors can be detected
 * and flagged rather than silently dropped.
 */
export function pivotRota(sessions: RotaSession[], doctors: Doctor[]): PivotedGrid {
  return pivotSessions(sessions, doctors);
}

export function getCell(
  grid: PivotedGrid,
  doctorId: number,
  week: number,
  day: Day,
  period: Period,
): RotaSession | undefined {
  return getSessionCell(grid, doctorId, week, day, period);
}
