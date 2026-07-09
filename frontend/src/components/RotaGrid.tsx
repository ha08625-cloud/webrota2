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

import { usePatchSession, useRotaIssues, useSwapRoles, useSwapRooms } from "@/api/rota";
import { useClinicTypes } from "@/api/clinicTypes";
import { useDoctors } from "@/api/doctors";
import { useRooms } from "@/api/rooms";
import type { ClinicType, Day, Period, Room, Rota, RotaSession } from "@/api/types";
import { CellEditPopover } from "@/components/CellEditPopover";
import { mutationAppliedMessage } from "@/components/Toast";
import { type CellBackground, type FontColor, cellStyle } from "@/lib/cellStyle";
import { type ChipType, canDrop } from "@/lib/dragRules";
import { DAYS, PERIODS, getCell, pivotRota, weekNumbers } from "@/lib/pivot";
import { resolveDragOutcome } from "@/lib/resolveDrag";
import type { UndoEntry } from "@/lib/undoStack";

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
  /** Called after any successful swap/move/patch, so RotaDetailPage can push an undo entry and show a toast. */
  onMutationApplied?: (entry: UndoEntry, toastMessage: string) => void;
  /** Called on any mutation failure - covers the (UI-unreachable but not impossible) 409 from a committed rota. */
  onMutationError?: () => void;
}

interface ActiveChip {
  type: ChipType;
  session: RotaSession;
}

/**
 * Rota grid: week tabs, pivoted doctor x (day, period) table, full Q13
 * cell colouring. Used both for draft rotas (editable) and committed
 * rotas (Q10 for free - read-only automatically, since `editable` below
 * is derived from rota.status). Drag sources/targets and the edit
 * popover simply aren't rendered for a committed rota - there is no
 * separate read-only component variant to keep in sync.
 */
export function RotaGrid({ rota, onMutationApplied, onMutationError }: RotaGridProps) {
  const editable = rota.status === "draft";

  const { data: doctors, isLoading: doctorsLoading } = useDoctors(false);
  const { data: rooms, isLoading: roomsLoading } = useRooms();
  const { data: clinicTypes, isLoading: clinicTypesLoading } = useClinicTypes();
  const { data: issues } = useRotaIssues(rota.rota_id);

  const swapRoles = useSwapRoles();
  const swapRooms = useSwapRooms();
  const patchSession = usePatchSession();

  const weeks = useMemo(() => weekNumbers(rota.num_weeks), [rota.num_weeks]);
  const [activeWeek, setActiveWeek] = useState(weeks[0] ?? 1);
  const [activeChip, setActiveChip] = useState<ActiveChip | null>(null);

  const roomsById = useMemo(() => toIdMap(rooms), [rooms]);
  const clinicTypesById = useMemo(() => toIdMap(clinicTypes), [clinicTypes]);
  const grid = useMemo(
    () => pivotRota(rota.sessions, doctors ?? []),
    [rota.sessions, doctors],
  );

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

  function handlePopoverSave(session: RotaSession, isWfh: boolean, notes: string | null) {
    const issuesBefore = issues?.length ?? 0;
    patchSession.mutate(
      { rotaId: rota.rota_id, sessionId: session.session_id, isWfh, notes },
      {
        onSuccess: (data) => {
          const entry: UndoEntry = {
            kind: "patch",
            sessionId: session.session_id,
            previousIsWfh: session.is_wfh,
            previousNotes: session.notes,
            previousRoomId: session.room_id,
            previousRoomCode: session.room_code,
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
                  return editable ? (
                    <EditableGridCell
                      key={day}
                      week={activeWeek}
                      doctorId={doctor.id}
                      day={day}
                      period={period}
                      session={session}
                      roomsById={roomsById}
                      clinicTypesById={clinicTypesById}
                      activeChip={activeChip}
                      onSave={handlePopoverSave}
                      saving={patchSession.isPending}
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
      {/* Week tabs always render, even for a single-week rota - keeps the
          tab UI consistent rather than conditionally reshaping around
          num_weeks. */}
      <div className="flex gap-1 border-b border-border" role="tablist" aria-label="Week">
        {weeks.map((week) => (
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
      <CellContent session={session} fontColorClass={FONT_CLASS[style.fontColor]} />
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
  roomsById: Map<number, Room>;
  clinicTypesById: Map<number, ClinicType>;
  activeChip: ActiveChip | null;
  onSave: (session: RotaSession, isWfh: boolean, notes: string | null) => void;
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
  roomsById,
  clinicTypesById,
  activeChip,
  onSave,
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
    <CellContent session={session} fontColorClass={FONT_CLASS[style.fontColor]} draggable />
  );

  return (
    <td
      ref={setNodeRef}
      className={`border border-border px-2 py-1 text-center ${BACKGROUND_CLASS[style.background]} ${highlightClass} ${isOver && isEligibleTarget ? "bg-accent/10" : ""} ${dividerClassName}`}
      data-testid={`cell-${doctorId}-${week}-${day}-${period}`}
      data-week-day-period={`${week}-${day}-${period}`}
    >
      <CellEditPopover session={session} onSave={(isWfh, notes) => onSave(session, isWfh, notes)} saving={saving}>
        <div>{cellBody}</div>
      </CellEditPopover>
    </td>
  );
}

// --- Shared cell content ---

interface CellContentProps {
  session: RotaSession;
  fontColorClass: string;
  draggable?: boolean;
}

function CellContent({ session, fontColorClass, draggable = false }: CellContentProps) {
  return (
    <>
      {session.is_on_leave ? <span className="text-xs font-medium text-ink/70">LEAVE</span> : null}
      {!session.is_on_leave && session.is_wfh ? (
        <span className="rounded bg-ink/10 px-1 text-xs font-medium">WFH</span>
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
    </>
  );
}

function RoleLabel({ role, clinicName }: { role: string | null; clinicName: string | null }) {
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