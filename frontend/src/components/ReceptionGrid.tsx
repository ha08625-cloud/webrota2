import { useMemo } from "react";

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
  onSave: (payload: ReceptionSavePayload<T>) => void;
  onDelete: (session: T) => void;
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
          {grid.rows.map(({ staff: member, inactiveWithSessions }) => (
            <tr key={member.id}>
              <td className="sticky left-0 z-10 whitespace-nowrap border-b border-r-2 border-ink/40 bg-background px-2 py-1 align-top font-medium">
                <div>{member.code}</div>
                {inactiveWithSessions ? <div className="text-xs text-ink/50">(inactive)</div> : null}
              </td>
              {RECEPTION_HOURS.map((hour, hourIndex) => {
                const session = getReceptionCell(grid, member.id, hour);
                const dividerClassName = hourIndex === RECEPTION_HOURS.length - 1 ? "" : "border-r-2 border-ink/40";
                return (
                  <td
                    key={hour}
                    className={`border-b border-border px-2 py-1 text-center ${dividerClassName}`}
                    data-testid={`reception-cell-${member.id}-${hour}`}
                  >
                    {session ? (
                      <ReceptionCellPopover
                        session={session}
                        saving={saving}
                        onSave={(role, note) => onSave({ staffId: member.id, hour, session, role, note })}
                        onDelete={() => onDelete(session)}
                      >
                        <div>
                          <CellContent session={session} />
                        </div>
                      </ReceptionCellPopover>
                    ) : member.active ? (
                      <ReceptionCellPopover
                        session={null}
                        saving={saving}
                        onSave={(role, note) => onSave({ staffId: member.id, hour, session: null, role, note })}
                      >
                        <button
                          type="button"
                          aria-label={`Add session for ${member.code} ${formatHour(hour)}`}
                          className="flex h-full w-full items-center justify-center text-ink/30 hover:text-ink/50"
                        >
                          +
                        </button>
                      </ReceptionCellPopover>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
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
