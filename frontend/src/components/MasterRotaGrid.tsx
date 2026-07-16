import { useMemo, useState } from "react";

import { useCreateMasterSession, useDeleteMasterSession, useUpdateMasterSession } from "@/api/masterRota";
import { useDoctors } from "@/api/doctors";
import { useRooms } from "@/api/rooms";
import type { Day, MasterRotaSession, MasterSessionType, Period } from "@/api/types";
import { MasterCellEditPopover } from "@/components/MasterCellEditPopover";
import type { MasterUndoEntry } from "@/lib/masterUndo";
import { masterMutationAppliedMessage, masterSessionCreatedMessage, masterSessionDeletedMessage } from "@/lib/masterUndo";
import { DAYS, PERIODS } from "@/lib/pivot";
import { getMasterRotaCell, pivotMasterRota } from "@/lib/pivotMasterRota";

interface MasterRotaGridProps {
  sessions: MasterRotaSession[];
  templateId: number;
  /** Called after any successful session edit/create/delete, so MasterRotaPage can push an undo entry and show a toast. */
  onMutationApplied?: (entry: MasterUndoEntry, toastMessage: string) => void;
  /** Called on any mutation failure. */
  onMutationError?: () => void;
}

/**
 * Doctor x (day, period) grid for the active master template. Every cell
 * with a session opens MasterCellEditPopover (M4.3 Task 4) - there is no
 * draft/committed gate and no leave concept the way RotaGrid has, so
 * unlike EditableGridCell there is no branch that suppresses the popover
 * trigger.
 *
 * M4.4 Task 3: absent cells are no longer universally inert. An absent
 * cell on an *active* doctor's row gets a faint "+" affordance opening
 * the same popover in create mode (session=null); an absent cell on an
 * inactive-flagged row stays inert (flagged assumption in the plan: you
 * don't build a new working pattern for a leaver). "Active" here reads
 * doctor.active directly rather than inactiveWithSessions, since the
 * latter is specifically about doctors who already have sessions -
 * an inactive doctor with zero sessions this week is still inactive.
 *
 * Rows come from /doctors (active_only=false), like RotaGrid, not from
 * the sessions payload's join fields (M4.3 Task 5, M4.4 groundwork) - a
 * doctor with zero template sessions still gets a row, and an inactive
 * doctor with sessions is flagged rather than silently dropped. See
 * pivotMasterRota's docstring for why this replaced the simpler
 * sessions-only approach.
 */
export function MasterRotaGrid({ sessions, templateId, onMutationApplied, onMutationError }: MasterRotaGridProps) {
  const { data: doctors, isLoading: doctorsLoading } = useDoctors(false);
  const { data: rooms, isLoading: roomsLoading } = useRooms();
  const updateSession = useUpdateMasterSession();
  const createSession = useCreateMasterSession();
  const deleteSession = useDeleteMasterSession();
  const saving = updateSession.isPending || createSession.isPending || deleteSession.isPending;

  const grid = useMemo(() => pivotMasterRota(sessions, doctors ?? []), [sessions, doctors]);
  const [activeWeek, setActiveWeek] = useState(grid.weeks[0] ?? 1);

  if (doctorsLoading || roomsLoading) {
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
            kind: "patch",
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

  function handleCreate(
    doctorId: number,
    week: number,
    day: Day,
    period: Period,
    sessionType: MasterSessionType,
    roomId: number | null,
    displaced: MasterRotaSession | null,
  ) {
    createSession.mutate(
      { templateId, doctorId, week, day, period, sessionType, roomId },
      {
        onSuccess: (data) => {
          const entry: MasterUndoEntry = {
            kind: "create",
            createdSessionId: data.session.session_id,
            displaced: displaced
              ? { sessionId: displaced.session_id, sessionType: displaced.session_type, roomId: displaced.room_id }
              : null,
          };
          const message = masterSessionCreatedMessage(
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

  function handleDelete(session: MasterRotaSession) {
    deleteSession.mutate(
      { templateId, sessionId: session.session_id },
      {
        onSuccess: () => {
          const entry: MasterUndoEntry = {
            kind: "delete",
            doctorId: session.doctor_id,
            week: session.week,
            day: session.day,
            period: session.period,
            previous: { sessionType: session.session_type, roomId: session.room_id },
          };
          const message = masterSessionDeletedMessage(session.doctor_code, session.day, session.period);
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
            {grid.rows.map(({ doctor, inactiveWithSessions }, rowIndex) => {
              const isLastDoctor = rowIndex === grid.rows.length - 1;
              // See RotaGrid.tsx for why this can't reuse the per-row
              // groupDividerClass below - the doctor cell only renders
              // once (rowSpan, at periodIndex 0).
              const doctorCellGroupDividerClass = isLastDoctor ? "" : "border-b-2";
              return PERIODS.map((period, periodIndex) => {
                const isGroupEnd = periodIndex === PERIODS.length - 1 && !isLastDoctor;
                const groupDividerClass = isGroupEnd ? "border-b-2 border-ink/40" : "";
                return (
                  <tr key={`${doctor.id}-${period}`}>
                    {periodIndex === 0 ? (
                      <td
                        rowSpan={PERIODS.length}
                        className={`sticky left-0 z-10 whitespace-nowrap border-r-2 border-ink/40 bg-background px-2 py-1 align-top font-medium ${doctorCellGroupDividerClass}`}
                      >
                        <div>{doctor.code}</div>
                        {inactiveWithSessions ? (
                          <div className="text-xs text-ink/50">(inactive)</div>
                        ) : null}
                      </td>
                    ) : null}
                    <td
                      className={`sticky left-24 z-10 border-r-2 border-ink/40 bg-background px-2 py-1 text-xs font-medium text-ink/70 ${groupDividerClass}`}
                    >
                      {period}
                    </td>
                    {DAYS.map((day, dayIndex) => {
                      const session = getMasterRotaCell(grid, doctor.id, activeWeek, day, period);
                      const dividerClassName = `${dayIndex === DAYS.length - 1 ? "" : "border-r-2 border-ink/40"} ${groupDividerClass}`;
                      const bgClass = session?.session_type === "no_surgery" ? "bg-gray-200 text-gray-500" : "";
                      
                      return (
                        <td
                          key={day}
                          className={`border border-border px-2 py-1 text-center ${dividerClassName} ${bgClass}`}
                          data-testid={`master-cell-${doctor.id}-${activeWeek}-${day}-${period}`}
                        >
                          {session ? (
                            <MasterCellEditPopover
                              session={session}
                              week={activeWeek}
                              day={day}
                              period={period}
                              sessions={sessions}
                              rooms={rooms ?? []}
                              onPick={(sessionType, roomId, displaced) => handlePick(session, sessionType, roomId, displaced)}
                              onDelete={() => handleDelete(session)}
                              saving={saving}
                            >
                              <div>
                                <CellContent session={session} />
                              </div>
                            </MasterCellEditPopover>
                          ) : doctor.active ? (
                            <MasterCellEditPopover
                              session={null}
                              week={activeWeek}
                              day={day}
                              period={period}
                              sessions={sessions}
                              rooms={rooms ?? []}
                              onPick={(sessionType, roomId, displaced) =>
                                handleCreate(doctor.id, activeWeek, day, period, sessionType, roomId, displaced)
                              }
                              saving={saving}
                            >
                              <button
                                type="button"
                                aria-label={`Add session for ${doctor.code} ${day} ${period}`}
                                className="flex h-full w-full items-center justify-center text-ink/30 hover:text-ink/50"
                              >
                                +
                              </button>
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
      {session.session_type !== "no_surgery" && session.session_type !== "admin_time" &&
        session.session_type !== "wfh" && !session.room_code ? (
        <span className="rounded bg-ink/10 px-1 text-xs font-medium">No room</span>
      ) : null}
      {session.room_code ? (
        <div className="text-xs font-medium">{session.room_code}</div>
      ) : null}
    </>
  );
}

/** REQUIRES_ROOM and PRE_ASSIGNED render a "No room" badge when unassigned
 * (room code, if any, is the whole content otherwise); NO_SURGERY/ADMIN_TIME/WFH
 * get their own label badge instead. */
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