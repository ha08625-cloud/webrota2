import type { Day, Doctor, Period, StagingSession } from "@/api/types";
import { compareDoctorDisplayOrder } from "@/lib/groupDoctors";

function slotKey(doctorId: number, week: number, day: Day, period: Period): string {
  return `${doctorId}:${week}:${day}:${period}`;
}

export interface StagingGridRow {
  doctor: Doctor;
  /** True if this doctor is inactive but has sessions in the viewed staging. */
  inactiveWithSessions: boolean;
}

export interface PivotedStagingGrid {
  /** Same display-order rules as pivotMasterRota's rows (active doctors
   * grouped by type then alphabetical by code, plus any inactive doctor
   * with sessions in this staging, flagged). */
  rows: StagingGridRow[];
  /** Cell lookup, keyed by (doctor, week, day, period). Missing key is
   * the expected absent-cell shape. */
  cells: Map<string, StagingSession>;
  weeks: readonly number[];
}

/**
 * Sibling of pivotMasterRota (lib/pivotMasterRota.ts), not a reuse of it.
 * The staging plan's Task 6 instructions call for reusing pivotMasterRota
 * unchanged "if its input shape allows", on the assumption that week tabs
 * would then naturally span 1..num_weeks. That assumption does not hold:
 * pivotMasterRota's `weeks` is MASTER_ROTA_WEEKS, a hardcoded [1, 2, 3, 4]
 * constant (deliberately fixed there - see that file's docstring, M4.4
 * Task 5 - because the master template always has all four week slots
 * defined). A staging run has no such fixed domain: num_weeks is 1, 2, or
 * 4, chosen per run (CreateStagingIn), and there are no rows beyond it -
 * reusing pivotMasterRota unchanged would render two or three unusable
 * empty week tabs on every 1- or 2-week staging. weeks is therefore
 * taken as an explicit `numWeeks` parameter (staging.num_weeks) here
 * rather than fixed or derived from the sessions present.
 *
 * Row/cell construction is otherwise identical to pivotMasterRota, since
 * StagingSession carries the same doctor_id/week/day/period/session_type/
 * room_id shape (plus is_on_leave, unused for pivoting).
 */
export function pivotStaging(
  sessions: StagingSession[],
  doctors: Doctor[],
  numWeeks: number,
): PivotedStagingGrid {
  const cells = new Map<string, StagingSession>();
  const doctorIdsWithSessions = new Set<number>();

  for (const session of sessions) {
    cells.set(slotKey(session.doctor_id, session.week, session.day, session.period), session);
    doctorIdsWithSessions.add(session.doctor_id);
  }

  const rows: StagingGridRow[] = doctors
    .filter((doctor) => doctor.active || doctorIdsWithSessions.has(doctor.id))
    .sort((a, b) => compareDoctorDisplayOrder({ type: a.doctor_type, code: a.code }, { type: b.doctor_type, code: b.code }))
    .map((doctor) => ({
      doctor,
      inactiveWithSessions: !doctor.active && doctorIdsWithSessions.has(doctor.id),
    }));

  const weeks = Array.from({ length: Math.max(numWeeks, 1) }, (_, i) => i + 1);

  return { rows, cells, weeks };
}

export function getStagingCell(
  grid: PivotedStagingGrid,
  doctorId: number,
  week: number,
  day: Day,
  period: Period,
): StagingSession | undefined {
  return grid.cells.get(slotKey(doctorId, week, day, period));
}