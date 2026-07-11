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
import { Fragment, useMemo, useState } from "react";

import { useCreateDuty, useDeleteDuty, useDuty } from "@/api/duty";
import { useDoctors } from "@/api/doctors";
import type { Doctor, DutyAssignment, DutyType, Period } from "@/api/types";
import { addDays, formatWeekLabel } from "@/lib/date";
import { isDutyWeekComplete } from "@/lib/dutyWeekComplete";
import { buildColumns } from "@/lib/dutyWeekSlots";
import { groupDoctorsByType } from "@/lib/groupDoctors";
import { type DraggableDoctor, type DutySlot, resolveDutyDrop } from "@/lib/resolveDutyDrop";

const PERIODS: Period[] = ["AM", "PM"];
const WEEK_COUNT = 4;

function findAssignment(
  assignments: DutyAssignment[],
  date: string,
  period: Period,
  dutyType: DutyType,
): DutyAssignment | null {
  return assignments.find((a) => a.date === date && a.period === period && a.duty_type === dutyType) ?? null;
}

interface DutyGridProps {
  /** The first of the 4 displayed weeks' Monday, "YYYY-MM-DD". */
  startWeekDate: string;
}

/**
 * Drag-and-drop duty board: 4 consecutive weeks (starting from
 * startWeekDate), each its own 6-column x 2-period grid, stacked
 * vertically, sharing one doctor palette and one DndContext so a chip
 * can be dropped onto a slot in any of the 4 weeks. Dropping onto an
 * occupied slot confirms with the user, then deletes the existing
 * assignment and creates the new one as two sequential calls (no
 * combined endpoint exists - same "independent calls, honest partial
 * failure" pattern as the flat table's existing Delete button and
 * Leave's both-AM+PM add). Clicking the chip in a filled cell removes
 * it, same semantics as the flat table's Delete button, just relocated
 * onto the chip itself.
 *
 * Column/slot enumeration lives in lib/dutyWeekSlots so the grid layout
 * and the week-completion check share one definition of the 12 slots.
 */
export function DutyGrid({ startWeekDate }: DutyGridProps) {
  const { data: allDoctors, isLoading: doctorsLoading } = useDoctors(true);
  const { data: allAssignments, isLoading: dutyLoading } = useDuty();
  const createDuty = useCreateDuty();
  const deleteDuty = useDeleteDuty();

  const [activeDoctor, setActiveDoctor] = useState<DraggableDoctor | null>(null);

  const weekStartDates = useMemo(
    () => Array.from({ length: WEEK_COUNT }, (_, i) => addDays(startWeekDate, i * 7)),
    [startWeekDate],
  );

  // The full 4-week window's dates, so each DutyWeekTable can filter
  // down to just its own 6 dates without re-fetching or re-deriving
  // the window itself.
  const windowAssignments = useMemo(() => {
    const windowDates = new Set(weekStartDates.flatMap((ws) => buildColumns(ws).map((c) => c.date)));
    return (allAssignments ?? []).filter((a) => windowDates.has(a.date));
  }, [allAssignments, weekStartDates]);

  const doctorsById = useMemo(() => {
    const map = new Map<number, Doctor>();
    for (const d of allDoctors ?? []) map.set(d.id, d);
    return map;
  }, [allDoctors]);

  // Duty is restricted to Partner/Salaried doctors - Trainees and AHPs
  // are never eligible, per confirmed business rule. The existing
  // add-row form below still offers all four types; that inconsistency
  // is deliberate for now and will be resolved in a standalone step.
  const dutyEligibleDoctors = (allDoctors ?? []).filter(
    (d) => d.doctor_type === "Partner" || d.doctor_type === "Salaried",
  );
  const doctorGroups = groupDoctorsByType(dutyEligibleDoctors);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  if (doctorsLoading || dutyLoading) {
    return <p className="text-sm text-ink/70">Loading grid...</p>;
  }

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current as DraggableDoctor | undefined;
    if (data) setActiveDoctor(data);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDoctor(null);
    const active = event.active.data.current as DraggableDoctor | undefined;
    const over = event.over?.data.current as DutySlot | undefined;

    const outcome = resolveDutyDrop(active, over);
    if (!outcome || !active) return;

    if (outcome.existingAssignmentId !== null) {
      const existingCode = doctorsById.get(over?.assignment?.doctor_id ?? -1)?.code ?? "the current doctor";
      const confirmed = window.confirm(`Replace ${existingCode} with ${active.doctorCode} for this slot?`);
      if (!confirmed) return;

      deleteDuty.mutate(outcome.existingAssignmentId, {
        onSuccess: () => {
          createDuty.mutate({
            date: outcome.date,
            period: outcome.period,
            doctor_id: outcome.doctorId,
            duty_type: outcome.dutyType,
          });
        },
      });
      return;
    }

    createDuty.mutate({
      date: outcome.date,
      period: outcome.period,
      doctor_id: outcome.doctorId,
      duty_type: outcome.dutyType,
    });
  }

  function handleRemove(assignmentId: number) {
    deleteDuty.mutate(assignmentId);
  }

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="flex gap-6">
        <div className="w-40 shrink-0">
          <h2 className="text-sm font-medium text-ink/70">Doctors</h2>
          <div className="mt-2 space-y-3">
            {doctorGroups.map((group) => (
              <div key={group.type}>
                <div className="text-xs font-medium text-ink/50">{group.label}</div>
                <div className="mt-1 space-y-1">
                  {group.doctors.map((d) => (
                    <DraggableDoctorChip key={d.id} doctorId={d.id} doctorCode={d.code} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex-1 space-y-6">
          {weekStartDates.map((weekStartDate) => (
            <DutyWeekTable
              key={weekStartDate}
              weekStartDate={weekStartDate}
              assignments={windowAssignments}
              doctorsById={doctorsById}
              onRemove={handleRemove}
            />
          ))}
        </div>
      </div>

      <DragOverlay>{activeDoctor ? <ChipOverlayPreview doctorCode={activeDoctor.doctorCode} /> : null}</DragOverlay>
    </DndContext>
  );
}

interface DutyWeekTableProps {
  weekStartDate: string;
  /** Assignments for the whole 4-week window - findAssignment and
   * isDutyWeekComplete both match by exact date, so passing the full
   * window rather than a pre-filtered per-week slice is equally correct
   * and one less thing to keep in sync. */
  assignments: DutyAssignment[];
  doctorsById: Map<number, Doctor>;
  onRemove: (assignmentId: number) => void;
}

/** One week's 6-column x 2-period duty grid. Must be rendered inside an
 * ancestor DndContext - it has no DndContext of its own, since DutyGrid
 * shares one across all 4 weeks. */
function DutyWeekTable({ weekStartDate, assignments, doctorsById, onRemove }: DutyWeekTableProps) {
  const columns = useMemo(() => buildColumns(weekStartDate), [weekStartDate]);
  // Advisory display state only: slot-based check that all 12 of this
  // week's (date, period, duty_type) slots are assigned. The backend
  // Phase 0 hard block (next ticket) re-implements the same rule
  // server-side; nothing here enforces anything.
  const complete = useMemo(
    () => isDutyWeekComplete(weekStartDate, assignments),
    [weekStartDate, assignments],
  );

  return (
    <div data-testid={`duty-week-${weekStartDate}`}>
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-medium text-ink/70">{formatWeekLabel(weekStartDate)}</h3>
        {complete ? (
          <span
            data-testid={`duty-week-complete-${weekStartDate}`}
            className="rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-900"
          >
            Fully staffed
          </span>
        ) : null}
      </div>
      <div
        className="mt-1 grid gap-px border border-border bg-border text-sm"
        style={{ gridTemplateColumns: `3rem repeat(${columns.length}, minmax(3rem, 1fr))` }}
      >
        <div className="bg-background px-2 py-1" />
        {columns.map((col) => (
          <div key={col.key} className="bg-background px-2 py-1 text-center font-medium text-ink/70">
            {col.label}
          </div>
        ))}
        {PERIODS.map((period) => (
          <Fragment key={period}>
            <div className="bg-background px-2 py-1 font-medium text-ink/70">{period}</div>
            {columns.map((col) => {
              const assignment = findAssignment(assignments, col.date, period, col.dutyType);
              return (
                <DutyDropCell
                  key={col.key}
                  date={col.date}
                  period={period}
                  dutyType={col.dutyType}
                  assignment={assignment}
                  doctorCode={assignment ? doctorsById.get(assignment.doctor_id)?.code ?? "?" : null}
                  onRemove={onRemove}
                />
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function DraggableDoctorChip({ doctorId, doctorCode }: { doctorId: number; doctorCode: string }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `duty-doctor-${doctorId}`,
    data: { doctorId, doctorCode } satisfies DraggableDoctor,
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      data-testid={`duty-doctor-chip-${doctorId}`}
      className={`cursor-grab select-none rounded border border-border bg-surface px-2 py-1 text-xs font-medium ${isDragging ? "opacity-40" : ""}`}
    >
      {doctorCode}
    </div>
  );
}

interface DutyDropCellProps {
  date: string;
  period: Period;
  dutyType: DutyType;
  assignment: DutyAssignment | null;
  doctorCode: string | null;
  onRemove: (assignmentId: number) => void;
}

function DutyDropCell({ date, period, dutyType, assignment, doctorCode, onRemove }: DutyDropCellProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `duty-slot-${date}-${period}-${dutyType}`,
    data: { date, period, dutyType, assignment } satisfies DutySlot,
  });

  return (
    <div
      ref={setNodeRef}
      data-testid={`duty-cell-${date}-${period}-${dutyType}`}
      className={`px-2 py-1 text-center ${isOver ? "bg-accent/10" : "bg-white"}`}
    >
      {assignment ? (
        <button
          type="button"
          onClick={() => onRemove(assignment.id)}
          className="cursor-pointer select-none rounded bg-red-100 px-2 py-1 text-xs font-medium text-red-900"
        >
          {doctorCode}
        </button>
      ) : null}
    </div>
  );
}

function ChipOverlayPreview({ doctorCode }: { doctorCode: string }) {
  return (
    <div className="cursor-grabbing rounded border border-accent bg-surface px-2 py-1 text-xs font-medium shadow-lg">
      {doctorCode}
    </div>
  );
}