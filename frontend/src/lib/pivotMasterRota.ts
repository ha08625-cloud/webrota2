import type { Day, Doctor, MasterRotaSession, Period } from "@/api/types";
import { getSessionCell, pivotSessions, type PivotedSessionGrid } from "@/lib/pivotSessions";

/** The template's week domain is a fixed 1-4 rotation, not a derived
 * range - see ck_mrs_week and template_start_week (1-4) on the backend
 * model. Constant, not derived from the sessions passed in: deriving
 * `weeks` from the max week present breaks create/delete - an empty or
 * sparse week has no tab to click into to populate it, and deleting the
 * last session in week 4 collapses the tab out from under `activeWeek`
 * state still pointing at it. The generated-rota grid is untouched -
 * RotaConfig.num_weeks remains pivot.ts's source there. */
export const MASTER_ROTA_WEEKS = [1, 2, 3, 4] as const;

export interface PivotedMasterRotaGrid extends PivotedSessionGrid<MasterRotaSession> {
  /** Always MASTER_ROTA_WEEKS - see its docstring for why this is not
   * derived from the sessions passed in. */
  weeks: readonly number[];
}

/**
 * The master template's grid. Rows and cells are pivotSessions' - see
 * there for the display-order and absent-cell rules. The week domain is
 * this pivot's own contribution, and the only thing that distinguishes
 * it from pivotRota and pivotStaging.
 */
export function pivotMasterRota(sessions: MasterRotaSession[], doctors: Doctor[]): PivotedMasterRotaGrid {
  return { ...pivotSessions(sessions, doctors), weeks: MASTER_ROTA_WEEKS };
}

export function getMasterRotaCell(
  grid: PivotedMasterRotaGrid,
  doctorId: number,
  week: number,
  day: Day,
  period: Period,
): MasterRotaSession | undefined {
  return getSessionCell(grid, doctorId, week, day, period);
}
