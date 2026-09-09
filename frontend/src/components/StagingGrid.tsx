import { useMemo, useState } from "react";

import { useCreateStagingSession, useDeleteStagingSession, useUpdateStagingSession } from "@/api/staging";
import { useDoctors } from "@/api/doctors";
import { useRooms } from "@/api/rooms";
import type { ClosedSlot, Day, MasterSessionType, Period, StagingSession } from "@/api/types";
import { MasterCellEditPopover } from "@/components/MasterCellEditPopover";
import { isDayFullyClosed, isDayPartlyClosed, isSlotClosed, partlyClosedPeriod, toClosedSlotSet } from "@/lib/closedSlots";
import { DAYS, PERIODS } from "@/lib/pivot";
import { getStagingCell, pivotStaging } from "@/lib/pivotStaging";
import { rotaDate } from "@/lib/weekDates";

interface StagingGridProps {
  sessions: StagingSession[];
  stagingId: number;
  startDate: string;
  numWeeks: number;
  /** Live PracticeClosure (date, period) slots in the staging's range
   * (not a snapshot). Greys the day
   * header and, per Task 5, the closed period's own cells - the staging
   * grid is the pre-generation preview of RotaGrid, so it gets the same
   * per-cell closed treatment rather than staying editable underneath. */
  closedSlots: ClosedSlot[];
  onToast: (message: string) => void;
}

/**
 * Doctor x (day, period) grid for an in-progress staging run. Clone of
 * MasterRotaGrid (staging plan, Task 6), not a generalisation of it -
 * kept separate to avoid destabilising the existing component and its
 * tests - an accepted trade-off.
 *
 * Three differences from MasterRotaGrid:
 *  - day headers show the real calendar date (staging rows have one,
 *    unlike the dateless master template) and grey out on a closed date,
 *    copying RotaGrid's header treatment;
 *  - a session with is_on_leave gets a small amber "Leave" badge -
 *    informational only, the popover stays available, since the whole
 *    point of staging is often to arrange cover for that exact leave;
 *  - a session with is_extra_session gets a small sky "Extra planned"
 *    badge, informational only in the same way. is_extra_session means
 *    "a planned extra session exists for this doctor/date/period", not
 *    "this row was produced by the override" - the two can diverge (the
 *    template row was already working, leave blocked the override, the
 *    entry was added after staging started, or the cell was edited
 *    back), which is why the badge is worded as a plan rather than a
 *    claim about this row's origin. Both badges can appear on the same
 *    cell (leave plus a stale planned extra session), which is
 *    intentional and is what makes that conflict visible to the admin;
 *  - no undo plumbing: mutation results go straight to a plain success/
 *    error toast via onToast, there is no MasterUndoEntry construction.
 *
 * MasterCellEditPopover is reused unchanged - it is hook-agnostic (pure
 * props/callbacks) and StagingSession is a structural superset of
 * MasterRotaSession, so it is accepted here with no adaptation.
 */
export function StagingGrid({ sessions, stagingId, startDate, numWeeks, closedSlots, onToast }: StagingGridProps) {
  const { data: doctors, isLoading: doctorsLoading } = useDoctors(false);
  const { data: rooms, isLoading: roomsLoading } = useRooms();
  const updateSession = useUpdateStagingSession();
  const createSession = useCreateStagingSession();
  const deleteSession = useDeleteStagingSession();
  const saving = updateSession.isPending || createSession.isPending || deleteSession.isPending;

  const grid = useMemo(() => pivotStaging(sessions, doctors ?? [], numWeeks), [sessions, doctors, numWeeks]);
  const [activeWeek, setActiveWeek] = useState(grid.weeks[0] ?? 1);

  const closedSlotSet = useMemo(() => toClosedSlotSet(closedSlots), [closedSlots]);

  if (doctorsLoading || roomsLoading) {
    return <p className="text-sm text-ink/70">Loading grid...</p>;
  }

  function handlePick(session: StagingSession, sessionType: MasterSessionType, roomId: number | null) {
    updateSession.mutate(
      { stagingId, sessionId: session.session_id, sessionType, roomId },
      {
        onSuccess: () => onToast("Applied"),
        onError: () => onToast("Could not apply that change"),
      },
    );
  }

  function handleCreate(doctorId: number, week: number, day: Day, period: Period, sessionType: MasterSessionType, roomId: number | null) {
    createSession.mutate(
      { stagingId, doctorId, week, day, period, sessionType, roomId },
      {
        onSuccess: () => onToast("Session added"),
        onError: () => onToast("Could not add that session"),
      },
    );
  }

  function handleDelete(session: StagingSession) {
    deleteSession.mutate(
      { stagingId, sessionId: session.session_id },
      {
        onSuccess: () => onToast("Session removed"),
        onError: () => onToast("Could not remove that session"),
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
              week === activeWeek ? "border-b-2 border-accent text-accent" : "text-ink/60 hover:text-ink"
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
              {DAYS.map((day, dayIndex) => {
                const date = rotaDate(startDate, activeWeek, day);
                const fullyClosed = isDayFullyClosed(closedSlotSet, date);
                const partlyClosed = isDayPartlyClosed(closedSlotSet, date);
                const closedPeriod = partlyClosedPeriod(closedSlotSet, date);
                return (
                  <th
                    key={day}
                    data-testid={`staging-day-header-${day}`}
                    className={`border-b-2 border-ink/40 px-2 py-1 text-center font-medium ${
                      fullyClosed ? "bg-gray-200 text-ink/40" : "text-ink/70"
                    } ${dayIndex === DAYS.length - 1 ? "" : "border-r-2"}`}
                  >
                    {day}
                    <div className="text-[10px] font-normal">{date}</div>
                    {fullyClosed ? <div className="text-[10px] font-normal">closed</div> : null}
                    {partlyClosed ? <div className="text-[10px] font-normal">{`closed (${closedPeriod})`}</div> : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map(({ doctor, inactiveWithSessions }, rowIndex) => {
              const isLastDoctor = rowIndex === grid.rows.length - 1;
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
                        {inactiveWithSessions ? <div className="text-xs text-ink/50">(inactive)</div> : null}
                      </td>
                    ) : null}
                    <td
                      className={`sticky left-24 z-10 border-r-2 border-ink/40 bg-background px-2 py-1 text-xs font-medium text-ink/70 ${groupDividerClass}`}
                    >
                      {period}
                    </td>
                    {DAYS.map((day, dayIndex) => {
                      const session = getStagingCell(grid, doctor.id, activeWeek, day, period);
                      const date = rotaDate(startDate, activeWeek, day);
                      const closed = isSlotClosed(closedSlotSet, date, period);
                      const dividerClassName = `${dayIndex === DAYS.length - 1 ? "" : "border-r-2 border-ink/40"} ${groupDividerClass}`;
                      if (closed) {
                        return (
                          <td
                            key={day}
                            className={`border border-border bg-gray-200 px-2 py-1 text-center ${dividerClassName}`}
                            data-testid={`staging-cell-${doctor.id}-${activeWeek}-${day}-${period}`}
                          />
                        );
                      }
                      return (
                        <td
                          key={day}
                          className={`border border-border px-2 py-1 text-center ${dividerClassName}`}
                          data-testid={`staging-cell-${doctor.id}-${activeWeek}-${day}-${period}`}
                        >
                          {session ? (
                            <MasterCellEditPopover
                              session={session}
                              week={activeWeek}
                              day={day}
                              period={period}
                              sessions={sessions}
                              rooms={rooms ?? []}
                              onPick={(sessionType, roomId) => handlePick(session, sessionType, roomId)}
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
                              onPick={(sessionType, roomId) => handleCreate(doctor.id, activeWeek, day, period, sessionType, roomId)}
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

function CellContent({ session }: { session: StagingSession }) {
  return (
    <>
      <SessionTypeBadge sessionType={session.session_type} />
      {session.is_on_leave ? (
        <div className="rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-900">Leave</div>
      ) : null}
      {session.is_extra_session ? (
        <div className="rounded bg-sky-100 px-1 text-[10px] font-medium text-sky-900">Extra planned</div>
      ) : null}
      {session.room_code ? <div className="text-xs font-medium">{session.room_code}</div> : null}
    </>
  );
}

function SessionTypeBadge({ sessionType }: { sessionType: StagingSession["session_type"] }) {
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