import { useState } from "react";
import type { FormEvent } from "react";

import { useDoctors } from "@/api/doctors";
import { useCreateExtraSession, useDeleteExtraSession, useExtraSessions } from "@/api/extraSessions";
import { useActiveStaging } from "@/api/staging";
import type { ApiError, ExtraSessionEntry, Period } from "@/api/types";
import { useWriteGate } from "@/auth/AuthContext";
import { useSessionYear } from "@/components/SessionManagementTabs";
import { formatDateWithDay, parseLocalDate } from "@/lib/date";

/**
 * Planned one-off extra sessions, as a section of the Individual Leave tab
 * rather than a tab of its own. Most doctors have one or two extra sessions
 * a year, which never justified a fifth tab; sitting them under the same
 * doctor filter and the same year as leave also puts the two halves of "when
 * is this doctor in" on one screen, and lets the year calendar show both.
 *
 * It deliberately has no doctor select of its own - the Individual Leave
 * tab has a single doctor control that drives this section's list *and*
 * its add form, so nothing on the tab can end up describing a different
 * doctor from anything else on it.
 */

function errorDetail(err: unknown, fallback: string): string {
  const apiErr = err as ApiError | undefined;
  if (apiErr && typeof apiErr.detail === "string") {
    return apiErr.detail;
  }
  return fallback;
}

/**
 * True for a Saturday or Sunday. Mirrors the server's weekday-only rule
 * client-side, so the server's own 422 is never the first line of
 * defence - same reasoning as MAX_RANGE_DAYS in LeavePage.tsx.
 */
function isWeekend(dateString: string): boolean {
  const day = parseLocalDate(dateString).getDay();
  return day === 0 || day === 6;
}

export interface ExtraSessionsSectionProps {
  /** The Individual Leave tab's selected doctor, or null for all doctors. */
  doctorId: number | null;
  /**
   * Whether a new session may be planned for that doctor - false for "All
   * doctors" and for an inactive one. The tab owns this rule so leave and
   * extra sessions answer it the same way.
   */
  canAdd: boolean;
}

export function ExtraSessionsSection({ doctorId, canAdd }: ExtraSessionsSectionProps) {
  const writeGate = useWriteGate();
  // Reads against *all* doctors (including inactive), same reasoning as
  // LeavePage's select: a deactivated doctor's historical entries should
  // still be listed here.
  const { data: allDoctors } = useDoctors(false);
  const doctorsById = new Map((allDoctors ?? []).map((d) => [d.id, d]));

  const { year } = useSessionYear();
  const { data: entries, isLoading, isError } = useExtraSessions(doctorId, year);
  const createExtraSession = useCreateExtraSession();
  const deleteExtraSession = useDeleteExtraSession();

  // the override runs once at staging-create time, so changes made here
  // never affect a staging already in progress. This banner states that
  // plainly rather than leaving the admin to discover it the hard way.
  const { data: activeStaging } = useActiveStaging();

  const [date, setDate] = useState("");
  const [period, setPeriod] = useState<Period>("AM");
  const [formError, setFormError] = useState<string | null>(null);
  const [formSummary, setFormSummary] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setFormSummary(null);

    if (doctorId === null || !canAdd) {
      setFormError("Choose an active doctor above to plan an extra session.");
      return;
    }
    if (!date) {
      setFormError("Doctor and date are required.");
      return;
    }
    if (isWeekend(date)) {
      setFormError(`${date} is a weekend; extra sessions can only be planned on weekdays.`);
      return;
    }

    try {
      await createExtraSession.mutateAsync({ doctor_id: doctorId, date, period });
      // The date typed here is deliberately not clamped to the selected year;
      // when it falls outside it, the new row will not appear in the list
      // below, so the message says where it did go. The doctor can no longer
      // hide a new row this way - the list and this form share one select.
      const addedYear = date.slice(0, 4);
      setFormSummary(
        addedYear !== String(year)
          ? `Added in ${addedYear} - switch the year to see it.`
          : "Extra session added.",
      );
      setDate("");
    } catch (err) {
      // Surfaces the server's 409 leave-conflict message verbatim
      // alongside any other server-side rejection.
      setFormError(errorDetail(err, "Could not add this extra session."));
    }
  }

  function handleDeleteRow(id: number) {
    deleteExtraSession.mutate(id);
  }

  const pending = createExtraSession.isPending;

  return (
    <section className="mt-8 border-t border-border pt-4" data-testid="extra-sessions-section">
      <h2 className="text-sm font-semibold">Extra sessions</h2>

      {activeStaging ? (
        <div className="mt-2 rounded border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900">
          A staging is currently in progress. Changes to extra sessions will not affect it - only
          extra sessions planned before a staging is created are applied to it.
        </div>
      ) : null}

      <form
        onSubmit={handleSubmit}
        className="mt-2 flex flex-wrap items-end gap-2 rounded border border-border p-3"
      >
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
          disabled={pending || !canAdd}
          className="rounded bg-accent px-4 py-1 text-sm font-medium text-white disabled:opacity-50"
          {...writeGate}
        >
          Add extra session
        </button>
        {!canAdd ? (
          <p className="w-full text-xs text-ink/50">
            {doctorId === null
              ? "Choose a doctor above to plan an extra session."
              : "This doctor is inactive - extra sessions cannot be planned for them."}
          </p>
        ) : null}
      </form>
      {formError ? <p className="mt-2 text-sm text-red-700">{formError}</p> : null}
      {formSummary ? <p className="mt-2 text-sm text-ink/70">{formSummary}</p> : null}

      {isLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}
      {isError ? <p className="mt-4 text-sm text-red-700">Could not load extra sessions.</p> : null}

      {entries && entries.length === 0 ? (
        <p className="mt-4 text-sm text-ink/50">No extra sessions planned in {year}.</p>
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
            {entries.map((entry: ExtraSessionEntry) => (
              <tr key={entry.id} className="border-t border-border">
                <td className="py-1 pr-4">{formatDateWithDay(entry.date)}</td>
                <td className="py-1 pr-4">
                  {doctorsById.get(entry.doctor_id)?.code ?? entry.doctor_id}
                </td>
                <td className="py-1 pr-4">{entry.period}</td>
                <td className="py-1">
                  <button
                    type="button"
                    onClick={() => handleDeleteRow(entry.id)}
                    className="text-xs text-red-700 disabled:opacity-50"
                    {...writeGate}
                  >
                    Delete extra session
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
