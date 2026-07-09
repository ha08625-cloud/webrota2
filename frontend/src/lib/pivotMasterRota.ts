import type { Day, MasterRotaSession, Period } from "@/api/types";
import { weekNumbers } from "@/lib/pivot";

function slotKey(doctorId: number, week: number, day: Day, period: Period): string {
  return `${doctorId}:${week}:${day}:${period}`;
}

export interface MasterRotaGridRow {
  doctorId: number;
  doctorCode: string;
}

export interface PivotedMasterRotaGrid {
  /**
   * Rows in code order, built directly from the distinct doctors present
   * in the template's sessions (doctor_code already comes with the join
   * in MasterRotaSessionOut) - deliberately not fetched from /doctors.
   * This is simpler than pivotRota's approach and has a real trade-off:
   * it has no "inactive but present" badge concept. Accepted for this
   * read-only view (M4 follow-up decision) rather than mirroring
   * RotaGrid's active_only=false doctors fetch.
   */
  rows: MasterRotaGridRow[];
  /** Cell lookup, keyed by (doctor, week, day, period). Same "missing
   * key is the expected absent-cell shape" invariant as pivot.ts. */
  cells: Map<string, MasterRotaSession>;
  /** Derived from the sessions actually present, since MasterRotaTemplate
   * has no num_weeks column (unlike RotaConfig) to read instead. */
  weeks: number[];
}

export function pivotMasterRota(sessions: MasterRotaSession[]): PivotedMasterRotaGrid {
  const cells = new Map<string, MasterRotaSession>();
  const doctorsById = new Map<number, string>();
  let maxWeek = 1;

  for (const session of sessions) {
    cells.set(slotKey(session.doctor_id, session.week, session.day, session.period), session);
    doctorsById.set(session.doctor_id, session.doctor_code);
    if (session.week > maxWeek) maxWeek = session.week;
  }

  const rows: MasterRotaGridRow[] = Array.from(doctorsById.entries())
    .map(([doctorId, doctorCode]) => ({ doctorId, doctorCode }))
    .sort((a, b) => a.doctorCode.localeCompare(b.doctorCode));

  return { rows, cells, weeks: weekNumbers(maxWeek) };
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