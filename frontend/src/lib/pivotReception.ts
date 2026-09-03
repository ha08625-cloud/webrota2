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

/** A range edit the user has confirmed but whose per-hour writes have not all landed yet. */
export interface PendingReceptionWrite {
  staffId: number;
  /** Every hour the edit covers, whether or not it already has a session. */
  hours: number[];
  /** The pair being written, or null for a pending removal. */
  write: { role: ReceptionRole; note: string | null } | null;
}

/**
 * The session_id a not-yet-created cell is drawn with. Never sent
 * anywhere: overlaid cells exist only to be rendered (ReceptionGrid reads
 * the un-overlaid grid when it composes save/delete payloads), and the
 * real id arrives with the create response a moment later.
 */
const PENDING_SESSION_ID = -1;

/**
 * Applies a confirmed-but-in-flight range edit to a pivoted grid, so the
 * whole range flips to its new state in a single render instead of one
 * cell at a time as the sequential per-hour writes land - which is what
 * made a row-wide role assignment look like it was merging cell by cell
 * for two seconds. When the writes finish (or fail) the caller drops the
 * pending write and the real cache state takes over; on success it is
 * identical to what was already drawn, so nothing moves.
 */
export function withPendingReceptionWrite<T extends ReceptionCellData>(
  grid: PivotedReceptionGrid<T>,
  pending: PendingReceptionWrite | null,
): PivotedReceptionGrid<T> {
  if (pending === null) return grid;
  const cells = new Map(grid.cells);
  for (const hour of pending.hours) {
    const key = slotKey(pending.staffId, hour);
    const existing = cells.get(key);
    if (pending.write === null) {
      cells.delete(key);
    } else if (existing !== undefined) {
      cells.set(key, { ...existing, ...pending.write });
    } else {
      // A create: there is no row to copy the display-only fields
      // (staff_code, day) off of, and nothing renders them
      // from a cell - the grid gets them from the staff row instead.
      cells.set(key, {
        session_id: PENDING_SESSION_ID,
        staff_id: pending.staffId,
        hour,
        ...pending.write,
      } as unknown as T);
    }
  }
  return { rows: grid.rows, cells };
}
