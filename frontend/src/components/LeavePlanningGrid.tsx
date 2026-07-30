import type { Doctor, MasterSessionType, Period } from "@/api/types";
import { PlanningCellPopover } from "@/components/PlanningCellPopover";
import { closedSlotKey, isDayFullyClosed, isSlotClosed } from "@/lib/closedSlots";
import { formatHolidayRange, parseLocalDate } from "@/lib/date";
import {
  PLANNING_PERIODS,
  type PendingEdit,
  type PlanningCellState,
  type SchoolPlannerRow,
  isInMonth,
  isSurgerySession,
  isWithinWindow,
  mergeCellState,
  mergeNotes,
  planningCellKey,
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
 * edit for that key, computed at render - the component holds no state of
 * its own. Clicking opens `PlanningCellPopover`, a dropdown choosing one
 * of normal/leave/extra_session/blocked plus a free-text note; Apply
 * calls `onApply` with the picked state and note. Nothing here fires an
 * API call.
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
 * A "normal" cell (no leave, no extra session) is further split purely by
 * colour, not state: `isSurgerySession` (COUNTED_TYPES) decides whether it
 * reads as a working session (bright white) or a no-surgery one (medium
 * grey), against the doctor's week-1 template. This is cosmetic only - it
 * does not change `PlanningCellState` or anything the click cycle or the
 * coverage total does.
 */

const CELL_CLASSES: Record<PlanningCellState, string> = {
  normal: "bg-surface text-ink/30 hover:bg-accent/10",
  leave: "bg-green-500 text-white",
  extra_session: "bg-yellow-300 text-yellow-900",
  blocked: "bg-slate-500 text-white",
};

const NO_SURGERY_NORMAL_CLASS = "bg-gray-300 text-ink/40 hover:bg-accent/10";

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
  /** Fired when the cell popover's Apply button is pressed, with the
   * picked state and note - the popover itself is this component's
   * business, the page only records the result. */
  onApply: (
    doctorId: number,
    date: string,
    period: Period,
    state: PlanningCellState,
    notes: string,
  ) => void;
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
  onApply,
}: LeavePlanningGridProps) {
  if (doctors.length === 0) {
    return <p className="mt-4 text-sm text-ink/50">No partners, salaried doctors, or locums work this month.</p>;
  }

  return (
    <div>
      <div className="mt-4 overflow-x-auto rounded border-[3px] border-ink/40">
        <table className="min-w-full border-collapse text-sm">
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
            {doctors.map((doctor) => (
              <tr key={doctor.id}>
                <td className="sticky left-0 z-10 whitespace-nowrap border-b-2 border-r-[3px] border-ink/40 bg-background px-2 py-1 font-medium">
                  {doctor.code}
                </td>
                {dates.map((date) => (
                  <td
                    key={date}
                    className={`border-b-2 ${weekDividerClass(date)} border-ink/40 p-0.5 align-top ${
                      isInMonth(date, year, month) ? "" : "bg-ink/[0.03]"
                    }`}
                  >
                    {PLANNING_PERIODS.map((period) => (
                      <PlanningCellHalf
                        key={period}
                        doctor={doctor}
                        date={date}
                        period={period}
                        pending={pending}
                        leaveKeys={leaveKeys}
                        extraKeys={extraKeys}
                        blockedKeys={blockedKeys}
                        leaveNotes={leaveNotes}
                        extraNotes={extraNotes}
                        blockedNotes={blockedNotes}
                        closedSlots={closedSlots}
                        templateTypes={templateTypes}
                        onApply={onApply}
                      />
                    ))}
                  </td>
                ))}
              </tr>
            ))}
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
  pending: Map<string, PendingEdit>;
  leaveKeys: Set<string>;
  extraKeys: Set<string>;
  blockedKeys: Set<string>;
  leaveNotes: Map<string, string>;
  extraNotes: Map<string, string>;
  blockedNotes: Map<string, string>;
  closedSlots: Set<string>;
  templateTypes: Map<string, MasterSessionType>;
  onApply: (
    doctorId: number,
    date: string,
    period: Period,
    state: PlanningCellState,
    notes: string,
  ) => void;
}

function PlanningCellHalf({
  doctor,
  date,
  period,
  pending,
  leaveKeys,
  extraKeys,
  blockedKeys,
  leaveNotes,
  extraNotes,
  blockedNotes,
  closedSlots,
  templateTypes,
  onApply,
}: PlanningCellHalfProps) {
  const testId = `planning-cell-${doctor.id}-${date}-${period}`;
  const shared =
    "mt-0.5 block w-full truncate rounded-sm px-0.5 text-center text-[10px] leading-tight first:mt-0";

  if (isSlotClosed(closedSlots, date, period)) {
    return (
      <div
        data-testid={testId}
        data-state="closed"
        title={`${date} ${period} - practice closed`}
        className={`${shared} closed-hatch text-ink/40`}
      >
        {period}
      </div>
    );
  }

  if (!isWithinWindow(doctor, date)) {
    return (
      <div
        data-testid={testId}
        data-state="out_of_window"
        title={`${date} ${period} - ${doctor.code} is not employed on this date`}
        className={`${shared} bg-ink/5 text-ink/20`}
      >
        {period}
      </div>
    );
  }

  const key = planningCellKey(doctor.id, date, period);
  const pendingEdit = pending.get(key);
  const rows = serverRows(leaveKeys, extraKeys, blockedKeys, key);
  const state = mergeCellState(toCellState(rows), pendingEdit);
  const notes = mergeNotes(serverNotes(leaveNotes, extraNotes, blockedNotes, key), pendingEdit);

  const day = weekdayName(date);
  const templateType = day === null ? undefined : templateTypes.get(templateKey(doctor.id, day, period));
  const stateClass =
    state === "normal" && !isSurgerySession(templateType) ? NO_SURGERY_NORMAL_CLASS : CELL_CLASSES[state];

  return (
    <PlanningCellPopover
      state={state}
      notes={notes}
      onApply={(nextState, nextNotes) => onApply(doctor.id, date, period, nextState, nextNotes)}
    >
      <button
        type="button"
        data-testid={testId}
        data-state={state}
        data-notes={notes}
        data-pending={pendingEdit !== undefined ? "true" : "false"}
        title={`${doctor.code} ${date} ${period} - ${CELL_TITLES[state]}${notes ? `: ${notes}` : ""}`}
        aria-label={`${doctor.code} ${date} ${period}: ${CELL_TITLES[state]}${notes ? `, note ${notes}` : ""}`}
        className={`${shared} ${stateClass} ${
          pendingEdit !== undefined ? "ring-2 ring-inset ring-ink/60" : ""
        }`}
      >
        {notes || period}
      </button>
    </PlanningCellPopover>
  );
}
