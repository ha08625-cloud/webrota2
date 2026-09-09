import { useEffect, useMemo, useState, type MouseEvent } from "react";

import type { ReceptionRole, ReceptionStaff, ValidationIssue } from "@/api/types";
import { useWriteGate } from "@/auth/AuthContext";
import { ReceptionCellPopover } from "@/components/ReceptionCellPopover";
import { formatHour, formatHourStart, RECEPTION_HOURS } from "@/lib/receptionHours";
import {
  getReceptionCell,
  pivotReception,
  withPendingReceptionWrite,
  type PendingReceptionWrite,
  type ReceptionCellData,
} from "@/lib/pivotReception";
import { receptionRunContinuations } from "@/lib/receptionRuns";
import {
  RECEPTION_ROLE_COLOURS,
  RECEPTION_ROLE_LABELS,
  RECEPTION_ROLE_ORDER,
} from "@/lib/receptionRoles";

export interface ReceptionSavePayload<T extends ReceptionCellData> {
  staffId: number;
  hour: number;
  /** The cell's current session, or null when saving into an absent cell (create). */
  session: T | null;
  role: ReceptionRole;
  note: string | null;
}

/** A staff row's shift-click range, `anchorHour === focusHour` for a plain single-cell click. */
interface ReceptionSelection {
  staffId: number;
  anchorHour: number;
  focusHour: number;
}

/** The hours between anchor and focus (inclusive, ascending), or [] when the selection is absent or on another row. */
export function selectedRangeHours(selection: ReceptionSelection | null, staffId: number): number[] {
  if (selection === null || selection.staffId !== staffId) return [];
  const lo = Math.min(selection.anchorHour, selection.focusHour);
  const hi = Math.max(selection.anchorHour, selection.focusHour);
  return RECEPTION_HOURS.filter((hour) => hour >= lo && hour <= hi);
}

interface ReceptionGridProps<T extends ReceptionCellData> {
  staff: ReceptionStaff[];
  sessions: T[];
  /**
   * Coverage shortfall warnings, one per (day, hour) below its rule's
   * minimum - absent on the master template page (a pattern has no
   * headcount to fall short of), present on the day rota page (Task 8).
   * Matched to a column by message prefix: compute_coverage_issues
   * (backend/app/api/routers/reception_rota.py) puts formatHour(hour) at
   * the start of every message for exactly this purpose - there is no
   * `hour` field on ValidationIssue to key off instead, since it's the
   * same shape the clinical rota's week/day/period issues use.
   */
  issues?: ValidationIssue[];
  /**
   * Staff ids with whole-day leave for the day being shown - absent on the
   * master template page (a weekly pattern has no dates to be away on),
   * present on the day rota page. Their sessions are still rendered and
   * still editable: leave excludes them from the coverage headcount and
   * nothing else, so the row is dimmed and labelled rather than removed.
   * Without the dimming a coverage warning would report fewer staff on
   * phones than the user can count in the column, which reads as a bug in
   * the arithmetic rather than as leave working.
   */
  staffOnLeave?: number[];
  /** Ascending by hour. Resolves true only if every write succeeded (shift-click range select). */
  onSave: (payloads: ReceptionSavePayload<T>[]) => Promise<boolean>;
  /** Only cells in the range that actually have a session. Resolves true if all succeeded. */
  onDelete: (sessions: T[]) => Promise<boolean>;
  saving: boolean;
}

/**
 * Staff x hour grid for one day - the weekday template (Task 7) or a
 * generated day (Task 8), unchanged between the two. Sibling of
 * MasterRotaGrid/RotaGrid, not a generalisation of either: the axes
 * differ (staff x hour here vs doctor x day/period there), reception has
 * no displacement/steal concept, and there is no draft/committed or
 * leave-derived inert state. Forcing a shared abstraction across the two
 * grids would make both harder to read, so this is deliberate
 * duplication - do not "fix" it by merging them later.
 *
 * Takes its data and callbacks as props and owns no query/mutation hooks
 * itself (unlike MasterRotaGrid, which queries doctors/rooms directly) -
 * that is what lets the day rota page reuse this component unchanged
 * against ReceptionRotaSession[] and its own set of mutations, rather
 * than needing a second copy wired to different endpoints.
 */
export function ReceptionGrid<T extends ReceptionCellData>({
  staff,
  sessions,
  issues,
  staffOnLeave,
  onSave,
  onDelete,
  saving,
}: ReceptionGridProps<T>) {
  const writeGate = useWriteGate();
  const grid = useMemo(() => pivotReception(sessions, staff), [sessions, staff]);
  const issuesByHour = useMemo(() => groupIssuesByHour(issues ?? []), [issues]);
  const onLeaveIds = useMemo(() => new Set(staffOnLeave ?? []), [staffOnLeave]);
  const [selection, setSelection] = useState<ReceptionSelection | null>(null);
  /**
   * The range edit currently being written, if any. `grid` is the truth -
   * it is what the save/delete payloads are composed from, and it gains
   * the edit one hour at a time as the page's sequential writes land -
   * while `displayGrid` shows the finished result from the moment the user
   * hits Save, so the run merges (or unmerges) in one step rather than
   * animating across the row. See withPendingReceptionWrite.
   */
  const [pending, setPending] = useState<PendingReceptionWrite | null>(null);
  const displayGrid = useMemo(() => withPendingReceptionWrite(grid, pending), [grid, pending]);
  /**
   * Roles the legend keys, read off `displayGrid` rather than the `sessions`
   * prop so an in-flight range edit drops (or adds) its colour from the key at
   * the same moment the bars change, instead of a beat later when the page's
   * query settles.
   */
  const legendRoles = useMemo(() => {
    const present = new Set<ReceptionRole>();
    for (const { staff: member } of displayGrid.rows) {
      for (const hour of RECEPTION_HOURS) {
        const cell = getReceptionCell(displayGrid, member.id, hour);
        if (cell) present.add(cell.role);
      }
    }
    return RECEPTION_ROLE_ORDER.filter((role) => present.has(role));
  }, [displayGrid]);

  useEffect(() => {
    if (selection === null) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setSelection(null);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selection]);

  /**
   * The cell click handler lives on the `<td>` so that it covers both the
   * filled-cell content and the empty-cell `+` button by bubbling. That
   * makes it sensitive to where React bubbles events *from*: the open
   * popover renders through a portal into document.body, but React's
   * synthetic events bubble along the component tree, not the DOM tree, so
   * every click inside the popover - the role dropdown especially - arrives
   * here as if it were a click on the cell, collapsing the shift-click
   * range back to the focus cell before Save ever fires.
   *
   * Hence the containment check: a cell click is a click that physically
   * happened inside the cell. Guarding here rather than stopping
   * propagation inside the popover keeps the rule in the one place that
   * knows it, and covers any portalled surface a cell might grow later.
   */
  function handleCellClick(e: MouseEvent<HTMLTableCellElement>, staffId: number, hour: number) {
    if (!e.currentTarget.contains(e.target as Node)) return;
    setSelection((prev) =>
      e.shiftKey && prev !== null && prev.staffId === staffId
        ? { ...prev, focusHour: hour }
        : { staffId, anchorHour: hour, focusHour: hour },
    );
  }

  async function handleSave(staffId: number, hours: number[], role: ReceptionRole, note: string | null) {
    const payloads = hours.map((hour) => ({
      staffId,
      hour,
      session: getReceptionCell(grid, staffId, hour) ?? null,
      role,
      note,
    }));
    setPending({ staffId, hours, write: { role, note } });
    try {
      if (await onSave(payloads)) setSelection(null);
    } finally {
      setPending(null);
    }
  }

  async function handleDelete(staffId: number, hours: number[]) {
    const sessionsInRange = hours
      .map((hour) => getReceptionCell(grid, staffId, hour))
      .filter((session): session is T => session !== undefined);
    setPending({ staffId, hours, write: null });
    try {
      if (await onDelete(sessionsInRange)) setSelection(null);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="min-w-0 flex-1">
      <div className="overflow-auto rounded-lg border border-border bg-surface shadow-sm">
        <table className="min-w-full table-fixed border-collapse text-sm">
          <thead>
            <tr>
              <th
                scope="col"
                className={`sticky left-0 top-0 z-40 w-32 bg-surface px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-ink/50 ${HEADER_RULE} ${STICKY_COLUMN_SHADOW}`}
              >
                Staff
              </th>
              {RECEPTION_HOURS.map((hour) => {
                const hourIssues = issuesByHour.get(hour) ?? [];
                // Whole hours are the scan anchors; the :30 ticks between them
                // are dimmed so the eye can find "11:00" without reading every
                // column.
                const onTheHour = Number.isInteger(hour);
                return (
                  <th
                    key={hour}
                    scope="col"
                    title={formatHour(hour)}
                    className={`sticky top-0 z-20 whitespace-nowrap bg-surface px-1 py-2 text-center text-xs font-medium tabular-nums ${HEADER_RULE} ${
                      onTheHour ? "text-ink/70" : "text-ink/35"
                    }`}
                  >
                    <div className="flex items-center justify-center gap-0.5">
                      <span>{formatHourStart(hour)}</span>
                      {hourIssues.length > 0 ? (
                        <span
                          title={hourIssues.map((issue) => issue.message).join("\n")}
                          aria-label={`Coverage shortfall at ${formatHour(hour)}`}
                          className="text-amber-500"
                        >
                          &#9888;
                        </span>
                      ) : null}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {displayGrid.rows.map(({ staff: member, inactiveWithSessions }, rowIndex) => {
              // on an inactive row, a range only ever covers hours that already have a session - no new rows
              // get created for a leaver.
              const memberRange = selectedRangeHours(selection, member.id).filter(
                (hour) => member.active || getReceptionCell(displayGrid, member.id, hour) !== undefined,
              );
              const rowCells = RECEPTION_HOURS.map((hour) => getReceptionCell(displayGrid, member.id, hour));
              const continuations = receptionRunContinuations(rowCells);
              const onLeave = onLeaveIds.has(member.id);
              // Dimming only - the cells stay clickable, since an admin may
              // still want to delete or retag a slot on a day someone is off.
              const onLeaveClassName = onLeave ? "opacity-50" : "";
              // The last row's own rule would sit a pixel inside the container's
              // rounded border and read as a double line.
              const rowRule = rowIndex === displayGrid.rows.length - 1 ? "" : "border-b border-border";
              return (
                <tr key={member.id} data-on-leave={onLeave ? "true" : undefined} className="hover:bg-ink/[0.02]">
                  <td
                    className={`sticky left-0 z-30 w-32 whitespace-nowrap bg-surface px-3 py-1.5 align-middle font-medium ${rowRule} ${STICKY_COLUMN_SHADOW} ${onLeaveClassName}`}
                  >
                    <div>{member.code}</div>
                    {inactiveWithSessions ? <div className="text-xs font-normal text-ink/50">(inactive)</div> : null}
                    {onLeave ? <div className="text-xs font-normal text-ink/50">On leave</div> : null}
                  </td>
                  {RECEPTION_HOURS.map((hour, hourIndex) => {
                    const session = rowCells[hourIndex];
                    const interactive = session !== undefined || member.active;
                    const isSelected = interactive && memberRange.includes(hour);
                    const isFocusCell =
                      selection !== null && selection.staffId === member.id && selection.focusHour === hour;
                    const hours = isFocusCell && memberRange.length > 1 ? memberRange : [hour];
                    const seedSession =
                      hours.length > 1
                        ? (getReceptionCell(displayGrid, member.id, selection!.focusHour) ??
                          getReceptionCell(displayGrid, member.id, selection!.anchorHour) ??
                          null)
                        : (session ?? null);
                    const canDelete = hours.some(
                      (h) => getReceptionCell(displayGrid, member.id, h) !== undefined,
                    );
                    const repeatsPrevious = continuations[hourIndex];
                    const runLength = repeatsPrevious ? 1 : runLengthFrom(continuations, hourIndex);
                    const isRunEnd =
                      hourIndex === RECEPTION_HOURS.length - 1 || !continuations[hourIndex + 1];
                    // A hairline between columns, suppressed inside a run so the
                    // bar reads as one unbroken block.
                    const dividerClassName = isRunEnd ? "border-r border-border" : "";
                    // The role colour lives on an inset, rounded bar rather than
                    // on the cell itself, so a run of slots reads as one block on
                    // a timeline instead of a row of filled spreadsheet cells. The
                    // bar's top and bottom edges are drawn by every segment and
                    // its left/right only at the run's ends, which outlines the
                    // whole run as one capsule with no internal rules.
                    const barClassName = session
                      ? `${RECEPTION_ROLE_COLOURS[session.role].bar} border-y ${
                          repeatsPrevious ? "" : "rounded-l-md border-l"
                        } ${isRunEnd ? "rounded-r-md border-r" : ""}`
                      : "";
                    // Selection is outlined the same way a run is - one capsule
                    // around the whole range rather than a ring per cell, which
                    // read as a row of separate boxes. A background of its own
                    // would collide with the bar's, so only an empty cell (which
                    // has no bar) gets one.
                    const isRangeStart = isSelected && hour === memberRange[0];
                    const isRangeEnd = isSelected && hour === memberRange[memberRange.length - 1];
                    const selectedClassName = isSelected && !session ? "bg-accent/10" : "";
                    const cursorClassName = interactive ? "cursor-pointer" : "";
                    // The label's colour sits on the <td>, not on the bar: a
                    // run's label is one element overhanging several cells, so
                    // it can only inherit from the cell it is anchored in.
                    const textClassName = session ? RECEPTION_ROLE_COLOURS[session.role].text : "";
                    return (
                      <td
                        key={hour}
                        className={`relative px-1 py-1.5 text-center ${textClassName} ${rowRule} ${dividerClassName} ${selectedClassName} ${cursorClassName} ${onLeaveClassName}`}
                        data-testid={`reception-cell-${member.id}-${hour}`}
                        data-selected={isSelected ? "true" : undefined}
                        data-run-continuation={repeatsPrevious ? "true" : undefined}
                        onClick={interactive ? (e) => handleCellClick(e, member.id, hour) : undefined}
                      >
                        {session ? (
                          <span
                            aria-hidden="true"
                            className={`pointer-events-none absolute inset-y-1 left-0 right-0 ${barClassName}`}
                          />
                        ) : null}
                        {isSelected ? (
                          <span
                            aria-hidden="true"
                            className={`pointer-events-none absolute inset-y-0.5 left-0 right-0 z-20 border-y border-accent ${
                              isRangeStart ? "rounded-l border-l" : ""
                            } ${isRangeEnd ? "rounded-r border-r" : ""}`}
                          />
                        ) : null}
                        {interactive ? (
                          <ReceptionCellPopover
                            session={seedSession}
                            hourCount={hours.length}
                            canDelete={canDelete}
                            saving={saving}
                            onSave={(role, note) => handleSave(member.id, hours, role, note)}
                            onDelete={() => handleDelete(member.id, hours)}
                          >
                            {session ? (
                              <div>
                                <CellContent session={session} repeated={repeatsPrevious} runLength={runLength} />
                              </div>
                            ) : (
                              <button
                                type="button"
                                aria-label={`Add session for ${member.code} ${formatHour(hour)}`}
                                className="flex h-full w-full items-center justify-center text-ink/15 transition-colors hover:text-ink/50 disabled:opacity-50"
                                {...writeGate}
                              >
                                +
                              </button>
                            )}
                          </ReceptionCellPopover>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ReceptionRoleLegend roles={legendRoles} />
    </div>
  );
}

/**
 * Sticky first column and header row are held in place by a soft edge shadow
 * rather than a heavy rule - the 2px near-black borders this replaced were
 * what gave the grid its spreadsheet-bevel look. The border colour is
 * repeated literally because `theme()` is not available inside an arbitrary
 * Tailwind value here; it is `colors.border` from tailwind.config.js.
 */
const STICKY_COLUMN_SHADOW = "shadow-[6px_0_8px_-8px_rgba(28,36,48,0.30)]";

/**
 * z-index layering in the grid, high to low: the header's corner cell (40),
 * the sticky staff column (30), the sticky header row and the selection
 * outline (20), a run's centred label (10, see CellContent), and the role
 * colour bars (auto). The staff
 * column has to outrank the labels because a run's label overhangs its own
 * cell and would otherwise scroll out over the frozen names.
 */
const HEADER_RULE = "shadow-[0_1px_0_0_rgb(var(--color-border))]";

/**
 * A key for the role colours, limited to the roles actually on this grid -
 * all thirteen at once is noise, and a day rota typically uses five or six.
 * `roles` arrives in RECEPTION_ROLE_ORDER, not first-seen order, so the key
 * does not reshuffle itself as the grid is edited.
 */
function ReceptionRoleLegend({ roles }: { roles: ReceptionRole[] }) {
  if (roles.length === 0) return null;

  return (
    <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5" aria-label="Role colours">
      {roles.map((role) => (
        <li key={role} className="flex items-center gap-1.5 text-xs text-ink/60">
          <span
            aria-hidden="true"
            className={`h-3 w-5 rounded border ${RECEPTION_ROLE_COLOURS[role].bar}`}
          />
          {RECEPTION_ROLE_LABELS[role]}
        </li>
      ))}
    </ul>
  );
}

/** How many consecutive slots from `startIndex` (inclusive) belong to the same run. */
function runLengthFrom(continuations: boolean[], startIndex: number): number {
  let length = 1;
  while (startIndex + length < continuations.length && continuations[startIndex + length]) {
    length += 1;
  }
  return length;
}

/**
 * `runLength` is the number of slots the visible chip's cell heads up (1 for a lone
 * slot). For a multi-slot run the chip is centred across the whole run rather than the
 * run's first cell alone: the normal in-flow copy stays (invisible) to keep the
 * popover trigger's box its usual height, and a second, pointer-events-none copy is
 * absolutely positioned across the run's full width so it reads as centred on the
 * merged run instead of pinned to its left edge. Every `<td>` carries `position:
 * relative` (it is also the containing block for the cell's colour bar) so width is measured
 * against the run's own first column, not the whole table.
 *
 * The table is laid out by the automatic algorithm (`table-fixed` has no effect
 * while the table's own width is auto - `min-w-full` is a min-width, not a width),
 * so every in-flow copy would otherwise widen its column to fit the role label.
 * That is wanted for a lone slot, whose column has to hold the label on its own,
 * and pointless for a run, which has runLength columns to spread one label across:
 * a whole-row run of "Prescriptions" would stretch every column to fit text it
 * only draws once. So inside a run the in-flow copy is zero-width and clipped -
 * it still sets the row's height and the trigger's hit box, but contributes no
 * width at all, leaving merged columns at their natural size.
 */
function CellContent<T extends ReceptionCellData>({
  session,
  repeated,
  runLength,
}: {
  session: T;
  repeated: boolean;
  runLength: number;
}) {
  const chip = (
    <>
      <span className="px-1.5 text-xs font-medium">{RECEPTION_ROLE_LABELS[session.role]}</span>
      {session.note ? <div className="px-1.5 text-xs opacity-70">{session.note}</div> : null}
    </>
  );

  const inRun = repeated || runLength > 1;
  const spacer = (
    <div
      className={inRun ? "w-0 overflow-hidden whitespace-nowrap" : undefined}
      style={{ visibility: "hidden" }}
    >
      {chip}
    </div>
  );

  if (!repeated && runLength > 1) {
    return (
      <>
        {spacer}
        <div
          className="pointer-events-none absolute inset-y-0 left-0 z-10 flex flex-col items-center justify-center"
          style={{ width: `${runLength * 100}%` }}
        >
          {chip}
        </div>
      </>
    );
  }

  // Both chips are positioned with a z-index so they paint above every cell's
  // colour bar. `relative` alone is not enough for the run chip: it overhangs
  // its own <td> into the run's later cells, whose bars are later siblings in
  // the tree and would paint over it (only the first cell's slice of the label
  // survived). No <td> here is a stacking context, so one z-index lifts the
  // chips above every z-auto bar in the table. Deliberately not applied to the
  // trigger wrapper in ReceptionGrid: that would move the run chip's containing
  // block off the <td> and break the runLength * 100% width below.
  return repeated ? spacer : <div className="relative z-10">{chip}</div>;
}

function groupIssuesByHour(issues: ValidationIssue[]): Map<number, ValidationIssue[]> {
  const byHour = new Map<number, ValidationIssue[]>();
  for (const issue of issues) {
    const hour = RECEPTION_HOURS.find((h) => issue.message.startsWith(formatHour(h)));
    if (hour === undefined) continue;
    const existing = byHour.get(hour);
    if (existing) {
      existing.push(issue);
    } else {
      byHour.set(hour, [issue]);
    }
  }
  return byHour;
}
