import {
  DndContext,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useMemo, useState } from "react";

import { usePatchSession, useRotaIssues, useSetRole, useSetRoom, useSwapRoles, useSwapRooms } from "@/api/rota";
import { useClinicTypes } from "@/api/clinicTypes";
import { useClosures } from "@/api/closures";
import { useDoctors } from "@/api/doctors";
import { useRooms } from "@/api/rooms";
import type { ClinicType, Day, Period, Room, Rota, RotaSession } from "@/api/types";
import { CellEditPopover, type RoleTriple } from "@/components/CellEditPopover";
import { mutationAppliedMessage } from "@/components/Toast";
import { WeekTabs } from "@/components/WeekTabs";
import { type CellBackground, type FontColor, cellStyle } from "@/lib/cellStyle";
import { type ChipType, canDrop } from "@/lib/dragRules";
import { DAYS, PERIODS, getCell, pivotRota, weekNumbers } from "@/lib/pivot";
import { resolveDragOutcome } from "@/lib/resolveDrag";
import { countSupervisableTrainees } from "@/lib/superviseeCount";
import type { UndoEntry } from "@/lib/undoStack";
import { rotaDate } from "@/lib/weekDates";

const BACKGROUND_CLASS: Record<CellBackground, string> = {
  leave: "bg-gray-200",
  wfh: "bg-white",
  duty: "bg-red-100",
  duty_helper: "bg-blue-100",
  clinic: "bg-green-100",
  no_surgery: "bg-gray-200",
  default: "bg-white",
};

const FONT_CLASS: Record<FontColor, string> = {
  black: "text-ink",
  red: "text-red-700",
  blue: "text-blue-700",
};

interface RotaGridProps {
  rota: Rota;
  /** Controlled week selection, owned by RotaDetailPage so it survives a
   * doctor-view/room-view toggle. RotaGrid trusts the caller rather than
   * clamping against rota.num_weeks - the page initialises to 1 and only
   * ever sets values sourced from the tab strip itself. */
  activeWeek: number;
  onWeekChange: (week: number) => void;
  /** Called after any successful swap/move/patch, so RotaDetailPage can push an undo entry and show a toast. */
  onMutationApplied?: (entry: UndoEntry, toastMessage: string) => void;
  /** Called on any mutation failure - covers the (UI-unreachable but not impossible) 409 from a committed rota. */
  onMutationError?: () => void;
}

interface ActiveChip {
  type: ChipType;
  session: RotaSession;
}

function supervisedCountKey(week: number, day: Day, period: Period): string {
  return `${week}:${day}:${period}`;
}

/**
 * Rota grid: week tabs, pivoted doctor x (day, period) table, full Q13
 * cell colouring. Used both for draft rotas (editable) and committed
 * rotas (Q10 for free - read-only automatically, since `editable` below
 * is derived from rota.status). Drag sources/targets and the edit
 * popover simply aren't rendered for a committed rota - there is no
 * separate read-only component variant to keep in sync.
 */
export function RotaGrid({ rota, activeWeek, onWeekChange, onMutationApplied, onMutationError }: RotaGridProps) {
  const editable = rota.status === "draft";

  const { data: doctors, isLoading: doctorsLoading } = useDoctors(false);
  const { data: rooms, isLoading: roomsLoading } = useRooms();
  const { data: clinicTypes, isLoading: clinicTypesLoading } = useClinicTypes();
  const { data: issues } = useRotaIssues(rota.rota_id);
  const { data: closures } = useClosures();

  const swapRoles = useSwapRoles();
  const swapRooms = useSwapRooms();
  const patchSession = usePatchSession();
  const setRoom = useSetRoom();
  const setRole = useSetRole();

  const weeks = useMemo(() => weekNumbers(rota.num_weeks), [rota.num_weeks]);
  const [activeChip, setActiveChip] = useState<ActiveChip | null>(null);

  const roomsById = useMemo(() => toIdMap(rooms), [rooms]);
  const clinicTypesById = useMemo(() => toIdMap(clinicTypes), [clinicTypes]);
  const grid = useMemo(
    () => pivotRota(rota.sessions, doctors ?? []),
    [rota.sessions, doctors],
  );

  /**
   * Which calendar dates are closed for this rota (M5) - authoritative
   * from rota.closed_dates, the RotaClosure snapshot taken at generation
   * time, never the live PracticeClosure table (see RotaOut docstring):
   * a closure added or removed afterwards must not change how an
   * already-generated rota renders.
   */
  const closedDatesSet = useMemo(() => new Set(rota.closed_dates), [rota.closed_dates]);

  /**
   * Closure name lookup, purely cosmetic (M5 plan: "column header may
   * show the closure name if present"). Deliberately sourced from the
   * *live* closures list, unlike closedDatesSet above - a closure's name
   * is display-only trivia, not part of what makes a date "closed" for
   * this rota, so falling back to no name (rather than snapshotting it)
   * if the closure is later renamed or deleted is an acceptable, low-risk
   * cosmetic gap.
   */
  const closureNameByDate = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const c of closures ?? []) map.set(c.date, c.name);
    return map;
  }, [closures]);

  /**
   * Supervising badge counts (Phase 9C plan, section 5): computed once
   * per (week, day, period) here, not per cell render - every cell in a
   * session shares the same count, and only the flagged supervisor's
   * cell ever displays it. Keyed rather than threaded as a nested
   * structure so the render loop below can do an O(1) lookup per cell.
   */
  const supervisedCounts = useMemo(() => {
    const map = new Map<string, number>();
    const doctorList = doctors ?? [];
    for (const week of weeks) {
      for (const day of DAYS) {
        for (const period of PERIODS) {
          map.set(
            supervisedCountKey(week, day, period),
            countSupervisableTrainees(rota.sessions, doctorList, week, day, period),
          );
        }
      }
    }
    return map;
  }, [rota.sessions, doctors, weeks]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  if (doctorsLoading || roomsLoading || clinicTypesLoading) {
    return <p className="text-sm text-ink/70">Loading grid...</p>;
  }

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current as ActiveChip | undefined;
    if (data) setActiveChip(data);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveChip(null);
    const activeData = event.active.data.current as ActiveChip | undefined;
    const overData = event.over?.data.current as { session: RotaSession } | undefined;

    const outcome = resolveDragOutcome(activeData, overData);
    if (!outcome) return;

    const issuesBefore = issues?.length ?? 0;
    const mutation = outcome.chipType === "role" ? swapRoles : swapRooms;

    mutation.mutate(
      { rotaId: rota.rota_id, sessionAId: outcome.sessionAId, sessionBId: outcome.sessionBId },
      {
        onSuccess: (data) => {
          onMutationApplied?.(outcome.undoEntry, mutationAppliedMessage(issuesBefore, data.issues.length));
        },
        onError: () => onMutationError?.(),
      },
    );
  }

  function handlePopoverSave(session: RotaSession, isWfh: boolean, notes: string | null, isSupervising: boolean) {
    const issuesBefore = issues?.length ?? 0;
    patchSession.mutate(
      { rotaId: rota.rota_id, sessionId: session.session_id, isWfh, notes, isSupervising },
      {
        onSuccess: (data) => {
          const entry: UndoEntry = {
            kind: "patch",
            sessionId: session.session_id,
            previousIsWfh: session.is_wfh,
            previousNotes: session.notes,
            previousIsSupervising: session.is_supervising,
            previousRoomId: session.room_id,
            previousRoomCode: session.room_code,
          };
          onMutationApplied?.(entry, mutationAppliedMessage(issuesBefore, data.issues.length));
        },
        onError: () => onMutationError?.(),
      },
    );
  }

  function handleSetRoom(session: RotaSession, roomId: number | null, displaced: RotaSession | null) {
    const issuesBefore = issues?.length ?? 0;
    setRoom.mutate(
      { rotaId: rota.rota_id, sessionId: session.session_id, roomId },
      {
        onSuccess: (data) => {
          const entry: UndoEntry = {
            kind: "set-room",
            sessionId: session.session_id,
            previousRoomId: session.room_id,
            previousIsWfh: session.is_wfh,
            previousNotes: session.notes,
            displaced: displaced ? { sessionId: displaced.session_id, roomId: displaced.room_id } : null,
          };
          onMutationApplied?.(entry, mutationAppliedMessage(issuesBefore, data.issues.length));
        },
        onError: () => onMutationError?.(),
      },
    );
  }

  function handleSetRole(session: RotaSession, triple: RoleTriple, displaced: RotaSession | null) {
    const issuesBefore = issues?.length ?? 0;
    setRole.mutate(
      { rotaId: rota.rota_id, sessionId: session.session_id, triple },
      {
        onSuccess: (data) => {
          // roomWasCleared is read off this response, not predicted from
          // the triple: it is true exactly when the server's own
          // auto-clear rule fired (see set_role's docstring).
          const roomWasCleared = session.room_id !== null && data.session.room_id === null;
          const entry: UndoEntry = {
            kind: "set-role",
            sessionId: session.session_id,
            previous: {
              role: session.role,
              clinicTypeId: session.clinic_type_id,
              templateType: session.template_type,
              roomId: session.room_id,
            },
            roomWasCleared,
            displaced: displaced
              ? {
                  sessionId: displaced.session_id,
                  role: displaced.role,
                  clinicTypeId: displaced.clinic_type_id,
                  templateType: displaced.template_type,
                }
              : null,
          };
          onMutationApplied?.(entry, mutationAppliedMessage(issuesBefore, data.issues.length));
        },
        onError: () => onMutationError?.(),
      },
    );
  }

  const table = (
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
            const date = rotaDate(rota.start_date, activeWeek, day);
            const closed = closedDatesSet.has(date);
            const closureName = closureNameByDate.get(date);
            return (
              <th
                key={day}
                data-testid={`day-header-${day}`}
                className={`border-b-2 border-ink/40 px-2 py-1 text-center font-medium ${
                  closed ? "bg-gray-200 text-ink/40" : "text-ink/70"
                } ${dayIndex === DAYS.length - 1 ? "" : "border-r-2"}`}
              >
                {day}
                {closed ? (
                  <div className="text-[10px] font-normal">{closureName ? closureName : "closed"}</div>
                ) : null}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {grid.rows.map(({ doctor, inactiveWithSessions }, rowIndex) => {
          const isLastDoctor = rowIndex === grid.rows.length - 1;
          // Computed independently of periodIndex: the doctor cell only
          // renders once (rowSpan, at periodIndex 0) but its bottom edge
          // sits at the PM row regardless, so it can't reuse the
          // per-row groupDividerClass below (which is false at
          // periodIndex 0).
          const doctorCellGroupDividerClass = isLastDoctor ? "" : "border-b-2";
          return PERIODS.map((period, periodIndex) => {
            // Heavier divider under the PM row of every doctor except the
            // last - the last doctor's bottom edge is instead handled by
            // the outer frame on the scroll container, avoiding a doubled
            // border where the two would otherwise coincide.
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
                  const session = getCell(grid, doctor.id, activeWeek, day, period);
                  // Right divider between every day column, except the
                  // last (Friday), where the outer frame takes over.
                  const dividerClassName = `${dayIndex === DAYS.length - 1 ? "" : "border-r-2 border-ink/40"} ${groupDividerClass}`;
                  const supervisedCount = supervisedCounts.get(supervisedCountKey(activeWeek, day, period)) ?? 0;
                  return editable ? (
                    <EditableGridCell
                      key={day}
                      week={activeWeek}
                      doctorId={doctor.id}
                      day={day}
                      period={period}
                      session={session}
                      supervisedCount={supervisedCount}
                      allSessions={rota.sessions}
                      rooms={rooms ?? []}
                      clinicTypes={clinicTypes ?? []}
                      roomsById={roomsById}
                      clinicTypesById={clinicTypesById}
                      activeChip={activeChip}
                      onSave={handlePopoverSave}
                      onSetRoom={handleSetRoom}
                      onSetRole={handleSetRole}
                      saving={patchSession.isPending || setRoom.isPending || setRole.isPending}
                      dividerClassName={dividerClassName}
                    />
                  ) : (
                    <ReadOnlyGridCell
                      key={day}
                      doctorId={doctor.id}
                      week={activeWeek}
                      day={day}
                      period={period}
                      session={session}
                      supervisedCount={supervisedCount}
                      roomsById={roomsById}
                      clinicTypesById={clinicTypesById}
                      dividerClassName={dividerClassName}
                    />
                  );
                })}
              </tr>
            );
          });
        })}
      </tbody>
    </table>
  );

  return (
    <div>
      <WeekTabs weeks={weeks} activeWeek={activeWeek} onWeekChange={onWeekChange} />

      <div className="mt-4 overflow-x-auto rounded border-2 border-ink/40">
        {editable ? (
          <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            {table}
            {/* Floating preview that follows the pointer - DragOverlay
                positions itself via its own portal, so no manual
                transform is needed here (that's only for moving the
                original element in place, which the opacity-40 dim on
                DraggableChip's isDragging state already substitutes for). */}
            <DragOverlay>{activeChip ? <ChipOverlayPreview activeChip={activeChip} /> : null}</DragOverlay>
          </DndContext>
        ) : (
          table
        )}
      </div>
    </div>
  );
}

// --- Read-only cell (committed rotas, or any rota with editable=false) ---
// Unchanged from Task 3: no dnd-kit hooks, no popover - a committed rota
// should never call useDraggable/useDroppable, since those require a
// DndContext ancestor that this path deliberately doesn't render.

interface ReadOnlyGridCellProps {
  doctorId: number;
  week: number;
  day: Day;
  period: Period;
  session: RotaSession | undefined;
  /** See RotaGrid's supervisedCounts memo - one lookup per (week, day, period), shared by every cell in the session. */
  supervisedCount: number;
  roomsById: Map<number, Room>;
  clinicTypesById: Map<number, ClinicType>;
  /** Heavier border-r/border-b classes for the column-to-column and
   * doctor-group dividers, computed once per cell by the caller (which
   * knows the day index and doctor-group boundaries) rather than
   * re-derived here. */
  dividerClassName: string;
}

function ReadOnlyGridCell({
  doctorId,
  week,
  day,
  period,
  session,
  supervisedCount,
  roomsById,
  clinicTypesById,
  dividerClassName,
}: ReadOnlyGridCellProps) {
  const style = cellStyle(session, roomsById, clinicTypesById);

  if (session === undefined) {
    return (
      <td
        className={`border border-border bg-gray-100 ${dividerClassName}`}
        aria-label="Absent"
        data-week-day-period={`${week}-${day}-${period}`}
      />
    );
  }

  return (
    <td
      className={`border border-border px-2 py-1 text-center ${BACKGROUND_CLASS[style.background]} ${dividerClassName}`}
      data-testid={`cell-${doctorId}-${week}-${day}-${period}`}
      data-week-day-period={`${week}-${day}-${period}`}
    >
      <CellContent session={session} fontColorClass={FONT_CLASS[style.fontColor]} supervisedCount={supervisedCount} />
    </td>
  );
}

// --- Editable cell (draft rotas) ---

interface EditableGridCellProps {
  week: number;
  doctorId: number;
  day: Day;
  period: Period;
  session: RotaSession | undefined;
  /** See RotaGrid's supervisedCounts memo - one lookup per (week, day, period), shared by every cell in the session. */
  supervisedCount: number;
  /** The rota's flat session list, threaded down to CellEditPopover for client-side steal detection. */
  allSessions: RotaSession[];
  rooms: Room[];
  clinicTypes: ClinicType[];
  roomsById: Map<number, Room>;
  clinicTypesById: Map<number, ClinicType>;
  activeChip: ActiveChip | null;
  onSave: (session: RotaSession, isWfh: boolean, notes: string | null, isSupervising: boolean) => void;
  onSetRoom: (session: RotaSession, roomId: number | null, displaced: RotaSession | null) => void;
  onSetRole: (session: RotaSession, triple: RoleTriple, displaced: RotaSession | null) => void;
  saving: boolean;
  /** See ReadOnlyGridCellProps.dividerClassName. */
  dividerClassName: string;
}

function EditableGridCell({
  week,
  doctorId,
  day,
  period,
  session,
  supervisedCount,
  allSessions,
  rooms,
  clinicTypes,
  roomsById,
  clinicTypesById,
  activeChip,
  onSave,
  onSetRoom,
  onSetRole,
  saving,
  dividerClassName,
}: EditableGridCellProps) {
  const style = cellStyle(session, roomsById, clinicTypesById);
  const dropDisabled = session === undefined || session.is_on_leave || session.is_wfh;

  const { setNodeRef, isOver } = useDroppable({
    id: `cell:${week}:${doctorId}:${day}:${period}`,
    data: session ? { session } : undefined,
    disabled: dropDisabled,
  });

  if (session === undefined) {
    return (
      <td
        className={`border border-border bg-gray-100 ${dividerClassName}`}
        aria-label="Absent"
        data-week-day-period={`${week}-${day}-${period}`}
      />
    );
  }

  const isSelf = activeChip?.session.session_id === session.session_id;
  const isEligibleTarget = !isSelf && activeChip !== null && canDrop(activeChip.type, activeChip.session, session);
  const isIneligibleTarget = !isSelf && activeChip !== null && !isEligibleTarget;

  const highlightClass = isEligibleTarget
    ? "ring-2 ring-inset ring-accent"
    : isIneligibleTarget
      ? "opacity-40"
      : "";

  const cellBody = (
    <CellContent session={session} fontColorClass={FONT_CLASS[style.fontColor]} supervisedCount={supervisedCount} draggable />
  );

  // Leave cells: the popover trigger is not rendered at all (M4.1 plan) -
  // there is nothing to edit on a session the doctor isn't working.
  if (session.is_on_leave) {
    return (
      <td
        ref={setNodeRef}
        className={`border border-border px-2 py-1 text-center ${BACKGROUND_CLASS[style.background]} ${highlightClass} ${isOver && isEligibleTarget ? "bg-accent/10" : ""} ${dividerClassName}`}
        data-testid={`cell-${doctorId}-${week}-${day}-${period}`}
        data-week-day-period={`${week}-${day}-${period}`}
      >
        {cellBody}
      </td>
    );
  }

  return (
    <td
      ref={setNodeRef}
      className={`border border-border px-2 py-1 text-center ${BACKGROUND_CLASS[style.background]} ${highlightClass} ${isOver && isEligibleTarget ? "bg-accent/10" : ""} ${dividerClassName}`}
      data-testid={`cell-${doctorId}-${week}-${day}-${period}`}
      data-week-day-period={`${week}-${day}-${period}`}
    >
      <CellEditPopover
        session={session}
        sessions={allSessions}
        rooms={rooms}
        clinicTypes={clinicTypes}
        onSave={(isWfh, notes, isSupervising) => onSave(session, isWfh, notes, isSupervising)}
        onSetRoom={(roomId, displaced) => onSetRoom(session, roomId, displaced)}
        onSetRole={(triple, displaced) => onSetRole(session, triple, displaced)}
        saving={saving}
      >
        <div>{cellBody}</div>
      </CellEditPopover>
    </td>
  );
}

// --- Shared cell content ---

interface CellContentProps {
  session: RotaSession;
  fontColorClass: string;
  /** See RotaGrid's supervisedCounts memo. Only rendered when session.is_supervising is true. */
  supervisedCount: number;
  draggable?: boolean;
}

function CellContent({ session, fontColorClass, supervisedCount, draggable = false }: CellContentProps) {
  return (
    <>
      {session.is_on_leave ? <span className="text-xs font-medium text-ink/70">LEAVE</span> : null}
      {!session.is_on_leave && session.is_wfh ? (
        <span className="rounded bg-ink/10 px-1 text-xs font-medium">WFH</span>
      ) : null}
      {!session.is_on_leave && session.is_supervising ? (
        <span className="rounded bg-ink/10 px-1 text-xs font-medium">
          {/* supervisedCount can be 0 if leave added after generation removes
              every countable trainee - shown plainly as "Supervising" rather
              than "Supervising x 0", which would read as a bug. The flag is
              still shown honestly regardless of eligibility; the issues
              panel carries any conflict (supervision_on_incompatible_slot),
              matching the role_on_incompatible_slot rendering philosophy. */}
          {supervisedCount > 0 ? `Supervising x ${supervisedCount}` : "Supervising"}
        </span>
      ) : null}
      {!session.is_on_leave && !session.is_wfh && session.role === null && session.template_type === "no_surgery" ? (
        <span className="rounded bg-ink/10 px-1 text-xs font-medium">No surgery</span>
      ) : null}
      {!session.is_on_leave && !session.is_wfh && session.role === null && session.template_type === "admin_time" ? (
        <span className="rounded bg-ink/10 px-1 text-xs font-medium">Admin</span>
      ) : null}
      {!session.is_on_leave ? (
        draggable && session.role !== null ? (
          <DraggableChip type="role" session={session} />
        ) : (
          <RoleLabel role={session.role} clinicName={session.clinic_type_name} />
        )
      ) : null}
      {!session.is_on_leave && !session.is_wfh && session.room_code ? (
        draggable ? (
          <DraggableChip type="room" session={session} className={fontColorClass} />
        ) : (
          <div className={`text-xs font-medium ${fontColorClass}`}>{session.room_code}</div>
        )
      ) : null}
      {session.notes ? (
        <div className="mx-auto max-w-[110px] whitespace-normal break-words text-[10px] italic text-ink/60">
          {session.notes}
        </div>
      ) : null}
    </>
  );
}

export function RoleLabel({ role, clinicName }: { role: string | null; clinicName: string | null }) {
  if (role === "duty_primary") return <div className="text-xs font-medium">Duty</div>;
  if (role === "duty_secondary") return <div className="text-xs font-medium">Duty (2nd)</div>;
  if (role === "clinic") return <div className="text-xs font-medium">{clinicName ?? "Clinic"}</div>;
  return null;
}

function chipLabel(type: ChipType, session: RotaSession): string | null {
  if (type === "role") {
    if (session.role === "duty_primary") return "Duty";
    if (session.role === "duty_secondary") return "Duty (2nd)";
    return session.clinic_type_name ?? "Clinic";
  }
  return session.room_code;
}

/**
 * PointerSensor's activationConstraint (8px, configured on DndContext)
 * is what distinguishes a genuine drag from a click here: dnd-kit
 * suppresses the trailing click event once a drag has actually started,
 * so a real drag-and-drop never also opens the popover. A press-and-
 * release on a chip with no movement is NOT intercepted as a drag, so it
 * falls through as an ordinary click and opens the popover via the
 * trigger it's nested inside - accepted as consistent with "click
 * anywhere on the cell opens it" rather than treated as a bug to route
 * around with an extra guard.
 */
function DraggableChip({ type, session, className = "" }: { type: ChipType; session: RotaSession; className?: string }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `${type}:${session.session_id}`,
    data: { type, session } satisfies ActiveChip,
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`cursor-grab select-none text-xs font-medium ${className} ${isDragging ? "opacity-40" : ""}`}
    >
      {chipLabel(type, session)}
    </div>
  );
}

/**
 * The floating copy DragOverlay portals to the pointer position while a
 * drag is in progress. Deliberately unstyled beyond matching the chip's
 * own text size/weight - it's a drag affordance, not a second place to
 * apply Q13's room-type font colour (the original chip already dims via
 * isDragging rather than needing this to carry that signal too).
 */
function ChipOverlayPreview({ activeChip }: { activeChip: ActiveChip }) {
  return (
    <div className="cursor-grabbing rounded border border-accent bg-surface px-2 py-1 text-xs font-medium shadow-lg">
      {chipLabel(activeChip.type, activeChip.session)}
    </div>
  );
}

function toIdMap<T extends { id: number }>(items: T[] | undefined): Map<number, T> {
  const map = new Map<number, T>();
  for (const item of items ?? []) {
    map.set(item.id, item);
  }
  return map;
}