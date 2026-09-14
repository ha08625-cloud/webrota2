import type { Day, Doctor, Period, StagingSession } from "@/api/types";
import {
  getSessionCell,
  pivotSessions,
  weekNumbers,
  type PivotedSessionGrid,
} from "@/lib/pivotSessions";

export interface PivotedStagingGrid extends PivotedSessionGrid<StagingSession> {
  /** 1..num_weeks - see pivotStaging for why this is a parameter rather
   * than pivotMasterRota's fixed [1, 2, 3, 4]. */
  weeks: readonly number[];
}

/**
 * The staging run's grid. Rows and cells are pivotSessions' - see there
 * for the display-order and absent-cell rules. The week domain is this
 * pivot's own contribution, and the only thing that distinguishes it
 * from pivotRota and pivotMasterRota.
 *
 * pivotMasterRota's `weeks` is the fixed MASTER_ROTA_WEEKS [1, 2, 3, 4],
 * because the master template always has all four week slots defined. A
 * staging run has no such fixed domain: num_weeks is 1, 2, or 4, chosen
 * per run (CreateStagingIn), and there are no rows beyond it - fixing
 * `weeks` at four here would render two or three unusable empty week
 * tabs on every 1- or 2-week staging. So `weeks` is taken as an explicit
 * `numWeeks` parameter (staging.num_weeks) rather than fixed, or derived
 * from the sessions present. Clamped to at least one week so the grid
 * always has a tab to render.
 */
export function pivotStaging(
  sessions: StagingSession[],
  doctors: Doctor[],
  numWeeks: number,
): PivotedStagingGrid {
  return {
    ...pivotSessions(sessions, doctors),
    weeks: weekNumbers(Math.max(numWeeks, 1)),
  };
}

export function getStagingCell(
  grid: PivotedStagingGrid,
  doctorId: number,
  week: number,
  day: Day,
  period: Period,
): StagingSession | undefined {
  return getSessionCell(grid, doctorId, week, day, period);
}
