import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { useBankHolidays, useClosures } from "@/api/closures";
import { useDoctors } from "@/api/doctors";
import { useExtraSessions } from "@/api/extraSessions";
import { useApplyPlanningBulk, useBlockedEntries, useCoverage } from "@/api/leavePlanning";
import { useLeave, useLeaveEntitlements } from "@/api/leave";
import { useActiveMasterRota } from "@/api/masterRota";
import { useSchools } from "@/api/schools";
import type { ApiError, PlanningBulkOut } from "@/api/types";
import { useLinkedDoctorId, useWriteGate } from "@/auth/AuthContext";
import { LeaveEntitlementSummary } from "@/components/LeaveEntitlementSummary";
import { LeavePlanningGrid } from "@/components/LeavePlanningGrid";
import { useSessionYear } from "@/components/SessionManagementTabs";
import { toClosedSlotSet } from "@/lib/closedSlots";
import { compareDoctorDisplayOrder } from "@/lib/groupDoctors";
import {
  type PendingEdit,
  type PlanningCell,
  type PlanningCellState,
  applyPendingToCoverage,
  buildPlanningActions,
  buildTemplateIndex,
  overlapsRange,
  planningCellKey,
  schoolHolidayDatesInRange,
  serverNotes,
  serverRows,
  toCellKeySet,
  toCellState,
  toNotesMap,
  weekdaysInMonth,
} from "@/lib/planningMonth";

/**
 * Annual leave planning: one month of weekday cells per Partner/Salaried/
 * Locum doctor - plus Trainees behind the "Show trainees" toggle - with a
 * live clinical-cover total underneath.
 *
 * Edits are batched. Every click writes to a page-level pending map and
 * nothing else; Save posts the whole batch to POST /leave-planning/bulk
 * in one transaction. Cell state is never stored per-cell - it is derived
 * at render from the server rows plus the pending map, so the two can't
 * drift.
 *
 * The total row is recomputed client-side by `applyPendingToCoverage`,
 * which re-applies the coverage endpoint's own rules locally. See
 * lib/planningMonth.ts for why that lives outside this component.
 */

function errorDetail(err: unknown, fallback: string): string {
  const apiErr = err as ApiError | undefined;
  if (apiErr && typeof apiErr.detail === "string") {
    return apiErr.detail;
  }
  return fallback;
}

function monthTitle(year: number, month: number): string {
  // en-GB pinned for the same reason formatWeekLabel is: one fixed,
  // unambiguous month-year for every user, not a locale-dependent one.
  return new Date(year, month - 1, 1).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
  });
}

function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/**
 * The save summary. Skips and supersedes are worded as information, not
 * error - the save succeeded; a skip means the server found the cell
 * already in the requested state, or the doctor's dates moved under a
 * grid that was loaded before the change.
 */
function summariseSave(result: PlanningBulkOut): string {
  const parts = [`${result.applied} change${result.applied === 1 ? "" : "s"} saved`];

  const outOfWindow = result.skipped.filter((s) => s.reason === "outside_doctor_dates").length;
  const alreadySet = result.skipped.filter(
    (s) => s.reason === "duplicate" || s.reason === "nothing_to_clear",
  ).length;
  const leaveWins = result.skipped.filter((s) => s.reason === "leave_exists").length;
  const blockedWins = result.skipped.filter((s) => s.reason === "blocked_exists").length;

  if (alreadySet > 0) parts.push(`${alreadySet} already matched`);
  if (outOfWindow > 0) parts.push(`${outOfWindow} skipped (doctor not employed on that date)`);
  if (leaveWins > 0) parts.push(`${leaveWins} entr${leaveWins === 1 ? "y" : "ies"} skipped (leave takes precedence)`);
  if (blockedWins > 0) parts.push(`${blockedWins} extra session${blockedWins === 1 ? "" : "s"} skipped (blocked takes precedence)`);

  let summary = `${parts.join(", ")}.`;

  const superseded = result.superseded_extra_sessions;
  if (superseded.length > 0) {
    // Reported, never deleted - the same warning LeavePage shows for the
    // same reason.
    summary += ` Note: ${superseded.length} existing extra session${
      superseded.length === 1 ? "" : "s"
    } (${superseded.map((e) => e.date).join(", ")}) ${
      superseded.length === 1 ? "is" : "are"
    } superseded by leave saved here - review on the Extra Sessions page.`;
  }

  return summary;
}

export function LeavePlanningPage() {
  const writeGate = useWriteGate();
  const linkedDoctorId = useLinkedDoctorId();
  // Year and month come from the Session Management strip's shared state,
  // not from a local seed: the year is the one every sibling tab is showing
  // (and is in the URL), and keeping the month there too means switching
  // tabs and back returns to the month you were on.
  const { year, month, setMonth } = useSessionYear();
  const [pending, setPending] = useState<Map<string, PendingEdit>>(new Map());
  // Which doctor's row is highlighted, and whose leave balance is shown.
  // A reading aid only - it never affects an edit. Kept across month
  // changes: following one doctor through the year is the point of it.
  // Seeded from the login's linked doctor (staff linking) as an initial
  // value only, never re-applied by an effect: the page opens on your own
  // row, and Clear or a click on another doctor sticks.
  const [selectedDoctorId, setSelectedDoctorId] = useState<number | null>(linkedDoctorId);
  // Trainees are hidden by default: the grid exists to plan the cover the
  // totals row measures, and trainees contribute nothing to it. Shown on
  // request all the same - knowing which trainees are away that week is
  // still useful when planning.
  const [showTrainees, setShowTrainees] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSummary, setSaveSummary] = useState<string | null>(null);

  const dates = useMemo(() => weekdaysInMonth(year, month), [year, month]);
  const fromDate = dates[0];
  const toDate = dates[dates.length - 1];

  // Active only: the window, not `active`, is what decides whether a
  // doctor who has left still shows for the months they worked, and an
  // inactive doctor has no leave left to plan either way.
  const { data: allDoctors } = useDoctors(true);
  const { data: coverage, isLoading: coverageLoading } = useCoverage(fromDate, toDate);
  const { data: leave } = useLeave(null, null);
  const { data: extraSessions } = useExtraSessions(null, null);
  const { data: blocked } = useBlockedEntries();
  const { data: closures } = useClosures(null);
  const { data: bankHolidays } = useBankHolidays(year);
  const { data: schools } = useSchools();
  // 404s when no template is active; the grid still draws its leave cells,
  // the cover row simply reads zero throughout (matching the endpoint's
  // own no-active-template behaviour).
  const { data: template } = useActiveMasterRota();
  // The leave year follows the month being viewed, so paging from
  // December into January swaps the balance to the new year's - a balance
  // labelled with a different year than the cells beneath it would be
  // worse than useless. Fetched unconditionally (one small cached query
  // per year) rather than only while a doctor is selected, so picking a
  // row doesn't flash a loading line.
  const { data: entitlement, isLoading: entitlementLoading, isError: entitlementError } =
    useLeaveEntitlements(year);

  const applyBulk = useApplyPlanningBulk();

  // The rows on screen. Trainees are off by default and added by the
  // toggle: they are planned here for visibility (who is away when), but
  // the coverage endpoint does not count them, so they are kept out of
  // `coverageDoctors` below rather than folded into one list.
  const doctors = useMemo(
    () =>
      (allDoctors ?? [])
        .filter(
          (d) =>
            (d.doctor_type === "Partner" ||
              d.doctor_type === "Salaried" ||
              d.doctor_type === "Locum" ||
              (showTrainees && d.doctor_type === "Trainee")) &&
            // Overlap, not "in window today": a doctor leaving mid-month
            // must still show for the part of the month they worked.
            overlapsRange(d, fromDate, toDate),
        )
        .sort((a, b) =>
          compareDoctorDisplayOrder(
            { type: a.doctor_type, code: a.code },
            { type: b.doctor_type, code: b.code },
          ),
        ),
    [allDoctors, fromDate, toDate, showTrainees],
  );

  // Exactly the doctors `GET /leave-planning/coverage` counts
  // (`_PLANNING_DOCTOR_TYPES`), which is the whole grid when the trainee
  // toggle is off. A pending edit on a doctor outside this list adjusts
  // nothing, so the live total keeps matching the server's baseline: a
  // trainee is absent from that baseline, so removing them from it on
  // leave would take the total below what the server will report.
  const coverageDoctors = useMemo(
    () => doctors.filter((d) => d.doctor_type !== "Trainee"),
    [doctors],
  );

  // Only a doctor with a row on screen counts as selected: a balance line
  // for someone the grid isn't showing (they left before this month, or
  // start after it) would have no highlighted row to belong to. The id is
  // kept either way, so paging back to a month they work brings the
  // highlight back.
  const selectedDoctor = doctors.find((d) => d.id === selectedDoctorId) ?? null;
  // Undefined (still loading) and "no row" (a locum - the endpoint only
  // returns doctors with a tracked entitlement) both come out as null; the
  // two are told apart below by `entitlementLoading`.
  const entitlementRow =
    selectedDoctor === null
      ? null
      : ((entitlement?.doctors ?? []).find((row) => row.doctor_id === selectedDoctor.id) ?? null);

  const schoolRows = useMemo(
    () =>
      (schools ?? [])
        .map((school) => ({
          id: school.id,
          name: school.name,
          dates: schoolHolidayDatesInRange(dates, school.holidays),
        }))
        .filter((row) => row.dates.size > 0),
    [schools, dates],
  );

  const templateTypes = useMemo(
    () => buildTemplateIndex(template?.sessions ?? []),
    [template],
  );

  const leaveKeys = useMemo(() => toCellKeySet(leave ?? []), [leave]);
  const extraKeys = useMemo(() => toCellKeySet(extraSessions ?? []), [extraSessions]);
  const blockedKeys = useMemo(() => toCellKeySet(blocked ?? []), [blocked]);
  const leaveNotes = useMemo(() => toNotesMap(leave ?? []), [leave]);
  const extraNotes = useMemo(() => toNotesMap(extraSessions ?? []), [extraSessions]);
  const blockedNotes = useMemo(() => toNotesMap(blocked ?? []), [blocked]);
  const closedSlots = useMemo(() => toClosedSlotSet(closures ?? []), [closures]);

  const totals = useMemo(
    () =>
      applyPendingToCoverage({
        coverage: coverage ?? [],
        pending,
        doctors: coverageDoctors,
        sessions: template?.sessions ?? [],
        leave: leave ?? [],
        extraSessions: extraSessions ?? [],
        blocked: blocked ?? [],
      }),
    [coverage, pending, coverageDoctors, template, leave, extraSessions, blocked],
  );

  /** One popover Apply, over every cell the grid selected - a plain click
   * is simply a range of one. The state and note are written verbatim to
   * all of them; the grid has already dropped the closed and
   * out-of-window cells a drag may have spanned. */
  function handleApply(cells: PlanningCell[], state: PlanningCellState, notes: string) {
    setPending((prev) => {
      const updated = new Map(prev);
      for (const cell of cells) {
        const key = planningCellKey(cell.doctorId, cell.date, cell.period);
        const rows = serverRows(leaveKeys, extraKeys, blockedKeys, key);
        const serverState = toCellState(rows);
        const serverNotesValue = serverNotes(leaveNotes, extraNotes, blockedNotes, key);
        // Picking a cell back to exactly what the server already says is
        // not an edit - dropping the key keeps the unsaved count honest and
        // keeps a no-op out of the batch. Applied per cell, so the cells in
        // a range that already matched don't inflate the count either.
        if (state === serverState && notes === serverNotesValue) {
          updated.delete(key);
        } else {
          updated.set(key, { action: state === "normal" ? "clear" : state, notes });
        }
      }
      return updated;
    });
  }

  /** Clicking the highlighted doctor's name again clears the highlight -
   * there is no other affordance for turning it back off. */
  function handleSelectDoctor(doctorId: number) {
    setSelectedDoctorId((prev) => (prev === doctorId ? null : doctorId));
  }

  function handleMonthChange(delta: number) {
    // Pending edits are deliberately kept across a month change: they are
    // keyed by date, so nothing is ambiguous, and losing a month's work
    // to a mis-click would be worse than carrying it.
    // Handing the year back to the shared setter is what keeps the strip
    // honest when a step crosses New Year: December 2027 -> January 2028
    // moves the selected year with it.
    const next = shiftMonth(year, month, delta);
    setMonth(next.month, next.year);
    setSaveError(null);
    setSaveSummary(null);
  }

  function handleDiscard() {
    setPending(new Map());
    setSaveError(null);
    setSaveSummary(null);
  }

  // Returns whether the save succeeded, so callers that chain a navigation
  // onto it (the unsaved-changes guard below) know whether it's safe to
  // leave.
  async function handleSave(): Promise<boolean> {
    setSaveError(null);
    setSaveSummary(null);

    const actions = buildPlanningActions({
      pending,
      leaveKeys,
      extraKeys,
      blockedKeys,
      leaveNotes,
      extraNotes,
      blockedNotes,
    });
    if (actions.length === 0) {
      setPending(new Map());
      return true;
    }

    try {
      const result = await applyBulk.mutateAsync({ actions });
      setSaveSummary(summariseSave(result));
      setPending(new Map());
      return true;
    } catch (err) {
      // The batch is one transaction, so a failure means nothing was
      // written - the pending map is kept so the admin can retry.
      setSaveError(errorDetail(err, "Could not save these changes."));
      return false;
    }
  }

  const unsavedCount = pending.size;
  const navigate = useNavigate();
  const [navigationTarget, setNavigationTarget] = useState<string | null>(null);

  // Closing the tab or reloading isn't a router navigation, so it can't be
  // caught by the click-intercept below - this is the browser's own hook
  // for that case.
  useEffect(() => {
    if (unsavedCount === 0) return;

    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [unsavedCount]);

  // The app uses a plain BrowserRouter (not a data router), so there is no
  // useBlocker/usePrompt to hook into - in-app navigation (the other
  // session-management tabs, the left nav, "Switch app") is caught instead
  // by intercepting clicks on links before the router acts on them.
  useEffect(() => {
    if (unsavedCount === 0) return;

    function handleClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = (event.target as HTMLElement | null)?.closest("a");
      if (!anchor) return;
      if (anchor.target && anchor.target !== "_self") return;

      const href = anchor.getAttribute("href");
      if (!href || href === window.location.pathname) return;

      event.preventDefault();
      setNavigationTarget(href);
    }

    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, [unsavedCount]);

  async function handleNavigationSave() {
    const target = navigationTarget;
    const saved = await handleSave();
    setNavigationTarget(null);
    if (saved && target) {
      navigate(target);
    }
  }

  function handleNavigationDiscard() {
    const target = navigationTarget;
    handleDiscard();
    setNavigationTarget(null);
    if (target) {
      navigate(target);
    }
  }

  function handleNavigationCancel() {
    setNavigationTarget(null);
  }

  // Any still unset, not "none set at all": a part-filled year leaves the
  // cover totals wrong on exactly the days that are still missing, which is
  // what this banner exists to flag, so it only clears once all of the named
  // holidays have a date. Counted off the fetched list rather than a
  // hardcoded 8 - the fixed list lives in the backend (models/bank_holidays)
  // and the endpoint always returns every entry, dated or not.
  const bankHolidaysTotal = bankHolidays?.length ?? 0;
  const bankHolidaysMissing = (bankHolidays ?? []).filter((h) => h.date === null).length;

  return (
    <div>
      {bankHolidaysMissing > 0 ? (
        <p
          data-testid="bank-holidays-missing-warning"
          className="mb-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          {bankHolidaysMissing} of {bankHolidaysTotal} bank holidays for {year} have not been added
          yet. Clinical cover totals here won't account for them until they're set on the{" "}
          <Link to="/clinical/closures" className="font-medium underline">
            Closures
          </Link>{" "}
          page.
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => handleMonthChange(-1)}
          className="rounded border border-border px-2 py-1 text-sm"
        >
          Previous
        </button>
        <span className="min-w-[10rem] text-center text-sm font-medium">
          {monthTitle(year, month)}
        </span>
        <button
          type="button"
          onClick={() => handleMonthChange(1)}
          className="rounded border border-border px-2 py-1 text-sm"
        >
          Next
        </button>

        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            data-testid="planning-show-trainees"
            checked={showTrainees}
            onChange={(event) => setShowTrainees(event.target.checked)}
          />
          Show trainees
        </label>

        <div className="ml-auto flex items-center gap-2">
          {unsavedCount > 0 ? (
            <span
              data-testid="planning-unsaved-count"
              className="rounded bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900"
            >
              {unsavedCount} unsaved change{unsavedCount === 1 ? "" : "s"}
            </span>
          ) : null}
          <button
            type="button"
            onClick={handleDiscard}
            disabled={unsavedCount === 0 || applyBulk.isPending}
            className="rounded border border-border px-3 py-1 text-sm disabled:opacity-50"
            {...writeGate}
          >
            Discard
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={unsavedCount === 0 || applyBulk.isPending}
            className="rounded bg-accent px-4 py-1 text-sm font-medium text-white disabled:opacity-50"
            {...writeGate}
          >
            Save
          </button>
        </div>
      </div>

      {showTrainees ? (
        // Said plainly rather than left to be inferred from a total that
        // does not move: trainee cells are saved like any other, but the
        // coverage endpoint does not count trainees, so the cover row
        // underneath them is unchanged by a trainee's leave.
        <p className="mt-2 text-xs text-ink/60">
          Trainee rows can be edited, but trainee leave does not change the clinical cover totals.
        </p>
      ) : null}

      {saveError ? <p className="mt-2 text-sm text-red-700">{saveError}</p> : null}
      {saveSummary ? <p className="mt-2 text-sm text-ink/70">{saveSummary}</p> : null}

      {coverageLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}

      {selectedDoctor !== null ? (
        <div
          data-testid="planning-selected-doctor"
          className="mt-3 flex flex-wrap items-start gap-x-3 gap-y-1 rounded border border-border bg-surface px-3 py-2"
        >
          <span className="text-sm font-semibold">{selectedDoctor.code}</span>
          <div className="min-w-0 flex-1">
            {entitlementRow === null && !entitlementLoading && !entitlementError ? (
              <p className="text-sm text-ink/60">No leave entitlement is tracked for this doctor.</p>
            ) : (
              <LeaveEntitlementSummary
                year={year}
                row={entitlementRow}
                isLoading={entitlementLoading}
                isError={entitlementError}
              />
            )}
            {unsavedCount > 0 && entitlementRow !== null ? (
              // The figures come from the saved rows, so a batch still
              // sitting in the pending map isn't in them - saying so beats
              // an admin reading a stale balance as the post-save one.
              <p className="mt-1 text-xs text-amber-700">
                Unsaved changes on this page are not counted yet.
              </p>
            ) : null}
          </div>
          <button
            type="button"
            data-testid="planning-clear-doctor"
            onClick={() => setSelectedDoctorId(null)}
            className="text-xs text-ink/60 underline"
          >
            Clear
          </button>
        </div>
      ) : null}

      <LeavePlanningGrid
        dates={dates}
        year={year}
        month={month}
        doctors={doctors}
        emptyMessage={
          showTrainees
            ? "No partners, salaried doctors, locums, or trainees work this month."
            : undefined
        }
        schoolRows={schoolRows}
        pending={pending}
        leaveKeys={leaveKeys}
        extraKeys={extraKeys}
        blockedKeys={blockedKeys}
        leaveNotes={leaveNotes}
        extraNotes={extraNotes}
        blockedNotes={blockedNotes}
        closedSlots={closedSlots}
        totals={totals}
        templateTypes={templateTypes}
        selectedDoctorId={selectedDoctorId}
        onSelectDoctor={handleSelectDoctor}
        onApply={handleApply}
      />

      {navigationTarget ? (
        <div
          data-testid="unsaved-changes-dialog"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        >
          <div className="w-full max-w-sm rounded bg-surface p-4 shadow-lg">
            <p className="text-sm font-medium">Unsaved changes</p>
            <p className="mt-1 text-sm text-ink/70">
              You have {unsavedCount} unsaved change{unsavedCount === 1 ? "" : "s"}. Save them,
              discard them, or cancel and stay on this page.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={handleNavigationCancel}
                className="rounded border border-border px-3 py-1 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleNavigationDiscard}
                className="rounded border border-border px-3 py-1 text-sm"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={handleNavigationSave}
                disabled={applyBulk.isPending}
                className="rounded bg-accent px-3 py-1 text-sm font-medium text-white disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
