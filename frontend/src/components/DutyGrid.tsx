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

import { useCreateDuty, useDeleteDuty, useDuty, useDutyCounts } from "@/api/duty";
import { useClosures } from "@/api/closures";
import { useDoctors } from "@/api/doctors";
import type { Closure, Doctor, DutyAssignment, DutyType, Period } from "@/api/types";
import { addDays, DUTY_PERIOD_WEEKS, formatWeekLabel, getYearRange } from "@/lib/date";
import { isDutyWeekComplete } from "@/lib/dutyWeekComplete";
import { buildColumns } from "@/lib/dutyWeekSlots";
import { isSlotClosed, toClosedSlotSet } from "@/lib/closedSlots";
import { groupDoctorsByType } from "@/lib/groupDoctors";
import { type DraggableDoctor, type DutySlot, resolveDutyDrop } from "@/lib/resolveDutyDrop";
import { computeWeightedScore, formatWeightedScore } from "@/lib/weightedScore";

const PERIODS: Period[] = ["AM", "PM"];

function findAssignment(
  assignments: DutyAssignment[],
  date: string,
  period: Period,
  dutyType: DutyType,
): DutyAssignment | null {
  return assignments.find((a) => a.date === date && a.period === period && a.duty_type === dutyType) ?? null;
}

interface DutyGridProps {
  startWeekDate: string;
}

export function DutyGrid({ startWeekDate }: DutyGridProps) {
  const { data: allDoctors, isLoading: doctorsLoading } = useDoctors(true);
  const { data: allAssignments, isLoading: dutyLoading } = useDuty();
  // Counters are deliberately period-scoped, not all-time: the 4-weekly
  // duty periods feature removed the all-time view rather than moving it
  // (see lib/date.ts and the implementation plan's Design Decision 5).
  // The range is derived from the same startWeekDate and DUTY_PERIOD_WEEKS
  // the grid itself renders, so the counters can never drift out of step
  // with the weeks actually shown.
  const countsRange = useMemo(
    () => ({ from: startWeekDate, to: addDays(startWeekDate, DUTY_PERIOD_WEEKS * 7 - 1) }),
    [startWeekDate],
  );
  const { data: countsData, isLoading: countsLoading } = useDutyCounts(countsRange);
  // Annual counter: a second, independent range covering the calendar
  // year containing the selected period's start date (1 Jan - 31 Dec,
  // arbitrary cutoffs - user-confirmed). This shifts as the user
  // navigates periods, unlike the period-scoped counter's fixed 28-day
  // window. It is additive alongside the period counter, not a
  // reinstatement of the all-time view removed when 4-weekly periods
  // were introduced (see the comment above) - a fixed calendar year is
  // a different, bounded concept from an unbounded all-time count.
  const annualRange = useMemo(() => getYearRange(startWeekDate), [startWeekDate]);
  const { data: annualCountsData, isLoading: annualCountsLoading } = useDutyCounts(annualRange);
  const { data: closures } = useClosures();
  const createDuty = useCreateDuty();
  const deleteDuty = useDeleteDuty();

  const [activeDoctor, setActiveDoctor] = useState<DraggableDoctor | null>(null);

  const weekStartDates = useMemo(
    () => Array.from({ length: DUTY_PERIOD_WEEKS }, (_, i) => addDays(startWeekDate, i * 7)),
    [startWeekDate],
  );

  const windowAssignments = useMemo(() => {
    const windowDates = new Set(
      weekStartDates.flatMap((ws) => buildColumns(ws, closures ?? []).map((c) => c.date)),
    );
    return (allAssignments ?? []).filter((a) => windowDates.has(a.date));
  }, [allAssignments, weekStartDates, closures]);

  const doctorsById = useMemo(() => {
    const map = new Map<number, Doctor>();
    for (const d of allDoctors ?? []) map.set(d.id, d);
    return map;
  }, [allDoctors]);

  const countsById = useMemo(() => {
    const map = new Map<number, number>();
    for (const c of countsData ?? []) map.set(c.doctor_id, c.raw_count);
    return map;
  }, [countsData]);

  const annualCountsById = useMemo(() => {
    const map = new Map<number, number>();
    for (const c of annualCountsData ?? []) map.set(c.doctor_id, c.raw_count);
    return map;
  }, [annualCountsData]);

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
        <div className="w-80 shrink-0">
          <div className="flex items-end justify-between">
            <h2 className="text-sm font-medium text-ink/70">Doctors</h2>
            <div className="flex gap-3 text-xs text-ink/50">
              <span className="w-[4.5rem] text-center">Period</span>
              <span className="w-[4.5rem] text-center">Year</span>
            </div>
          </div>
          <div className="flex items-center justify-end gap-3 text-xs text-ink/50">
            <div className="flex gap-1">
              <span className="w-8 text-right">n</span>
              <span className="w-10 text-right">wtd</span>
            </div>
            <div className="flex gap-1">
              <span className="w-8 text-right">n</span>
              <span className="w-10 text-right">wtd</span>
            </div>
          </div>
          <div className="mt-2 space-y-3">
            {doctorGroups.map((group) => (
              <div key={group.type}>
                <div className="text-xs font-medium text-ink/50">{group.label}</div>
                <div className="mt-1 space-y-1">
                  {group.doctors.map((d) => {
                    const raw = countsLoading ? null : (countsById.get(d.id) ?? 0);
                    const doctor = doctorsById.get(d.id);
                    const wtd = raw === null ? null : formatWeightedScore(computeWeightedScore(raw, doctor));

                    const annualRaw = annualCountsLoading ? null : (annualCountsById.get(d.id) ?? 0);
                    const annualWtd =
                      annualRaw === null ? null : formatWeightedScore(computeWeightedScore(annualRaw, doctor));

                    return (
                      <div key={d.id} className="flex items-center gap-3">
                        <div className="flex-1">
                          <DraggableDoctorChip doctorId={d.id} doctorCode={d.code} />
                        </div>
                        <div className="flex gap-1">
                          <span
                            data-testid={`duty-period-raw-${d.id}`}
                            className="w-8 text-right text-xs tabular-nums text-ink/70"
                          >
                            {raw ?? "–"}
                          </span>
                          <span
                            data-testid={`duty-period-wtd-${d.id}`}
                            className="w-10 text-right text-xs tabular-nums text-ink/70"
                          >
                            {wtd ?? "–"}
                          </span>
                        </div>
                        <div className="flex gap-1">
                          <span
                            data-testid={`duty-annual-raw-${d.id}`}
                            className="w-8 text-right text-xs tabular-nums text-ink/70"
                          >
                            {annualRaw ?? "–"}
                          </span>
                          <span
                            data-testid={`duty-annual-wtd-${d.id}`}
                            className="w-10 text-right text-xs tabular-nums text-ink/70"
                          >
                            {annualWtd ?? "–"}
                          </span>
                        </div>
                      </div>
                    );
                  })}
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
              closures={closures ?? []}
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
  assignments: DutyAssignment[];
  closures: Closure[];
  doctorsById: Map<number, Doctor>;
  onRemove: (assignmentId: number) => void;
}

function DutyWeekTable({ weekStartDate, assignments, closures, doctorsById, onRemove }: DutyWeekTableProps) {
  const columns = useMemo(() => buildColumns(weekStartDate, closures), [weekStartDate, closures]);
  const closedSet = useMemo(() => toClosedSlotSet(closures), [closures]);
  const complete = useMemo(
    () => isDutyWeekComplete(weekStartDate, assignments, closures),
    [weekStartDate, assignments, closures],
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
          <div
            key={col.key}
            data-testid={`duty-column-header-${col.date}`}
            className={`px-2 py-1 text-center font-medium ${
              col.fullyClosed ? "bg-gray-200 text-ink/40" : "bg-background text-ink/70"
            }`}
          >
            {col.label}
            {col.fullyClosed ? <div className="text-[10px] font-normal">closed</div> : null}
          </div>
        ))}
        {PERIODS.map((period) => (
          <Fragment key={period}>
            <div className="bg-background px-2 py-1 font-medium text-ink/70">{period}</div>
            {columns.map((col) => {
              if (col.fullyClosed || isSlotClosed(closedSet, col.date, period)) {
                return (
                  <div
                    key={col.key}
                    data-testid={`duty-cell-closed-${col.date}-${period}`}
                    className="bg-gray-100 px-2 py-1"
                  />
                );
              }
              const dutyType = col.dutyType as DutyType;
              const assignment = findAssignment(assignments, col.date, period, dutyType);
              return (
                <DutyDropCell
                  key={col.key}
                  date={col.date}
                  period={period}
                  dutyType={dutyType}
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