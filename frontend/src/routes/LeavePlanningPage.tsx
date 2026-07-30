import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { useBankHolidays, useClosures } from "@/api/closures";
import { useDoctors } from "@/api/doctors";
import { useExtraSessions } from "@/api/extraSessions";
import { useApplyPlanningBulk, useCoverage } from "@/api/leavePlanning";
import { useLeave } from "@/api/leave";
import { useActiveMasterRota } from "@/api/masterRota";
import { useSchools } from "@/api/schools";
import type { ApiError, Period, PlanningAction, PlanningBulkOut } from "@/api/types";
import { LeavePlanningGrid } from "@/components/LeavePlanningGrid";
import { toClosedSlotSet } from "@/lib/closedSlots";
import { compareDoctorDisplayOrder } from "@/lib/groupDoctors";
import {
  type PlanningCellState,
  applyPendingToCoverage,
  buildPlanningActions,
  buildTemplateIndex,
  overlapsRange,
  planningCellKey,
  schoolHolidayDatesInRange,
  serverRows,
  stateToAction,
  toCellKeySet,
  toCellState,
  weekdaysInMonth,
} from "@/lib/planningMonth";

/**
 * Annual leave planning: one month of weekday cells per Partner/Salaried/
 * Locum doctor, with a live clinical-cover total underneath.
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
 * error - the save succeeded (Design Decision 8); a skip means the server
 * found the cell already in the requested state, or the doctor's dates
 * moved under a grid that was loaded before the change.
 */
function summariseSave(result: PlanningBulkOut): string {
  const parts = [`${result.applied} change${result.applied === 1 ? "" : "s"} saved`];

  const outOfWindow = result.skipped.filter((s) => s.reason === "outside_doctor_dates").length;
  const alreadySet = result.skipped.filter(
    (s) => s.reason === "duplicate" || s.reason === "nothing_to_clear",
  ).length;
  const leaveWins = result.skipped.filter((s) => s.reason === "leave_exists").length;

  if (alreadySet > 0) parts.push(`${alreadySet} already matched`);
  if (outOfWindow > 0) parts.push(`${outOfWindow} skipped (doctor not employed on that date)`);
  if (leaveWins > 0) parts.push(`${leaveWins} extra session${leaveWins === 1 ? "" : "s"} skipped (leave takes precedence)`);

  let summary = `${parts.join(", ")}.`;

  const superseded = result.superseded_extra_sessions;
  if (superseded.length > 0) {
    // Reported, never deleted - the same warning LeavePage shows for the
    // same reason (extra sessions plan, Design Decision 6).
    summary += ` Note: ${superseded.length} existing extra session${
      superseded.length === 1 ? "" : "s"
    } (${superseded.map((e) => e.date).join(", ")}) ${
      superseded.length === 1 ? "is" : "are"
    } superseded by leave saved here - review on the Extra Sessions page.`;
  }

  return summary;
}

export function LeavePlanningPage() {
  const today = new Date();
  const [{ year, month }, setMonth] = useState({
    year: today.getFullYear(),
    month: today.getMonth() + 1,
  });
  const [pending, setPending] = useState<Map<string, PlanningAction>>(new Map());
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
  const { data: leave } = useLeave(null);
  const { data: extraSessions } = useExtraSessions(null);
  const { data: closures } = useClosures();
  const { data: bankHolidays } = useBankHolidays(year);
  const { data: schools } = useSchools();
  // 404s when no template is active; the grid still draws its leave cells,
  // the cover row simply reads zero throughout (matching the endpoint's
  // own no-active-template behaviour).
  const { data: template } = useActiveMasterRota();

  const applyBulk = useApplyPlanningBulk();

  const doctors = useMemo(
    () =>
      (allDoctors ?? [])
        .filter(
          (d) =>
            (d.doctor_type === "Partner" ||
              d.doctor_type === "Salaried" ||
              d.doctor_type === "Locum") &&
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
    [allDoctors, fromDate, toDate],
  );

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
  const closedSlots = useMemo(() => toClosedSlotSet(closures ?? []), [closures]);

  const totals = useMemo(
    () =>
      applyPendingToCoverage({
        coverage: coverage ?? [],
        pending,
        doctors,
        sessions: template?.sessions ?? [],
        leave: leave ?? [],
        extraSessions: extraSessions ?? [],
      }),
    [coverage, pending, doctors, template, leave, extraSessions],
  );

  function handleToggle(
    doctorId: number,
    date: string,
    period: Period,
    next: PlanningCellState,
  ) {
    const key = planningCellKey(doctorId, date, period);
    setPending((prev) => {
      const updated = new Map(prev);
      // Cycling a cell back to what the server already says is not an
      // edit - dropping the key keeps the unsaved count honest and keeps
      // a no-op out of the batch.
      if (next === toCellState(serverRows(leaveKeys, extraKeys, key))) {
        updated.delete(key);
      } else {
        updated.set(key, stateToAction(next));
      }
      return updated;
    });
  }

  function handleMonthChange(delta: number) {
    // Pending edits are deliberately kept across a month change: they are
    // keyed by date, so nothing is ambiguous, and losing a month's work
    // to a mis-click would be worse than carrying it.
    setMonth((prev) => shiftMonth(prev.year, prev.month, delta));
    setSaveError(null);
    setSaveSummary(null);
  }

  function handleDiscard() {
    setPending(new Map());
    setSaveError(null);
    setSaveSummary(null);
  }

  async function handleSave() {
    setSaveError(null);
    setSaveSummary(null);

    const actions = buildPlanningActions({ pending, leaveKeys, extraKeys });
    if (actions.length === 0) {
      setPending(new Map());
      return;
    }

    try {
      const result = await applyBulk.mutateAsync({ actions });
      setSaveSummary(summariseSave(result));
      setPending(new Map());
    } catch (err) {
      // The batch is one transaction, so a failure means nothing was
      // written - the pending map is kept so the admin can retry.
      setSaveError(errorDetail(err, "Could not save these changes."));
    }
  }

  const unsavedCount = pending.size;

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
      <p className="text-sm text-ink/70">
        Click a cell to cycle it: leave, then extra session, then back to normal. Nothing is saved
        until you press Save. The Clinical cover row counts partner, salaried, and locum doctors
        working that session; the Weekly cover row underneath sums AM and PM cover across the whole
        week.
      </p>
      <p className="mt-1 text-sm text-ink/50">
        Extra sessions planned here are applied when a staging run is next created that covers the
        date - they do not change a staging or rota that already exists.
      </p>

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
          >
            Discard
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={unsavedCount === 0 || applyBulk.isPending}
            className="rounded bg-accent px-4 py-1 text-sm font-medium text-white disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>

      {saveError ? <p className="mt-2 text-sm text-red-700">{saveError}</p> : null}
      {saveSummary ? <p className="mt-2 text-sm text-ink/70">{saveSummary}</p> : null}

      {coverageLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}

      <LeavePlanningGrid
        dates={dates}
        year={year}
        month={month}
        doctors={doctors}
        schoolRows={schoolRows}
        pending={pending}
        leaveKeys={leaveKeys}
        extraKeys={extraKeys}
        closedSlots={closedSlots}
        totals={totals}
        templateTypes={templateTypes}
        onToggle={handleToggle}
      />
    </div>
  );
}
