import type { Day, Doctor, Period, RotaSession } from "@/api/types";
import { compareDoctorDisplayOrder } from "@/lib/groupDoctors";

export const DAYS: Day[] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
export const PERIODS: Period[] = ["AM", "PM"];

function slotKey(doctorId: number, week: number, day: Day, period: Period): string {
  return `${doctorId}:${week}:${day}:${period}`;
}

export interface GridRow {
  doctor: Doctor;
  /** True if this doctor is inactive but has sessions in the viewed rota. */
  inactiveWithSessions: boolean;
}

export interface PivotedGrid {
  /**
   * Rows in display order: active doctors grouped by type (Partner,
   * Salaried, Trainee, AHP), alphabetical by code within a type - see
   * compareDoctorDisplayOrder - plus any inactive doctor who has
   * sessions in this rota, flagged.
   */
  rows: GridRow[];
  /**
   * Cell lookup, keyed by (doctor, week, day, period). A missing key is
   * the "absent" cell state - not an edge case to handle defensively, but
   * the expected, documented shape of the data.
   *
   * Invariant (confirmed against phase2._build_grid): a RotaSession row
   * exists if and only if a template entry existed for that
   * (doctor, template_week, day, period) at generation time - e.g. a
   * part-time doctor genuinely has no row for a slot they don't work.
   * generate._write_to_db persists exactly grid.slots, nothing more, so
   * there is no case where a cell "should" exist but the session is
   * simply missing. Swap/move/patch only mutate existing rows, so this
   * holds after editing too - editing can never create or delete a cell,
   * only change what's in one. Do not add a fallback that tries to
   * fabricate a cell from /master-rota; there is nothing to fabricate.
   */
  cells: Map<string, RotaSession>;
}

/**
 * Builds the pivoted grid for one rota. `doctors` should be the full list
 * (active_only=false) so inactive-but-present doctors can be detected and
 * flagged rather than silently dropped.
 */
export function pivotRota(sessions: RotaSession[], doctors: Doctor[]): PivotedGrid {
  const cells = new Map<string, RotaSession>();
  const doctorIdsWithSessions = new Set<number>();

  for (const session of sessions) {
    cells.set(slotKey(session.doctor_id, session.week, session.day, session.period), session);
    doctorIdsWithSessions.add(session.doctor_id);
  }

  const rows: GridRow[] = doctors
    .filter((doctor) => doctor.active || doctorIdsWithSessions.has(doctor.id))
    .sort((a, b) => compareDoctorDisplayOrder({ type: a.doctor_type, code: a.code }, { type: b.doctor_type, code: b.code }))
    .map((doctor) => ({
      doctor,
      inactiveWithSessions: !doctor.active && doctorIdsWithSessions.has(doctor.id),
    }));

  return { rows, cells };
}

export function getCell(
  grid: PivotedGrid,
  doctorId: number,
  week: number,
  day: Day,
  period: Period,
): RotaSession | undefined {
  return grid.cells.get(slotKey(doctorId, week, day, period));
}

export function weekNumbers(numWeeks: number): number[] {
  return Array.from({ length: numWeeks }, (_, i) => i + 1);
}