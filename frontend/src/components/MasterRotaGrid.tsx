import { useMemo, useState } from "react";

import type { MasterRotaSession } from "@/api/types";
import { DAYS, PERIODS } from "@/lib/pivot";
import { getMasterRotaCell, pivotMasterRota } from "@/lib/pivotMasterRota";

interface MasterRotaGridProps {
  sessions: MasterRotaSession[];
}

/**
 * Read-only doctor x (day, period) grid for the active master template.
 * No DndContext, no popover, no drag chips - unlike RotaGrid this view
 * is never editable (master rota template editing is a deferred
 * milestone, see architecture.md).
 */
export function MasterRotaGrid({ sessions }: MasterRotaGridProps) {
  const grid = useMemo(() => pivotMasterRota(sessions), [sessions]);
  const [activeWeek, setActiveWeek] = useState(grid.weeks[0] ?? 1);

  return (
    <div>
      <div className="flex gap-1 border-b border-border" role="tablist" aria-label="Week">
        {grid.weeks.map((week) => (
          <button
            key={week}
            type="button"
            role="tab"
            aria-selected={week === activeWeek}
            onClick={() => setActiveWeek(week)}
            className={`px-4 py-2 text-sm font-medium ${
              week === activeWeek
                ? "border-b-2 border-accent text-accent"
                : "text-ink/60 hover:text-ink"
            }`}
          >
            Week {week}
          </button>
        ))}
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 w-24 bg-background px-2 py-1 text-left font-medium text-ink/70">
                Doctor
              </th>
              <th className="sticky left-24 z-10 w-12 bg-background px-2 py-1 text-left font-medium text-ink/70">
                Session
              </th>
              {DAYS.map((day) => (
                <th
                  key={day}
                  className="border-b border-border px-2 py-1 text-center font-medium text-ink/70"
                >
                  {day}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map(({ doctorId, doctorCode }) =>
              PERIODS.map((period, periodIndex) => (
                <tr key={`${doctorId}-${period}`}>
                  {periodIndex === 0 ? (
                    <td
                      rowSpan={PERIODS.length}
                      className="sticky left-0 z-10 whitespace-nowrap bg-background px-2 py-1 align-top font-medium"
                    >
                      {doctorCode}
                    </td>
                  ) : null}
                  <td className="sticky left-24 z-10 bg-background px-2 py-1 text-xs font-medium text-ink/70">
                    {period}
                  </td>
                  {DAYS.map((day) => {
                    const session = getMasterRotaCell(grid, doctorId, activeWeek, day, period);
                    return (
                      <td
                        key={day}
                        className="border border-border px-2 py-1 text-center"
                        data-testid={`master-cell-${doctorId}-${activeWeek}-${day}-${period}`}
                      >
                        {session ? <CellContent session={session} /> : null}
                      </td>
                    );
                  })}
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CellContent({ session }: { session: MasterRotaSession }) {
  return (
    <>
      <SessionTypeBadge sessionType={session.session_type} />
      {session.room_code ? (
        <div className="text-xs font-medium">{session.room_code}</div>
      ) : null}
    </>
  );
}

/** REQUIRES_ROOM and PRE_ASSIGNED render as blank (room code, if any, is
 * the whole content); NO_SURGERY/ADMIN_TIME/WFH get a label badge. */
function SessionTypeBadge({ sessionType }: { sessionType: MasterRotaSession["session_type"] }) {
  if (sessionType === "no_surgery") {
    return <span className="rounded bg-ink/10 px-1 text-xs font-medium">No surgery</span>;
  }
  if (sessionType === "admin_time") {
    return <span className="rounded bg-ink/10 px-1 text-xs font-medium">Admin</span>;
  }
  if (sessionType === "wfh") {
    return <span className="rounded bg-ink/10 px-1 text-xs font-medium">WFH</span>;
  }
  return null;
}