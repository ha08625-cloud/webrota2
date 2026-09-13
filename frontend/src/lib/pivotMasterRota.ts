import type { Day, Doctor, MasterRotaSession, Period } from "@/api/types";
import { compareDoctorDisplayOrder } from "@/lib/groupDoctors";

/** The template's week domain is a fixed 1-4 rotation, not a derived
 * range - see ck_mrs_week and template_start_week (1-4) on the backend
 * model. Constant, not derived from the sessions passed in: deriving
 * `weeks` from the max week present breaks create/delete - an empty or
 * sparse week has no tab to click into to populate it, and deleting the
 * last session in week 4 collapses the tab out from under `activeWeek`
 * state still pointing at it. The generated-rota grid is untouched -
 * RotaConfig.num_weeks remains pivot.ts's source there. */
export const MASTER_ROTA_WEEKS = [1, 2, 3, 4] as const;

function slotKey(doctorId: number, week: number, day: Day, period: Period): string {
  return `${doctorId}:${week}:${day}:${period}`;
}

export interface MasterRotaGridRow {
  doctor: Doctor;
  /** True if this doctor is inactive but has sessions in the viewed template. */
  inactiveWithSessions: boolean;
}

export interface PivotedMasterRotaGrid {
  /**
   * Rows in display order: active doctors grouped by type (Partner,
   * Salaried, Trainee, AHP) then alphabetical by code - see
   * compareDoctorDisplayOrder - plus any inactive doctor who has
   * sessions in this template, flagged. Built from the full /doctors
   * list (active_only=false), mirroring pivotRota's GridRow exactly:
   * the create/delete-session actions need a real doctor row to attach
   * to even when that doctor has no sessions yet, so rows cannot be
   * derived from the sessions alone.
   */
  rows: MasterRotaGridRow[];
  /** Cell lookup, keyed by (doctor, week, day, period). Same "missing
   * key is the expected absent-cell shape" invariant as pivot.ts. Built
   * from sessions alone - doctors are only needed for row construction. */
  cells: Map<string, MasterRotaSession>;
  /** Always MASTER_ROTA_WEEKS - see its docstring for why this is not
   * derived from the sessions passed in. */
  weeks: readonly number[];
}

export function pivotMasterRota(sessions: MasterRotaSession[], doctors: Doctor[]): PivotedMasterRotaGrid {
  const cells = new Map<string, MasterRotaSession>();
  const doctorIdsWithSessions = new Set<number>();

  for (const session of sessions) {
    cells.set(slotKey(session.doctor_id, session.week, session.day, session.period), session);
    doctorIdsWithSessions.add(session.doctor_id);
  }

  const rows: MasterRotaGridRow[] = doctors
    .filter((doctor) => doctor.active || doctorIdsWithSessions.has(doctor.id))
    .sort((a, b) => compareDoctorDisplayOrder({ type: a.doctor_type, code: a.code }, { type: b.doctor_type, code: b.code }))
    .map((doctor) => ({
      doctor,
      inactiveWithSessions: !doctor.active && doctorIdsWithSessions.has(doctor.id),
    }));

  return { rows, cells, weeks: MASTER_ROTA_WEEKS };
}

export function getMasterRotaCell(
  grid: PivotedMasterRotaGrid,
  doctorId: number,
  week: number,
  day: Day,
  period: Period,
): MasterRotaSession | undefined {
  return grid.cells.get(slotKey(doctorId, week, day, period));
}