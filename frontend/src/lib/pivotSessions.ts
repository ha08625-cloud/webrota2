import type { Day, Doctor, Period } from "@/api/types";
import { compareDoctorDisplayOrder } from "@/lib/groupDoctors";

/**
 * The subset of fields the pivot needs off a session row. RotaSession,
 * MasterRotaSession and StagingSession all satisfy this structurally,
 * which is what lets the generated rota, the master template and a
 * staging run share one pivot instead of three copies of it - the same
 * trick pivotReception uses for ReceptionCellData.
 *
 * The three differ only in their week domain (fixed 1-4 for the master
 * template, num_weeks for a staging or a generated rota), and a week
 * domain is a display concern of the caller, not of row/cell
 * construction - so it is not part of this grid at all. See
 * MASTER_ROTA_WEEKS (pivotMasterRota.ts) and pivotStaging for how each
 * caller supplies its own.
 */
export interface PivotableSession {
  doctor_id: number;
  week: number;
  day: Day;
  period: Period;
}

function slotKey(doctorId: number, week: number, day: Day, period: Period): string {
  return `${doctorId}:${week}:${day}:${period}`;
}

export interface GridRow {
  doctor: Doctor;
  /** True if this doctor is inactive but has sessions in the sessions passed in. */
  inactiveWithSessions: boolean;
}

export interface PivotedSessionGrid<T extends PivotableSession> {
  /**
   * Rows in display order: active doctors grouped by type (Partner,
   * Salaried, Trainee, AHP), alphabetical by code within a type - see
   * compareDoctorDisplayOrder - plus any inactive doctor who has
   * sessions in the sessions passed in, flagged rather than silently
   * dropped. Built from the full /doctors list (active_only=false): the
   * create/delete-session actions need a real doctor row to attach to
   * even when that doctor has no sessions yet, so rows cannot be derived
   * from the sessions alone.
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
  cells: Map<string, T>;
}

/**
 * Builds the pivoted grid for one set of sessions. `doctors` should be
 * the full list (active_only=false) so inactive-but-present doctors can
 * be detected and flagged rather than silently dropped.
 */
export function pivotSessions<T extends PivotableSession>(
  sessions: T[],
  doctors: Doctor[],
): PivotedSessionGrid<T> {
  const cells = new Map<string, T>();
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

export function getSessionCell<T extends PivotableSession>(
  grid: PivotedSessionGrid<T>,
  doctorId: number,
  week: number,
  day: Day,
  period: Period,
): T | undefined {
  return grid.cells.get(slotKey(doctorId, week, day, period));
}

/** The 1..n week domain for a rota or staging run of `numWeeks` weeks. */
export function weekNumbers(numWeeks: number): number[] {
  return Array.from({ length: numWeeks }, (_, i) => i + 1);
}
