import { useEffect, useMemo, useState } from "react";

import type { ReceptionRole, ReceptionStaff, ValidationIssue } from "@/api/types";
import { ReceptionCellPopover } from "@/components/ReceptionCellPopover";
import { formatHour, RECEPTION_HOURS } from "@/lib/receptionHours";
import { getReceptionCell, pivotReception, type ReceptionCellData } from "@/lib/pivotReception";
import { RECEPTION_ROLE_CHIP_CLASSNAME, RECEPTION_ROLE_LABELS } from "@/lib/receptionRoles";

export interface ReceptionSavePayload<T extends ReceptionCellData> {
  staffId: number;
  hour: number;
  /** The cell's current session, or null when saving into an absent cell (create). */
  session: T | null;
  role: ReceptionRole;
  note: string | null;
}

/** A staff row's shift-click range, `anchorHour === focusHour` for a plain single-cell click. */
interface ReceptionSelection {
  staffId: number;
  anchorHour: number;
  focusHour: number;
}

/** The hours between anchor and focus (inclusive, ascending), or [] when the selection is absent or on another row. */
export function selectedRangeHours(selection: ReceptionSelection | null, staffId: number): number[] {
  if (selection === null || selection.staffId !== staffId) return [];
  const lo = Math.min(selection.anchorHour, selection.focusHour);
  const hi = Math.max(selection.anchorHour, selection.focusHour);
  return RECEPTION_HOURS.filter((hour) => hour >= lo && hour <= hi);
}

interface ReceptionGridProps<T extends ReceptionCellData> {
  staff: ReceptionStaff[];
  sessions: T[];
  /**
   * Coverage shortfall warnings, one per (day, hour) below its rule's
   * minimum - absent on the master template page (a pattern has no
   * headcount to fall short of), present on the day rota page (Task 8).
   * Matched to a column by message prefix: compute_coverage_issues
   * (backend/app/api/routers/reception_rota.py) puts formatHour(hour) at
   * the start of every message for exactly this purpose (Decision 9) -
   * there is no `hour` field on ValidationIssue to key off instead, since
   * it's the same shape the clinical rota's week/day/period issues use.
   */
  issues?: ValidationIssue[];
  /** Ascending by hour. Resolves true only if every write succeeded (shift-click range select). */
  onSave: (payloads: ReceptionSavePayload<T>[]) => Promise<boolean>;
  /** Only cells in the range that actually have a session. Resolves true if all succeeded. */
  onDelete: (sessions: T[]) => Promise<boolean>;
  saving: boolean;
}

/**
 * Staff x hour grid for one day - the weekday template (Task 7) or a
 * generated day (Task 8), unchanged between the two. Sibling of
 * MasterRotaGrid/RotaGrid, not a generalisation of either: the axes
 * differ (staff x hour here vs doctor x day/period there), reception has
 * no displacement/steal concept, and there is no draft/committed or
 * leave-derived inert state. Forcing a shared abstraction across the two
 * grids would make both harder to read, so this is deliberate
 * duplication - do not "fix" it by merging them later.
 *
 * Takes its data and callbacks as props and owns no query/mutation hooks
 * itself (unlike MasterRotaGrid, which queries doctors/rooms directly) -
 * that is what lets the day rota page reuse this component unchanged
 * against ReceptionRotaSession[] and its own set of mutations, rather
 * than needing a second copy wired to different endpoints.
 */
export function ReceptionGrid<T extends ReceptionCellData>({
  staff,
  sessions,
  issues,
  onSave,
  onDelete,
  saving,
}: ReceptionGridProps<T>) {
  const grid = useMemo(() => pivotReception(sessions, staff), [sessions, staff]);
  const issuesByHour = useMemo(() => groupIssuesByHour(issues ?? []), [issues]);
  const [selection, setSelection] = useState<ReceptionSelection | null>(null);

  useEffect(() => {
    if (selection === null) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setSelection(null);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selection]);

  function handleCellClick(staffId: number, hour: number, shiftKey: boolean) {
    setSelection((prev) =>
      shiftKey && prev !== null && prev.staffId === staffId
        ? { ...prev, focusHour: hour }
        : { staffId, anchorHour: hour, focusHour: hour },
    );
  }

  async function handleSave(staffId: number, hours: number[], role: ReceptionRole, note: string | null) {
    const payloads = hours.map((hour) => ({
      staffId,
      hour,
      session: getReceptionCell(grid, staffId, hour) ?? null,
      role,
      note,
    }));
    if (await onSave(payloads)) setSelection(null);
  }

  async function handleDelete(staffId: number, hours: number[]) {
    const sessionsInRange = hours
      .map((hour) => getReceptionCell(grid, staffId, hour))
      .filter((session): session is T => session !== undefined);
    if (await onDelete(sessionsInRange)) setSelection(null);
  }

  return (
    <div className="overflow-x-auto rounded border-2 border-ink/40">
      <table className="min-w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 w-28 border-b-2 border-r-2 border-ink/40 bg-background px-2 py-1 text-left font-medium text-ink/70">
              Reception Staff
            </th>
            {RECEPTION_HOURS.map((hour, hourIndex) => {
              const hourIssues = issuesByHour.get(hour) ?? [];
              return (
                <th
                  key={hour}
                  className={`border-b-2 border-ink/40 px-2 py-1 text-center font-medium text-ink/70 ${
                    hourIndex === RECEPTION_HOURS.length - 1 ? "" : "border-r-2"
                  }`}
                >
                  <div className="flex items-center justify-center gap-1">
                    <span>{formatHour(hour)}</span>
                    {hourIssues.length > 0 ? (
                      <span
                        title={hourIssues.map((issue) => issue.message).join("\n")}
                        aria-label={`Coverage shortfall at ${formatHour(hour)}`}
                        className="text-amber-600"
                      >
                        &#9888;
                      </span>
                    ) : null}
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {grid.rows.map(({ staff: member, inactiveWithSessions }) => {
            // Decision 9: on an inactive row, a range only ever covers hours that already have a session -
            // no new rows get created for a leaver.
            const memberRange = selectedRangeHours(selection, member.id).filter(
              (hour) => member.active || getReceptionCell(grid, member.id, hour) !== undefined,
            );
            return (
              <tr key={member.id}>
                <td className="sticky left-0 z-10 whitespace-nowrap border-b border-r-2 border-ink/40 bg-background px-2 py-1 align-top font-medium">
                  <div>{member.code}</div>
                  {inactiveWithSessions ? <div className="text-xs text-ink/50">(inactive)</div> : null}
                </td>
                {RECEPTION_HOURS.map((hour, hourIndex) => {
                  const session = getReceptionCell(grid, member.id, hour);
                  const interactive = session !== undefined || member.active;
                  const isSelected = interactive && memberRange.includes(hour);
                  const isFocusCell =
                    selection !== null && selection.staffId === member.id && selection.focusHour === hour;
                  const hours = isFocusCell && memberRange.length > 1 ? memberRange : [hour];
                  const seedSession =
                    hours.length > 1
                      ? (getReceptionCell(grid, member.id, selection!.focusHour) ??
                        getReceptionCell(grid, member.id, selection!.anchorHour) ??
                        null)
                      : (session ?? null);
                  const canDelete = hours.some((h) => getReceptionCell(grid, member.id, h) !== undefined);
                  const dividerClassName = hourIndex === RECEPTION_HOURS.length - 1 ? "" : "border-r-2 border-ink/40";
                  const selectedClassName = isSelected ? "bg-accent/10 ring-1 ring-inset ring-accent" : "";
                  const cursorClassName = interactive ? "cursor-pointer" : "";
                  return (
                    <td
                      key={hour}
                      className={`border-b border-border px-2 py-1 text-center ${dividerClassName} ${selectedClassName} ${cursorClassName}`}
                      data-testid={`reception-cell-${member.id}-${hour}`}
                      data-selected={isSelected ? "true" : undefined}
                      onClick={interactive ? (e) => handleCellClick(member.id, hour, e.shiftKey) : undefined}
                    >
                      {interactive ? (
                        <ReceptionCellPopover
                          session={seedSession}
                          hourCount={hours.length}
                          canDelete={canDelete}
                          saving={saving}
                          onSave={(role, note) => handleSave(member.id, hours, role, note)}
                          onDelete={() => handleDelete(member.id, hours)}
                        >
                          {session ? (
                            <div>
                              <CellContent session={session} />
                            </div>
                          ) : (
                            <button
                              type="button"
                              aria-label={`Add session for ${member.code} ${formatHour(hour)}`}
                              className="flex h-full w-full items-center justify-center text-ink/30 hover:text-ink/50"
                            >
                              +
                            </button>
                          )}
                        </ReceptionCellPopover>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CellContent<T extends ReceptionCellData>({ session }: { session: T }) {
  return (
    <>
      <span
        className={`rounded px-1 text-xs font-medium ${RECEPTION_ROLE_CHIP_CLASSNAME[session.role]}`}
      >
        {RECEPTION_ROLE_LABELS[session.role]}
      </span>
      {session.note ? <div className="text-xs text-ink/60">{session.note}</div> : null}
    </>
  );
}

function groupIssuesByHour(issues: ValidationIssue[]): Map<number, ValidationIssue[]> {
  const byHour = new Map<number, ValidationIssue[]>();
  for (const issue of issues) {
    const hour = RECEPTION_HOURS.find((h) => issue.message.startsWith(formatHour(h)));
    if (hour === undefined) continue;
    const existing = byHour.get(hour);
    if (existing) {
      existing.push(issue);
    } else {
      byHour.set(hour, [issue]);
    }
  }
  return byHour;
}
