import { useMemo, useState } from "react";

import { useDoctors } from "@/api/doctors";
import { useCanWrite } from "@/auth/AuthContext";
import type { ApiError, Day, Doctor, MasterRotaSession, Period, Room } from "@/api/types";
import { DAYS, PERIODS } from "@/lib/pivot";
import { getMasterRotaCell, pivotMasterRota } from "@/lib/pivotMasterRota";

import { useCreateNurseSession, useDeleteNurseSession, useUpdateNurseSession } from "./api";
import { NurseCellEditPopover } from "./NurseCellEditPopover";
import type { NurseSessionType, NurseSlotOccupancy } from "./types";
import {
  buildNurseCreateUndoEntry,
  buildNurseDeleteUndoEntry,
  buildNursePatchUndoEntry,
  type NurseUndoEntry,
} from "./undo";

interface NurseRotaGridProps {
  sessions: MasterRotaSession[];
  /** Every room, and who else holds one in which slot. Props rather than
   * hooks of this component's own: `GET /rooms` is clinical-gated, so a
   * nurse_rota-only login cannot call useRooms(), and both arrive on the
   * page's single /nurse-rota/active fetch (DD8). */
  rooms: Room[];
  occupancy: NurseSlotOccupancy[];
  /** Called after any successful edit/create/delete, so the page can push
   * an undo entry and show a toast. A null entry means this edit is not
   * undoable through the nurse endpoints - see `undo.ts`'s
   * `asNurseSessionType`; the page clears the stack rather than leaving a
   * stale older entry behind an enabled Undo button. */
  onMutationApplied?: (entry: NurseUndoEntry | null, toastMessage: string) => void;
  onMutationError?: (message: string) => void;
}

/**
 * Nurse x (day, period) grid for the active master template - a clone of
 * MasterRotaGrid (DD10), reading and writing the same rows through the
 * nurse-gated endpoints.
 *
 * Rows are the nurses from /doctors (active_only=false), the same rule as
 * the master grid's: an active nurse with zero template sessions still
 * gets a row to populate, and an inactive nurse who still holds sessions
 * is flagged rather than silently dropped. Absent cells follow the same
 * rule too - a "+" affordance on an active nurse's row, inert on an
 * inactive one.
 *
 * No conflicts panel beside it: MasterRotaConflictsPanel recomputes
 * double-booked rooms from the session list, and this page holds nurse
 * rows only, so it could only ever see half a conflict. Conflicts stay
 * the Master Rota's job.
 */
export function NurseRotaGrid({
  sessions,
  rooms,
  occupancy,
  onMutationApplied,
  onMutationError,
}: NurseRotaGridProps) {
  const { data: doctors, isLoading: doctorsLoading } = useDoctors(false);
  // The popover already renders inert content for a read-level login, so
  // a filled cell needs no test here. An absent cell does: its content is
  // the "+" affordance itself, which would otherwise invite a click that
  // does nothing. MasterRotaGrid leaves it showing; this section is read
  // by people who will not know what an inert "+" means.
  const canWrite = useCanWrite();
  const updateSession = useUpdateNurseSession();
  const createSession = useCreateNurseSession();
  const deleteSession = useDeleteNurseSession();
  const saving = updateSession.isPending || createSession.isPending || deleteSession.isPending;

  const nurses = useMemo(
    () => (doctors ?? []).filter((d: Doctor) => d.doctor_type === "Nurse"),
    [doctors],
  );
  const grid = useMemo(() => pivotMasterRota(sessions, nurses), [sessions, nurses]);
  const [activeWeek, setActiveWeek] = useState(grid.weeks[0] ?? 1);

  if (doctorsLoading) {
    return <p className="text-sm text-ink/70">Loading grid...</p>;
  }

  function handlePick(
    session: MasterRotaSession,
    sessionType: NurseSessionType,
    roomId: number | null,
    displaced: MasterRotaSession | null,
  ) {
    updateSession.mutate(
      { sessionId: session.session_id, sessionType, roomId },
      {
        onSuccess: (data) =>
          onMutationApplied?.(
            // Built from `session`/`displaced`, the pre-mutation objects
            // captured at click time - the response carries the post-write
            // state, in which a displaced row's original type is already
            // gone.
            buildNursePatchUndoEntry(session, displaced),
            sessionSetMessage(
              data.session.doctor_code,
              data.session.day,
              data.session.period,
              data.session.session_type,
              data.session.room_code,
            ),
          ),
        onError: (error) => onMutationError?.(writeErrorMessage(error)),
      },
    );
  }

  function handleCreate(
    doctorId: number,
    week: number,
    day: Day,
    period: Period,
    sessionType: NurseSessionType,
    roomId: number | null,
    displaced: MasterRotaSession | null,
  ) {
    createSession.mutate(
      { doctorId, week, day, period, sessionType, roomId },
      {
        onSuccess: (data) =>
          onMutationApplied?.(
            buildNurseCreateUndoEntry(data.session.session_id, displaced),
            sessionCreatedMessage(
              data.session.doctor_code,
              data.session.day,
              data.session.period,
              data.session.session_type,
              data.session.room_code,
            ),
          ),
        onError: (error) => onMutationError?.(writeErrorMessage(error)),
      },
    );
  }

  function handleDelete(session: MasterRotaSession) {
    deleteSession.mutate(
      { sessionId: session.session_id },
      {
        onSuccess: () =>
          onMutationApplied?.(
            buildNurseDeleteUndoEntry(session),
            sessionDeletedMessage(session.doctor_code, session.day, session.period),
          ),
        onError: (error) => onMutationError?.(writeErrorMessage(error)),
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
                Nurse
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
              const isLastNurse = rowIndex === grid.rows.length - 1;
              // The nurse cell only renders once (rowSpan, at periodIndex
              // 0), so it cannot reuse the per-row divider class below.
              const nurseCellGroupDividerClass = isLastNurse ? "" : "border-b-2";
              return PERIODS.map((period, periodIndex) => {
                const isGroupEnd = periodIndex === PERIODS.length - 1 && !isLastNurse;
                const groupDividerClass = isGroupEnd ? "border-b-2 border-ink/40" : "";
                return (
                  <tr key={`${doctor.id}-${period}`}>
                    {periodIndex === 0 ? (
                      <td
                        rowSpan={PERIODS.length}
                        className={`sticky left-0 z-10 whitespace-nowrap border-r-2 border-ink/40 bg-background px-2 py-1 align-top font-medium ${nurseCellGroupDividerClass}`}
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
                          data-testid={`nurse-cell-${doctor.id}-${activeWeek}-${day}-${period}`}
                        >
                          {session ? (
                            <NurseCellEditPopover
                              session={session}
                              week={activeWeek}
                              day={day}
                              period={period}
                              sessions={sessions}
                              occupancy={occupancy}
                              rooms={rooms}
                              onPick={(sessionType, roomId, displaced) =>
                                handlePick(session, sessionType, roomId, displaced)
                              }
                              onDelete={() => handleDelete(session)}
                              saving={saving}
                            >
                              <div>
                                <CellContent session={session} />
                              </div>
                            </NurseCellEditPopover>
                          ) : doctor.active && canWrite ? (
                            <NurseCellEditPopover
                              session={null}
                              week={activeWeek}
                              day={day}
                              period={period}
                              sessions={sessions}
                              occupancy={occupancy}
                              rooms={rooms}
                              onPick={(sessionType, roomId, displaced) =>
                                handleCreate(
                                  doctor.id, activeWeek, day, period, sessionType, roomId, displaced,
                                )
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
                            </NurseCellEditPopover>
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

/**
 * A nurse row only ever holds three types, but the cell renders whatever
 * the row actually carries: a row predating this section, or one the
 * Master Rota wrote, may hold any of the five, and showing it wrongly
 * would hide the thing somebody needs to fix.
 */
function CellContent({ session }: { session: MasterRotaSession }) {
  return (
    <>
      <SessionTypeBadge sessionType={session.session_type} />
      {session.room_code ? <div className="text-xs font-medium">{session.room_code}</div> : null}
    </>
  );
}

function SessionTypeBadge({ sessionType }: { sessionType: MasterRotaSession["session_type"] }) {
  if (sessionType === "no_surgery") {
    return <span className="rounded bg-ink/10 px-1 text-xs font-medium">Not working</span>;
  }
  if (sessionType === "admin_time") {
    return <span className="rounded bg-ink/10 px-1 text-xs font-medium">Admin</span>;
  }
  if (sessionType === "wfh") {
    return <span className="rounded bg-ink/10 px-1 text-xs font-medium">WFH</span>;
  }
  // requires_room on a nurse row is a bug state rather than a choice (no
  // phase ever rooms an inert doctor), so it is named as such instead of
  // rendering as an ordinary empty clinic cell.
  if (sessionType === "requires_room") {
    return <span className="rounded bg-ink/10 px-1 text-xs font-medium">Needs fixing</span>;
  }
  return null;
}

// --- Toast messages ---
// Local to the section rather than lib/masterUndo's equivalents: the
// labels differ ("Not working", no five-type table). They stayed here
// rather than moving into the section's own undo.ts when that landed -
// they are what the grid says about a write, not part of replaying one.

const SESSION_TYPE_LABEL: Record<MasterRotaSession["session_type"], string> = {
  pre_assigned: "Pre-assigned",
  admin_time: "Admin time",
  no_surgery: "Not working",
  requires_room: "Needs fixing",
  wfh: "WFH",
};

function describeSession(sessionType: MasterRotaSession["session_type"], roomCode: string | null): string {
  const label = SESSION_TYPE_LABEL[sessionType];
  return roomCode ? `${label} ${roomCode}` : label;
}

function sessionSetMessage(
  doctorCode: string,
  day: Day,
  period: Period,
  sessionType: MasterRotaSession["session_type"],
  roomCode: string | null,
): string {
  return `${doctorCode} ${day} ${period} set to ${describeSession(sessionType, roomCode)}`;
}

function sessionCreatedMessage(
  doctorCode: string,
  day: Day,
  period: Period,
  sessionType: MasterRotaSession["session_type"],
  roomCode: string | null,
): string {
  return `${doctorCode} ${day} ${period} session added (${describeSession(sessionType, roomCode)})`;
}

function sessionDeletedMessage(doctorCode: string, day: Day, period: Period): string {
  return `${doctorCode} ${day} ${period} session removed`;
}

/**
 * The server's own words when it has some, rather than a generic
 * failure. The one refusal a user will actually meet here is the 409 for
 * a room a doctor holds - it names the holder, and "Could not apply that
 * change" would throw that away. A stale occupancy list is exactly how
 * that 409 is reached despite the room rendering pickable.
 */
function writeErrorMessage(error: ApiError): string {
  return typeof error.detail === "string" ? error.detail : "Could not apply that change";
}
