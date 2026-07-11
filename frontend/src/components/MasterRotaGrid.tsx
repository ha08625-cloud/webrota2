import { useMemo, useState } from "react";

import { useUpdateMasterSession } from "@/api/masterRota";
import { useRooms } from "@/api/rooms";
import type { MasterRotaSession, MasterSessionType } from "@/api/types";
import { MasterCellEditPopover } from "@/components/MasterCellEditPopover";
import type { MasterUndoEntry } from "@/lib/masterUndo";
import { masterMutationAppliedMessage } from "@/lib/masterUndo";
import { DAYS, PERIODS } from "@/lib/pivot";
import { getMasterRotaCell, pivotMasterRota } from "@/lib/pivotMasterRota";

interface MasterRotaGridProps {
  sessions: MasterRotaSession[];
  templateId: number;
  /** Called after any successful session edit, so MasterRotaPage can push an undo entry and show a toast. */
  onMutationApplied?: (entry: MasterUndoEntry, toastMessage: string) => void;
  /** Called on any mutation failure. */
  onMutationError?: () => void;
}

/**
 * Doctor x (day, period) grid for the active master template. Every cell
 * with a session opens MasterCellEditPopover (M4.3 Task 4) - there is no
 * draft/committed gate and no leave concept the way RotaGrid has, so
 * unlike EditableGridCell there is no branch that suppresses the popover
 * trigger. Absent cells (no session at all) stay inert - creating a new
 * MasterRotaSession row is out of scope until M4.4.
 */
export function MasterRotaGrid({ sessions, templateId, onMutationApplied, onMutationError }: MasterRotaGridProps) {
  const { data: rooms, isLoading: roomsLoading } = useRooms();
  const updateSession = useUpdateMasterSession();

  const grid = useMemo(() => pivotMasterRota(sessions), [sessions]);
  const [activeWeek, setActiveWeek] = useState(grid.weeks[0] ?? 1);

  if (roomsLoading) {
    return <p className="text-sm text-ink/70">Loading grid...</p>;
  }

  function handlePick(
    session: MasterRotaSession,
    sessionType: MasterSessionType,
    roomId: number | null,
    displaced: MasterRotaSession | null,
  ) {
    updateSession.mutate(
      { templateId, sessionId: session.session_id, sessionType, roomId },
      {
        onSuccess: (data) => {
          const entry: MasterUndoEntry = {
            sessionId: session.session_id,
            previous: { sessionType: session.session_type, roomId: session.room_id },
            displaced: displaced
              ? { sessionId: displaced.session_id, sessionType: displaced.session_type, roomId: displaced.room_id }
              : null,
          };
          const message = masterMutationAppliedMessage(
            data.session.doctor_code,
            data.session.day,
            data.session.period,
            data.session.session_type,
            data.session.room_code,
          );
          onMutationApplied?.(entry, message);
        },
        onError: () => onMutationError?.(),
      },
    );
  }

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

      <div className="mt-4 overflow-x-auto rounded border-2 border-ink/40">
        <table className="min-w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 w-24 border-b-2 border-r-2 border-ink/40 bg-background px-2 py-1 text-left font-medium text-ink/70">
                Doctor
              </th>
              <th className="sticky left-24 z-10 w-12 border-b-2 border-r-2 border-ink/40 bg-background px-2 py-1 text-left font-medium text-ink/70">
                Session
              </th>
              {DAYS.map((day, dayIndex) => (
                <th
                  key={day}
                  className={`border-b-2 border-ink/40 px-2 py-1 text-center font-medium text-ink/70 ${
                    dayIndex === DAYS.length - 1 ? "" : "border-r-2"
                  }`}
                >
                  {day}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map(({ doctorId, doctorCode }, rowIndex) => {
              const isLastDoctor = rowIndex === grid.rows.length - 1;
              // See RotaGrid.tsx for why this can't reuse the per-row
              // groupDividerClass below - the doctor cell only renders
              // once (rowSpan, at periodIndex 0).
              const doctorCellGroupDividerClass = isLastDoctor ? "" : "border-b-2";
              return PERIODS.map((period, periodIndex) => {
                const isGroupEnd = periodIndex === PERIODS.length - 1 && !isLastDoctor;
                const groupDividerClass = isGroupEnd ? "border-b-2 border-ink/40" : "";
                return (
                  <tr key={`${doctorId}-${period}`}>
                    {periodIndex === 0 ? (
                      <td
                        rowSpan={PERIODS.length}
                        className={`sticky left-0 z-10 whitespace-nowrap border-r-2 border-ink/40 bg-background px-2 py-1 align-top font-medium ${doctorCellGroupDividerClass}`}
                      >
                        {doctorCode}
                      </td>
                    ) : null}
                    <td
                      className={`sticky left-24 z-10 border-r-2 border-ink/40 bg-background px-2 py-1 text-xs font-medium text-ink/70 ${groupDividerClass}`}
                    >
                      {period}
                    </td>
                    {DAYS.map((day, dayIndex) => {
                      const session = getMasterRotaCell(grid, doctorId, activeWeek, day, period);
                      const dividerClassName = `${dayIndex === DAYS.length - 1 ? "" : "border-r-2 border-ink/40"} ${groupDividerClass}`;
                      return (
                        <td
                          key={day}
                          className={`border border-border px-2 py-1 text-center ${dividerClassName}`}
                          data-testid={`master-cell-${doctorId}-${activeWeek}-${day}-${period}`}
                        >
                          {session ? (
                            <MasterCellEditPopover
                              session={session}
                              sessions={sessions}
                              rooms={rooms ?? []}
                              onPick={(sessionType, roomId, displaced) => handlePick(session, sessionType, roomId, displaced)}
                              saving={updateSession.isPending}
                            >
                              <div>
                                <CellContent session={session} />
                              </div>
                            </MasterCellEditPopover>
                          ) : null}
                        </td>
                      );
                    })}
                  </tr>
                );
              });
            })}
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
