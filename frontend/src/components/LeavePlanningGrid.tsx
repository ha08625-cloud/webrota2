import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, MutableRefObject } from "react";

import type { Doctor, MasterSessionType, Period } from "@/api/types";
import { useWriteGate } from "@/auth/AuthContext";
import { PlanningCellPopover } from "@/components/PlanningCellPopover";
import { closedSlotKey, isDayFullyClosed, isSlotClosed } from "@/lib/closedSlots";
import { formatHolidayRange, parseLocalDate } from "@/lib/date";
import {
  PLANNING_PERIODS,
  type PendingEdit,
  type PlanningCell,
  type PlanningCellRef,
  type PlanningCellState,
  type SchoolPlannerRow,
  isInMonth,
  isSurgerySession,
  isWithinWindow,
  mergeCellState,
  mergeNotes,
  planningCellKey,
  selectionCells,
  serverNotes,
  serverRows,
  templateKey,
  toCellState,
  weekdayName,
} from "@/lib/planningMonth";

/**
 * The month-at-a-time planning matrix: sticky doctor column, one column
 * per weekday date, AM and PM as split halves within each cell (the same
 * shape LeaveRangePreview uses for its mini-calendar).
 *
 * Every cell's appearance is the *merge* of server state and any pending
 * edit for that key, computed at render - no cell state is stored. What
 * *is* stored here is the transient selection: which half-cells a drag
 * (or a shift+click) currently covers, whether a drag is in progress, and
 * whether the editor is showing. None of that outlives the edit, and none
 * of it feeds a cell's appearance beyond the highlight.
 *
 * The range geometry itself is not here - `selectionCells` in
 * lib/planningMonth.ts owns it, so the highlight and the cells handed to
 * `onApply` cannot disagree. Selection is confined to one doctor's row
 * (no rectangles): entering another row mid-drag is ignored.
 *
 * There is exactly one `Popover.Root` for the whole grid, anchored at the
 * drag's focus cell, rather than one per cell. Per-cell triggers cannot
 * survive a drag: `Popover.Trigger` opens on `click`, and a `click` only
 * fires on the nearest common ancestor of mousedown/mouseup - so a drag
 * spanning two cells would produce no click and no popover, while a
 * single-cell press would produce one racing the programmatic open. It
 * also means a 20-doctor month mounts one Radix root instead of ~900.
 * Apply calls `onApply` with every editable selected cell, the picked
 * state and the note. Nothing here fires an API call.
 *
 * Two kinds of inert cell, deliberately given different treatments
 * because confusing them would mislead:
 *  - closed: the practice is shut, so Phase 2 creates no slot at all.
 *    Black-hatched (`.closed-hatch`, index.css) rather than a flat grey so
 *    it can't be mistaken for the "no surgery" grey, and the total shows
 *    "-" rather than 0 (Design Decision 5).
 *  - out of window: the doctor is not employed on that date. Plain absent
 *    grey - there is nothing to plan, but the practice is open.
 *
 * Separately from the drag selection, clicking a doctor's name in the
 * sticky left column *selects that doctor*: their row is tinted so it can
 * be followed to the right-hand edge of a wide month, and the page shows
 * their leave balance. That selection is owned by the page (it drives the
 * balance line too), lives across month changes, and never touches cell
 * state or what an edit writes.
 *
 * A "normal" cell (no leave, no extra session) is further split purely by
 * colour, not state: `isSurgerySession` (COUNTED_TYPES) decides whether it
 * reads as a working session (bright white) or a no-surgery one (medium
 * grey), against the doctor's week-1 template. This is cosmetic only - it
 * does not change `PlanningCellState` or anything the click cycle or the
 * coverage total does.
 */

/** Everything a cell's merged appearance is derived from, grouped so the
 * grid, its cells and the popover prefill all read it through one
 * function and cannot disagree about what a cell currently says. */
interface PlanningCellSources {
  pending: Map<string, PendingEdit>;
  leaveKeys: Set<string>;
  extraKeys: Set<string>;
  blockedKeys: Set<string>;
  leaveNotes: Map<string, string>;
  extraNotes: Map<string, string>;
  blockedNotes: Map<string, string>;
}

/** The state and note one cell shows right now: the pending edit if there
 * is one, the server rows underneath it otherwise. */
function mergedCell(
  sources: PlanningCellSources,
  key: string,
): { pendingEdit: PendingEdit | undefined; state: PlanningCellState; notes: string } {
  const pendingEdit = sources.pending.get(key);
  const rows = serverRows(sources.leaveKeys, sources.extraKeys, sources.blockedKeys, key);
  return {
    pendingEdit,
    state: mergeCellState(toCellState(rows), pendingEdit),
    notes: mergeNotes(
      serverNotes(sources.leaveNotes, sources.extraNotes, sources.blockedNotes, key),
      pendingEdit,
    ),
  };
}

/** A drag (or shift+click) in progress: two half-cell endpoints on one
 * doctor's row. `selectionCells` turns it into the cells themselves. */
interface GridSelection {
  doctorId: number;
  anchor: PlanningCellRef;
  focus: PlanningCellRef;
}

const CELL_CLASSES: Record<PlanningCellState, string> = {
  normal: "bg-surface text-ink/30 hover:bg-accent/10",
  leave: "bg-green-500 text-white",
  extra_session: "bg-yellow-300 text-yellow-900",
  blocked: "bg-slate-500 text-white",
};

const NO_SURGERY_NORMAL_CLASS = "bg-gray-300 text-ink/40 hover:bg-accent/10";

/** A working session on the selected doctor's row. The only cell class the
 * row highlight overrides: plain white cells are what break the band up,
 * and unlike leave/extra/blocked (and the no-surgery grey) white carries no
 * meaning of its own that a tint could be mistaken for. */
const ROW_SELECTED_NORMAL_CLASS = "bg-accent/20 text-ink/40 hover:bg-accent/30";

const CELL_TITLES: Record<PlanningCellState, string> = {
  normal: "Working as normal",
  leave: "On leave",
  extra_session: "Extra session planned",
  blocked: "Blocked (not available, not leave)",
};

const LEGEND: { state: PlanningCellState; label: string }[] = [
  { state: "leave", label: "Leave" },
  { state: "extra_session", label: "Extra planned" },
  { state: "blocked", label: "Blocked" },
];

/**
 * Visual weight for the Clinical cover total, flagging thin cover before it
 * becomes a problem rather than leaving every number the same plain grey.
 * Thresholds are user-specified, not derived from any per-slot minimum
 * stored in the data model - there isn't one. Null (closed) and undefined
 * (outside the fetched range) stay neutral: there is nothing to flag.
 */
function coverageClass(total: number | null | undefined): string {
  if (total === null || total === undefined) return "bg-surface text-ink/70";
  if (total <= 2) return "bg-red-200 text-red-900";
  if (total === 3) return "bg-orange-200 text-orange-900";
  if (total === 4) return "bg-yellow-200 text-yellow-900";
  return "bg-surface text-ink/70";
}

const COVERAGE_LEGEND = [
  { className: "bg-red-200", label: "0–2 covering" },
  { className: "bg-orange-200", label: "3 covering" },
  { className: "bg-yellow-200", label: "4 covering" },
];

/** Mon-Fri dates chunked into weeks of 5 - safe because `weekdaysInMonth`
 * only ever returns whole Monday-Friday weeks (it pads partial weeks at
 * the edges of the month out to a full 5, see its docstring). */
function chunkIntoWeeks(dates: string[]): string[][] {
  const weeks: string[][] = [];
  for (let i = 0; i < dates.length; i += 5) {
    weeks.push(dates.slice(i, i + 5));
  }
  return weeks;
}

/** Sum of AM + PM clinical cover across a whole week. Closed slots
 * contribute nothing (there is no headcount to add), matching the daily
 * row's "-" treatment; null only when every slot in the week is closed,
 * so there is nothing at all to add up. */
function weeklyTotal(weekDates: string[], totals: Map<string, number | null>): number | null {
  let sum = 0;
  let any = false;
  for (const date of weekDates) {
    for (const period of PLANNING_PERIODS) {
      const total = totals.get(closedSlotKey(date, period));
      if (total === undefined || total === null) continue;
      any = true;
      sum += total;
    }
  }
  return any ? sum : null;
}

/** "Mon" / "3" for a date column header. */
function columnLabel(date: string): { weekday: string; dayOfMonth: string } {
  return {
    weekday: parseLocalDate(date).toLocaleDateString("en-GB", { weekday: "short" }),
    dayOfMonth: String(Number(date.slice(8))),
  };
}

/** Heavier right-hand divider after Friday's column - the grid only ever
 * shows weekdays, so the next column after a Friday one is always the
 * following Monday, and this is the one boundary worth calling out as a
 * new working week rather than just the next day. */
function weekDividerClass(date: string): string {
  return weekdayName(date) === "Friday" ? "border-r-[3px]" : "border-r";
}

export interface LeavePlanningGridProps {
  /** Mon-Fri dates spanning the displayed month's full weeks, ascending -
   * includes lead-in/lead-out days borrowed from the adjacent month. */
  dates: string[];
  /** The displayed month, used to dim dates borrowed from an adjacent
   * month via `isInMonth`. */
  year: number;
  month: number;
  /** Rows, already filtered to Partner/Salaried/Locum and ordered canonically. */
  doctors: Doctor[];
  /** Informational rows, one per school with a holiday in view (Design
   * Decision 9) - rendered above the doctor rows, not editable. */
  schoolRows: SchoolPlannerRow[];
  /** Unsaved edits, keyed by `planningCellKey`. */
  pending: Map<string, PendingEdit>;
  /** Existing LeaveEntry / ExtraSessionEntry / BlockedEntry keys, same key shape. */
  leaveKeys: Set<string>;
  extraKeys: Set<string>;
  blockedKeys: Set<string>;
  /** (doctor, date, period) -> notes, one map per entry type, same key
   * shape as the *Keys sets above. */
  leaveNotes: Map<string, string>;
  extraNotes: Map<string, string>;
  blockedNotes: Map<string, string>;
  /** Closed (date, period) slots, keyed by `closedSlotKey`. */
  closedSlots: Set<string>;
  /** Total row: `closedSlotKey` -> headcount, null when closed. */
  totals: Map<string, number | null>;
  /** Active template's week-1 (doctor, day, period) -> session type, from
   * `buildTemplateIndex`. Used only to colour normal cells (see the module
   * docstring) - has no bearing on state or the coverage total. */
  templateTypes: Map<string, MasterSessionType>;
  /** The doctor whose row is highlighted, or null for none. Purely a
   * reading aid (and the page's cue for whose leave balance to show) - it
   * has no bearing on what a cell says or on what an edit writes. */
  selectedDoctorId: number | null;
  /** Fired when a doctor's name in the left column is clicked. The page
   * owns the toggle so it can clear the balance line at the same time. */
  onSelectDoctor: (doctorId: number) => void;
  /** Fired when the cell popover's Apply button is pressed, with every
   * editable cell in the selection (one for a plain click) plus the
   * picked state and note - the popover and the selection are this
   * component's business, the page only records the result. Closed and
   * out-of-window cells are filtered out here rather than posted and
   * skipped server-side. */
  onApply: (cells: PlanningCell[], state: PlanningCellState, notes: string) => void;
}

export function LeavePlanningGrid({
  dates,
  year,
  month,
  doctors,
  schoolRows,
  pending,
  leaveKeys,
  extraKeys,
  blockedKeys,
  leaveNotes,
  extraNotes,
  blockedNotes,
  closedSlots,
  totals,
  templateTypes,
  selectedDoctorId,
  onSelectDoctor,
  onApply,
}: LeavePlanningGridProps) {
  const writeGate = useWriteGate();
  const [selection, setSelection] = useState<GridSelection | null>(null);
  const [dragging, setDragging] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  // The DOM node the popover is anchored at, and the one focus returns to
  // when it closes. Deliberately never nulled when the selection clears:
  // Radix asks for the focus target *after* that state update has already
  // detached the ref, and the button itself is still on screen.
  const focusCellRef = useRef<HTMLElement | null>(null);

  // On window rather than the grid, so releasing over the legend, the nav,
  // or outside the window still ends the drag. Releasing outside still
  // opens the editor - the selection is well defined either way, and
  // silently discarding a drag is worse.
  useEffect(() => {
    if (!dragging) return;
    function handleUp() {
      setDragging(false);
      setPopoverOpen(true);
    }
    window.addEventListener("mouseup", handleUp);
    return () => window.removeEventListener("mouseup", handleUp);
  }, [dragging]);

  // Every hook is above this early return: React would otherwise see a
  // different hook count on the empty-doctor render.
  if (doctors.length === 0) {
    return <p className="mt-4 text-sm text-ink/50">No partners, salaried doctors, or locums work this month.</p>;
  }

  const sources: PlanningCellSources = {
    pending,
    leaveKeys,
    extraKeys,
    blockedKeys,
    leaveNotes,
    extraNotes,
    blockedNotes,
  };

  const selectedCells = selection
    ? selectionCells(dates, selection.doctorId, selection.anchor, selection.focus)
    : [];
  const selectedKeys = new Set(
    selectedCells.map((cell) => planningCellKey(cell.doctorId, cell.date, cell.period)),
  );

  // A drag may run through closed slots and dates the doctor is not
  // employed on - you can drag across a bank holiday - but those are not
  // written. Letting them reach the bulk endpoint would come back as
  // `outside_doctor_dates` skips, putting "N skipped (doctor not employed
  // on that date)" on the save summary of every range spanning a leaver's
  // end date.
  const selectedDoctor = selection
    ? doctors.find((doctor) => doctor.id === selection.doctorId)
    : undefined;
  const editableCells =
    selectedDoctor === undefined
      ? []
      : selectedCells.filter(
          (cell) =>
            !isSlotClosed(closedSlots, cell.date, cell.period) &&
            isWithinWindow(selectedDoctor, cell.date),
        );

  // A selection whose cells all say the same thing prefills with it;
  // anything mixed falls back to leave. A single cell trivially counts as
  // uniform, so clicking an existing blocked cell still opens showing
  // "Blocked" and its note - the only way to see or clear what a cell is.
  const editableValues = editableCells.map((cell) =>
    mergedCell(sources, planningCellKey(cell.doctorId, cell.date, cell.period)),
  );
  const firstValue = editableValues[0];
  const uniform =
    firstValue !== undefined &&
    editableValues.every(
      (value) => value.state === firstValue.state && value.notes === firstValue.notes,
    );
  const prefillState: PlanningCellState = uniform ? firstValue.state : "leave";
  const prefillNotes = uniform ? firstValue.notes : "";

  function handleCellMouseDown(
    doctorId: number,
    date: string,
    period: Period,
    event: MouseEvent,
  ) {
    // No selection at all for a read-only user: everything the editor
    // could then do is a write (role-based auth, Task 3).
    if (event.button !== 0 || writeGate.disabled) return;
    // Stops the browser's own text-selection drag from fighting ours.
    event.preventDefault();

    if (event.shiftKey && selection !== null && selection.doctorId === doctorId) {
      setSelection({ ...selection, focus: { date, period } });
      setDragging(false);
      setPopoverOpen(true);
      return;
    }

    setSelection({ doctorId, anchor: { date, period }, focus: { date, period } });
    setDragging(true);
    setPopoverOpen(false);
  }

  function handleCellMouseEnter(doctorId: number, date: string, period: Period) {
    // Confines the drag to one row: entering another doctor's row is
    // ignored and the selection stays at its last valid endpoint.
    if (!dragging || selection === null || selection.doctorId !== doctorId) return;
    setSelection({ ...selection, focus: { date, period } });
  }

  function handleCellKeyDown(
    doctorId: number,
    date: string,
    period: Period,
    event: KeyboardEvent,
  ) {
    if ((event.key !== "Enter" && event.key !== " ") || writeGate.disabled) return;
    event.preventDefault();
    setSelection({ doctorId, anchor: { date, period }, focus: { date, period } });
    setDragging(false);
    setPopoverOpen(true);
  }

  function handlePopoverOpenChange(next: boolean) {
    setPopoverOpen(next);
    // Escape and click-away both abandon the selection without applying.
    if (!next) setSelection(null);
  }

  function handleApply(state: PlanningCellState, notes: string) {
    // Defensive: a drag always starts on an editable cell, so the only
    // way to get here empty is the world changing under a live selection
    // (a refetch closing the day, a month change dropping the doctor).
    // Reporting no cells at all beats reporting a cell we won't write.
    if (editableCells.length > 0) onApply(editableCells, state, notes);
    setPopoverOpen(false);
    setSelection(null);
  }

  return (
    <div>
      <Popover.Root open={popoverOpen} onOpenChange={handlePopoverOpenChange}>
        <Popover.Anchor virtualRef={focusCellRef} />
        <div className="mt-4 overflow-x-auto rounded border-[3px] border-ink/40">
          <table className={`min-w-full border-collapse text-sm ${dragging ? "select-none" : ""}`}>
            <thead>
              <tr>
                <th className="sticky left-0 z-10 w-24 border-b-[3px] border-r-[3px] border-ink/40 bg-background px-2 py-1 text-left font-medium text-ink/70">
                  Doctor / School
                </th>
                {dates.map((date) => {
                  const { weekday, dayOfMonth } = columnLabel(date);
                  const fullyClosed = isDayFullyClosed(closedSlots, date);
                  const outOfMonth = !isInMonth(date, year, month);
                  return (
                    <th
                      key={date}
                      data-testid={`planning-header-${date}`}
                      data-out-of-month={outOfMonth ? "true" : "false"}
                      className={`border-b-[3px] ${weekDividerClass(date)} border-ink/40 px-1 py-1 text-center font-medium ${
                        fullyClosed ? "closed-hatch text-ink/40" : outOfMonth ? "text-ink/40" : "text-ink/70"
                      }`}
                    >
                      <div className="text-[10px] font-normal">{weekday}</div>
                      <div>{dayOfMonth}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            {schoolRows.length > 0 ? (
              <tbody>
                {schoolRows.map((school) => (
                  <tr key={`school-${school.id}`}>
                    <td
                      data-testid={`planning-school-label-${school.id}`}
                      className="sticky left-0 z-10 whitespace-nowrap border-b border-r-[3px] border-ink/40 bg-background px-2 py-1 font-medium"
                    >
                      {school.name}
                    </td>
                    {dates.map((date) => {
                      const holiday = school.dates.get(date);
                      const outOfMonth = !isInMonth(date, year, month);
                      return (
                        <td
                          key={date}
                          data-testid={`planning-school-cell-${school.id}-${date}`}
                          data-state={holiday ? "school_holiday" : "normal"}
                          title={holiday ? `${school.name}: ${formatHolidayRange(holiday.start_date, holiday.end_date)}` : undefined}
                          className={`h-6 border-b ${weekDividerClass(date)} border-ink/40 ${
                            holiday ? "bg-indigo-200" : outOfMonth ? "bg-ink/[0.03]" : ""
                          }`}
                        />
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            ) : null}
            <tbody>
              {doctors.map((doctor) => {
                // Tints the cell padding rather than the cells themselves,
                // so the row reads as a band without repainting any cell
                // state - a leave cell must stay unmistakably green.
                const rowSelected = doctor.id === selectedDoctorId;
                return (
                <tr key={doctor.id} data-testid={`planning-row-${doctor.id}`} data-row-selected={rowSelected ? "true" : "false"}>
                  {/* The tint sits on the button, not this cell: the cell
                      is the sticky column, so a translucent background on
                      it would let scrolled cells show through it. */}
                  <td className="sticky left-0 z-10 whitespace-nowrap border-b-2 border-r-[3px] border-ink/40 bg-background p-0 font-medium">
                    <button
                      type="button"
                      data-testid={`planning-doctor-label-${doctor.id}`}
                      aria-pressed={rowSelected}
                      title={`Highlight ${doctor.code}'s row and show their leave balance`}
                      onClick={() => onSelectDoctor(doctor.id)}
                      className={`block w-full px-2 py-1 text-left hover:underline ${
                        rowSelected ? "bg-accent/30" : ""
                      }`}
                    >
                      {doctor.code}
                    </button>
                  </td>
                  {dates.map((date) => (
                    <td
                      key={date}
                      className={`border-b-2 ${weekDividerClass(date)} border-ink/40 p-0.5 align-top ${
                        rowSelected
                          ? "bg-accent/20"
                          : isInMonth(date, year, month)
                            ? ""
                            : "bg-ink/[0.03]"
                      }`}
                    >
                      {PLANNING_PERIODS.map((period) => (
                        <PlanningCellHalf
                          key={period}
                          doctor={doctor}
                          date={date}
                          period={period}
                          sources={sources}
                          closedSlots={closedSlots}
                          templateTypes={templateTypes}
                          selected={selectedKeys.has(planningCellKey(doctor.id, date, period))}
                          rowSelected={rowSelected}
                          isFocus={
                            selection !== null &&
                            selection.doctorId === doctor.id &&
                            selection.focus.date === date &&
                            selection.focus.period === period
                          }
                          focusCellRef={focusCellRef}
                          onCellMouseDown={handleCellMouseDown}
                          onCellMouseEnter={handleCellMouseEnter}
                          onCellKeyDown={handleCellKeyDown}
                        />
                      ))}
                    </td>
                  ))}
                </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td className="sticky left-0 z-10 whitespace-nowrap border-r-[3px] border-t-[3px] border-ink/40 bg-background px-2 py-1 text-xs font-medium text-ink/70">
                  Clinical cover
                </td>
                {dates.map((date) => (
                  <td
                    key={date}
                    className={`${weekDividerClass(date)} border-t-[3px] border-ink/40 p-0.5 align-top ${
                      isInMonth(date, year, month) ? "bg-background" : "bg-ink/[0.03]"
                    }`}
                  >
                    {PLANNING_PERIODS.map((period) => {
                      const total = totals.get(closedSlotKey(date, period));
                      return (
                        <div
                          key={period}
                          data-testid={`planning-total-${date}-${period}`}
                          title={`${date} ${period}`}
                          className={`mt-0.5 rounded-sm text-center text-[11px] leading-tight tabular-nums first:mt-0 ${coverageClass(total)}`}
                        >
                          {total === undefined || total === null ? "—" : total}
                        </div>
                      );
                    })}
                  </td>
                ))}
              </tr>
              <tr>
                <td className="sticky left-0 z-10 whitespace-nowrap border-r-[3px] border-t border-ink/40 bg-background px-2 py-1 text-xs font-medium text-ink/70">
                  Weekly cover
                </td>
                {chunkIntoWeeks(dates).map((weekDates) => {
                  const total = weeklyTotal(weekDates, totals);
                  return (
                    <td
                      key={weekDates[0]}
                      colSpan={weekDates.length}
                      data-testid={`planning-weekly-total-${weekDates[0]}`}
                      className="border-r-[3px] border-t border-ink/40 bg-background p-0.5 text-center text-[11px] font-medium leading-tight tabular-nums text-ink/70"
                    >
                      {total === null ? "—" : total}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          </table>
        </div>

        <PlanningCellPopover
          open={popoverOpen}
          onOpenChange={handlePopoverOpenChange}
          state={prefillState}
          notes={prefillNotes}
          cellCount={editableCells.length}
          onCloseAutoFocus={(event) => {
            // No trigger means Radix has nothing to return focus to, and
            // would otherwise drop a keyboard user at the top of the page.
            event.preventDefault();
            focusCellRef.current?.focus();
          }}
          onApply={handleApply}
        />
      </Popover.Root>

      <div className="mt-2 flex flex-wrap gap-3">
        {LEGEND.map((item) => (
          <span key={item.state} className="flex items-center gap-1 text-xs text-ink/60">
            <span className={`inline-block h-3 w-3 rounded-sm ${CELL_CLASSES[item.state]}`} />
            {item.label}
          </span>
        ))}
        <span className="flex items-center gap-1 text-xs text-ink/60">
          <span className="inline-block h-3 w-3 rounded-sm bg-gray-300" />
          No surgery
        </span>
        <span className="flex items-center gap-1 text-xs text-ink/60">
          <span className="closed-hatch inline-block h-3 w-3 rounded-sm border border-ink/20" />
          Practice closed
        </span>
        <span className="flex items-center gap-1 text-xs text-ink/60">
          <span className="inline-block h-3 w-3 rounded-sm bg-ink/5" />
          Not employed
        </span>
        <span className="flex items-center gap-1 text-xs text-ink/60">
          <span className="inline-block h-3 w-3 rounded-sm bg-indigo-200" />
          School holiday
        </span>
      </div>

      <p className="mt-1 text-xs text-ink/50">
        Drag across a row, or shift+click, to set a range. Click a doctor's name to highlight
        their row and see their leave balance.
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <span className="text-xs text-ink/60">Clinical cover:</span>
        {COVERAGE_LEGEND.map((item) => (
          <span key={item.label} className="flex items-center gap-1 text-xs text-ink/60">
            <span className={`inline-block h-3 w-3 rounded-sm ${item.className}`} />
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}

interface PlanningCellHalfProps {
  doctor: Doctor;
  date: string;
  period: Period;
  sources: PlanningCellSources;
  closedSlots: Set<string>;
  templateTypes: Map<string, MasterSessionType>;
  /** In the current drag selection - highlighted even when inert. */
  selected: boolean;
  /** This doctor's row is the highlighted one. Tints working sessions so
   * the band stays followable to the right edge; see
   * ROW_SELECTED_NORMAL_CLASS. */
  rowSelected: boolean;
  /** The selection's moving endpoint: what the popover anchors at, and
   * what focus returns to when it closes. */
  isFocus: boolean;
  focusCellRef: MutableRefObject<HTMLElement | null>;
  onCellMouseDown: (
    doctorId: number,
    date: string,
    period: Period,
    event: MouseEvent,
  ) => void;
  onCellMouseEnter: (doctorId: number, date: string, period: Period) => void;
  onCellKeyDown: (
    doctorId: number,
    date: string,
    period: Period,
    event: KeyboardEvent,
  ) => void;
}

function PlanningCellHalf({
  doctor,
  date,
  period,
  sources,
  closedSlots,
  templateTypes,
  selected,
  rowSelected,
  isFocus,
  focusCellRef,
  onCellMouseDown,
  onCellMouseEnter,
  onCellKeyDown,
}: PlanningCellHalfProps) {
  const testId = `planning-cell-${doctor.id}-${date}-${period}`;
  const shared =
    "mt-0.5 block w-full truncate rounded-sm px-0.5 text-center text-[10px] leading-tight first:mt-0";
  // A different CSS property from the pending `ring` below, so a cell that
  // is both selected and pending shows both.
  const selectedClass = selected ? "outline outline-2 -outline-offset-2 outline-accent" : "";
  // Never cleared once set, so the focus target survives the state update
  // that clears the selection - see focusCellRef in LeavePlanningGrid.
  const anchorRef = (node: HTMLElement | null) => {
    if (isFocus && node) focusCellRef.current = node;
  };

  // Both inert branches still take part in extending a drag - you can drag
  // through a bank holiday or past a leaver's end date - but they never
  // start one, and they are filtered out of what Apply writes.
  if (isSlotClosed(closedSlots, date, period)) {
    return (
      <div
        ref={anchorRef}
        data-testid={testId}
        data-state="closed"
        data-selected={selected ? "true" : "false"}
        title={`${date} ${period} - practice closed`}
        onMouseEnter={() => onCellMouseEnter(doctor.id, date, period)}
        className={`${shared} closed-hatch text-ink/40 ${selectedClass}`}
      >
        {period}
      </div>
    );
  }

  if (!isWithinWindow(doctor, date)) {
    return (
      <div
        ref={anchorRef}
        data-testid={testId}
        data-state="out_of_window"
        data-selected={selected ? "true" : "false"}
        title={`${date} ${period} - ${doctor.code} is not employed on this date`}
        onMouseEnter={() => onCellMouseEnter(doctor.id, date, period)}
        className={`${shared} bg-ink/5 text-ink/20 ${selectedClass}`}
      >
        {period}
      </div>
    );
  }

  const key = planningCellKey(doctor.id, date, period);
  const { pendingEdit, state, notes } = mergedCell(sources, key);

  const day = weekdayName(date);
  const templateType = day === null ? undefined : templateTypes.get(templateKey(doctor.id, day, period));
  const normalClass = !isSurgerySession(templateType)
    ? NO_SURGERY_NORMAL_CLASS
    : rowSelected
      ? ROW_SELECTED_NORMAL_CLASS
      : CELL_CLASSES.normal;
  const stateClass = state === "normal" ? normalClass : CELL_CLASSES[state];

  return (
    <button
      ref={anchorRef}
      type="button"
      data-testid={testId}
      data-state={state}
      data-notes={notes}
      data-pending={pendingEdit !== undefined ? "true" : "false"}
      data-selected={selected ? "true" : "false"}
      title={`${doctor.code} ${date} ${period} - ${CELL_TITLES[state]}${notes ? `: ${notes}` : ""}`}
      aria-label={`${doctor.code} ${date} ${period}: ${CELL_TITLES[state]}${notes ? `, note ${notes}` : ""}`}
      onMouseDown={(event) => onCellMouseDown(doctor.id, date, period, event)}
      onMouseEnter={() => onCellMouseEnter(doctor.id, date, period)}
      onKeyDown={(event) => onCellKeyDown(doctor.id, date, period, event)}
      className={`${shared} ${stateClass} ${
        pendingEdit !== undefined ? "ring-2 ring-inset ring-ink/60" : ""
      } ${selectedClass}`}
    >
      {notes || period}
    </button>
  );
}
