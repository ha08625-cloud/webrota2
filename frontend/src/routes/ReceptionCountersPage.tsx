import { useState } from "react";

import { useReceptionCounters, useReceptionMasterSessions } from "@/api/reception";
import type { ReceptionMasterSession, ReceptionRole } from "@/api/types";
import { formatDate } from "@/lib/date";
import { RECEPTION_ROLE_LABELS, RECEPTION_ROLE_ORDER } from "@/lib/receptionRoles";
import {
  computeReceptionWeightedScore,
  formatReceptionWeightedScore,
} from "@/lib/receptionWeightedScore";

/**
 * Weekly working hours per staff member, derived from the master template:
 * every template row is a scheduled half-hour slot, and a `not_working`
 * role tags a slot as scheduled-but-not-working (see
 * architecture-reception.md) without deleting it. Working hours are
 * therefore (all rows - not_working rows) * 0.5h. Rows the staff member
 * has no session for at all are already excluded, since only rows exist
 * in the data - there is nothing to subtract for them.
 */
function computeWeeklyHours(sessions: ReceptionMasterSession[]): Map<number, number> {
  const slotCounts = new Map<number, number>();
  for (const session of sessions) {
    if (session.role === "not_working") continue;
    slotCounts.set(session.staff_id, (slotCounts.get(session.staff_id) ?? 0) + 1);
  }
  const hours = new Map<number, number>();
  for (const [staffId, slots] of slotCounts) {
    hours.set(staffId, slots * 0.5);
  }
  return hours;
}

function formatHours(hours: number): string {
  return Number.isInteger(hours) ? `${hours}` : hours.toFixed(1);
}

type CellMode = "slots" | "percent";

export function ReceptionCountersPage() {
  // Server default window (four complete preceding weeks plus the current
  // week to date) - the page deliberately passes no bounds, so there is
  // exactly one definition of the window and it lives in the backend.
  // It also drives the row set on its own: every active staff member is
  // zero-filled server-side and every staff member with history in the
  // window is included whether active or not, which is exactly the rows
  // this page wants - so there is no useReceptionStaff() call here. The
  // master template is fetched only for the contracted-hours column.
  const { data: counters, isLoading: countersLoading, isError: countersError } = useReceptionCounters();
  const {
    data: sessions,
    isLoading: sessionsLoading,
    isError: sessionsError,
  } = useReceptionMasterSessions();

  // Thirteen role columns of two numbers each does not fit a laptop screen,
  // and two tables would split one idea in half. One table, one toggle over
  // the already-fetched payload - local state, no refetch, no query param.
  const [mode, setMode] = useState<CellMode>("slots");

  const isLoading = countersLoading || sessionsLoading;
  const isError = countersError || sessionsError;

  const weeklyHours = sessions ? computeWeeklyHours(sessions) : new Map<number, number>();

  function roleCell(role: ReceptionRole, slots: number, hoursWorked: number): string {
    if (mode === "slots") {
      return `${slots}`;
    }
    return formatReceptionWeightedScore(computeReceptionWeightedScore(role, slots, hoursWorked));
  }

  return (
    <div>
      <h1 className="text-lg font-semibold">Counters</h1>
      <p className="mt-2 max-w-3xl text-sm text-ink/70">
        How much of each role each staff member has done over a rolling window of generated day
        rotas. Days a staff member was on leave count toward neither their roles nor their hours.
        Hours worked counts every scheduled half-hour slot except those tagged "Off".
      </p>

      {isLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}
      {isError ? <p className="mt-4 text-sm text-red-700">Could not load counters.</p> : null}

      {counters ? (
        <>
          {/*
            The window summary is the whole reason days_counted is on the
            wire: four weeks with six generated days is a fact the page
            should show, since otherwise a sparsely generated window is
            silently indistinguishable from a quiet one.
          */}
          <p className="mt-4 text-sm text-ink/70">
            {formatDate(counters.from_date)} to {formatDate(counters.to_date)} &middot;{" "}
            {counters.days_counted} {counters.days_counted === 1 ? "day" : "days"} generated
          </p>

          <div className="mt-3 flex gap-2 text-sm">
            <button
              type="button"
              onClick={() => setMode("slots")}
              aria-pressed={mode === "slots"}
              className={`rounded border px-2 py-1 ${
                mode === "slots" ? "border-accent bg-accent/10 text-accent" : "border-border text-ink/70"
              }`}
            >
              Slots
            </button>
            <button
              type="button"
              onClick={() => setMode("percent")}
              aria-pressed={mode === "percent"}
              className={`rounded border px-2 py-1 ${
                mode === "percent" ? "border-accent bg-accent/10 text-accent" : "border-border text-ink/70"
              }`}
            >
              % of time
            </button>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="text-sm">
              <thead>
                <tr>
                  <th className="py-1 pr-4 text-left font-medium text-ink/70">Staff</th>
                  <th className="py-1 pr-4 text-left font-medium text-ink/70">Hours / week</th>
                  <th className="py-1 pr-4 text-left font-medium text-ink/70">Hours worked</th>
                  <th className="py-1 pr-4 text-left font-medium text-ink/70">Days present</th>
                  {RECEPTION_ROLE_ORDER.map((role) => (
                    <th key={role} className="py-1 pr-4 text-left font-medium text-ink/70 whitespace-nowrap">
                      {RECEPTION_ROLE_LABELS[role]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {counters.staff.map((row) => (
                  <tr key={row.staff_id} className="border-t border-border">
                    <td className="py-1 pr-4 whitespace-nowrap">
                      {row.staff_name}
                      {/* Labelled rather than filtered out: a deactivated
                          staff member with history in the window still has
                          real counts, and a blank-labelled row would read
                          as a data error. */}
                      {row.active ? null : <span className="ml-1 text-ink/50">(inactive)</span>}
                    </td>
                    <td className="py-1 pr-4">
                      {formatHours(weeklyHours.get(row.staff_id) ?? 0)}
                    </td>
                    <td className="py-1 pr-4">{formatHours(row.hours_worked)}</td>
                    <td className="py-1 pr-4">{row.days_present}</td>
                    {RECEPTION_ROLE_ORDER.map((role) => (
                      <td key={role} className="py-1 pr-4">
                        {roleCell(role, row.role_slots[role] ?? 0, row.hours_worked)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
