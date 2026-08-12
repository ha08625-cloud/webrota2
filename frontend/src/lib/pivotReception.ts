import type { ReceptionRole, ReceptionStaff } from "@/api/types";

function slotKey(staffId: number, hour: number): string {
  return `${staffId}:${hour}`;
}

/**
 * The subset of fields pivotReception needs off a slot row. Both
 * ReceptionMasterSession (day) and ReceptionRotaSession (day rota, no
 * `day` field - the date is fixed by the rota it belongs to) satisfy this
 * structurally, which is what lets Task 8 pass ReceptionRotaSession[]
 * through the same generic pivot/grid/popover without a second copy of
 * any of the three.
 */
export interface ReceptionCellData {
  session_id: number;
  staff_id: number;
  hour: number;
  role: ReceptionRole;
  note: string | null;
}

export interface ReceptionGridRow {
  staff: ReceptionStaff;
  /** True if this staff member is inactive but has a session somewhere in the sessions passed in. */
  inactiveWithSessions: boolean;
}

export interface PivotedReceptionGrid<T extends ReceptionCellData> {
  /**
   * Rows in display order: active staff alphabetical by code, plus any
   * inactive staff member who has a session in the sessions passed in,
   * flagged - mirroring pivotMasterRota's rows, minus the doctor-type
   * grouping (reception staff have no type to group by).
   */
  rows: ReceptionGridRow[];
  /**
   * Cell lookup, keyed by (staff, hour). A missing key is the expected
   * "not expected this hour" state, distinct from an empty/falsy value -
   * the same absent-cell-is-data invariant as pivotMasterRota's `cells`:
   * a template row's existence, not its content, is what "expected to
   * work this hour" means.
   */
  cells: Map<string, T>;
}

export function pivotReception<T extends ReceptionCellData>(
  sessions: T[],
  staff: ReceptionStaff[],
): PivotedReceptionGrid<T> {
  const cells = new Map<string, T>();
  const staffIdsWithSessions = new Set<number>();

  for (const session of sessions) {
    cells.set(slotKey(session.staff_id, session.hour), session);
    staffIdsWithSessions.add(session.staff_id);
  }

  const rows: ReceptionGridRow[] = staff
    .filter((s) => s.active || staffIdsWithSessions.has(s.id))
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((s) => ({
      staff: s,
      inactiveWithSessions: !s.active && staffIdsWithSessions.has(s.id),
    }));

  return { rows, cells };
}

export function getReceptionCell<T extends ReceptionCellData>(
  grid: PivotedReceptionGrid<T>,
  staffId: number,
  hour: number,
): T | undefined {
  return grid.cells.get(slotKey(staffId, hour));
}
