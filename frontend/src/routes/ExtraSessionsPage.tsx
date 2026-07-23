import { useState } from "react";
import type { FormEvent } from "react";

import { useDoctors } from "@/api/doctors";
import { useCreateExtraSession, useDeleteExtraSession, useExtraSessions } from "@/api/extraSessions";
import { useActiveStaging } from "@/api/staging";
import type { ApiError, Period } from "@/api/types";
import { formatDateWithDay, parseLocalDate } from "@/lib/date";
import { groupDoctorsByType } from "@/lib/groupDoctors";

function errorDetail(err: unknown, fallback: string): string {
  const apiErr = err as ApiError | undefined;
  if (apiErr && typeof apiErr.detail === "string") {
    return apiErr.detail;
  }
  return fallback;
}

/**
 * True for a Saturday or Sunday. Mirrors the server's weekday-only rule
 * (extra sessions plan, Design Decision 3) client-side, so the server's
 * own 422 is never the first line of defence - same reasoning as
 * MAX_RANGE_DAYS in LeavePage.tsx.
 */
function isWeekend(dateString: string): boolean {
  const day = parseLocalDate(dateString).getDay();
  return day === 0 || day === 6;
}

export function ExtraSessionsPage() {
  // The filter reads against *all* doctors (including inactive), same
  // reasoning as LeavePage's filter: a deactivated doctor's historical
  // entries should still be findable here.
  const { data: allDoctors } = useDoctors(false);
  const activeDoctors = (allDoctors ?? []).filter((d) => d.active);
  const doctorsById = new Map((allDoctors ?? []).map((d) => [d.id, d]));

  const [filterDoctorId, setFilterDoctorId] = useState<number | null>(null);
  const { data: entries, isLoading, isError } = useExtraSessions(filterDoctorId);
  const createExtraSession = useCreateExtraSession();
  const deleteExtraSession = useDeleteExtraSession();

  // Design Decision 9: the override runs once at staging-create time, so
  // changes made here never affect a staging already in progress. This
  // banner states that plainly rather than leaving the admin to discover
  // it the hard way.
  const { data: activeStaging } = useActiveStaging();

  const [formDoctorId, setFormDoctorId] = useState<number | "">("");
  const [date, setDate] = useState("");
  const [period, setPeriod] = useState<Period>("AM");
  const [formError, setFormError] = useState<string | null>(null);
  const [formSummary, setFormSummary] = useState<string | null>(null);

  const addDoctorGroups = groupDoctorsByType(activeDoctors);
  const filterDoctorGroups = groupDoctorsByType(allDoctors ?? []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setFormSummary(null);

    if (formDoctorId === "" || !date) {
      setFormError("Doctor and date are required.");
      return;
    }
    if (isWeekend(date)) {
      setFormError(`${date} is a weekend; extra sessions can only be planned on weekdays.`);
      return;
    }

    try {
      await createExtraSession.mutateAsync({ doctor_id: formDoctorId, date, period });
      setFormSummary("Extra session added.");
      setDate("");
    } catch (err) {
      // Surfaces the server's 409 leave-conflict message verbatim (extra
      // sessions plan, Design Decision 6) alongside any other server-side
      // rejection.
      setFormError(errorDetail(err, "Could not add this extra session."));
    }
  }

  function handleDeleteRow(id: number) {
    deleteExtraSession.mutate(id);
  }

  const pending = createExtraSession.isPending;

  return (
    <div>
      <h1 className="text-lg font-semibold">Extra Sessions</h1>
      <p className="mt-1 text-sm text-ink/70">
        An extra session marks a doctor as working a session they would not normally work. It is
        applied when a staging run is started that covers the planned date.
      </p>

      {activeStaging ? (
        <div className="mt-4 rounded border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900">
          A staging is currently in progress. Changes made here will not affect it - only extra
          sessions planned before a staging is created are applied to it.
        </div>
      ) : null}

      <form
        onSubmit={handleSubmit}
        className="mt-4 flex flex-wrap items-end gap-2 rounded border border-border p-3"
      >
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="extra-session-doctor">
            Doctor
          </label>
          <select
            id="extra-session-doctor"
            value={formDoctorId}
            onChange={(e) => setFormDoctorId(e.target.value === "" ? "" : Number(e.target.value))}
            className="mt-1 rounded border border-border p-1 text-sm"
          >
            <option value="">Select...</option>
            {addDoctorGroups.map((group) => (
              <optgroup key={group.type} label={group.label}>
                {group.doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.code}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="extra-session-date">
            Date
          </label>
          <input
            id="extra-session-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 rounded border border-border p-1 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="extra-session-period">
            Period
          </label>
          <select
            id="extra-session-period"
            value={period}
            onChange={(e) => setPeriod(e.target.value as Period)}
            className="mt-1 rounded border border-border p-1 text-sm"
          >
            <option value="AM">AM</option>
            <option value="PM">PM</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-accent px-4 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          Add extra session
        </button>
        <p className="w-full text-xs text-ink/50">Weekdays only (Mon-Fri).</p>
      </form>
      {formError ? <p className="mt-2 text-sm text-red-700">{formError}</p> : null}
      {formSummary ? <p className="mt-2 text-sm text-ink/70">{formSummary}</p> : null}

      <div className="mt-6">
        <label className="text-sm font-medium" htmlFor="extra-session-filter">
          Doctor
        </label>
        <select
          id="extra-session-filter"
          value={filterDoctorId ?? ""}
          onChange={(e) => setFilterDoctorId(e.target.value === "" ? null : Number(e.target.value))}
          className="ml-2 rounded border border-border p-1 text-sm"
        >
          <option value="">All doctors</option>
          {filterDoctorGroups.map((group) => (
            <optgroup key={group.type} label={group.label}>
              {group.doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.code}
                  {d.active ? "" : " (inactive)"}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {isLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}
      {isError ? <p className="mt-4 text-sm text-red-700">Could not load extra sessions.</p> : null}

      {entries && entries.length === 0 ? (
        <p className="mt-4 text-sm text-ink/50">No extra sessions planned.</p>
      ) : null}

      {entries && entries.length > 0 ? (
        <table className="mt-4 min-w-full text-sm">
          <thead>
            <tr className="text-left text-ink/70">
              <th className="py-1 pr-4 font-medium">Date</th>
              <th className="py-1 pr-4 font-medium">Doctor</th>
              <th className="py-1 pr-4 font-medium">Period</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} className="border-t border-border">
                <td className="py-1 pr-4">{formatDateWithDay(entry.date)}</td>
                <td className="py-1 pr-4">{doctorsById.get(entry.doctor_id)?.code ?? entry.doctor_id}</td>
                <td className="py-1 pr-4">{entry.period}</td>
                <td className="py-1">
                  <button type="button" onClick={() => handleDeleteRow(entry.id)} className="text-xs text-red-700">
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}