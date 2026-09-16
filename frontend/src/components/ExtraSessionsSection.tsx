import { useState } from "react";
import type { FormEvent } from "react";

import { useDoctors } from "@/api/doctors";
import {
  useCreateExtraSession,
  useDeleteExtraSession,
  useExtraSessions,
  useUpdateExtraSession,
} from "@/api/extraSessions";
import { useActiveStaging } from "@/api/staging";
import type {
  ApiError,
  DoctorType,
  ExtraSessionCompensation,
  ExtraSessionEntry,
  Period,
} from "@/api/types";
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
 * doctor from anything else on it. It fetches no leave or blocked rows of
 * its own either: the slots behind the superseded flag come in as props.
 *
 * **Compensation** is set on the add form and correctable in place from the
 * table, since "this one's going to be TOIL after all" is an ordinary edit
 * and every row predating the column reads as Payment. A TOIL session
 * credits +1 to that doctor's leave entitlement for the year, so the
 * balance line beside this section moves when one is added, deleted or
 * re-compensated.
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

/**
 * Doctor types with an annual leave entitlement for a TOIL credit to land
 * in - the three keys of LEAVE_WEEKS_BY_DOCTOR_TYPE in
 * `app/leave_entitlement.py`. Locums are engaged per session, and AHP and
 * nurse leave is assigned by a third party, so the server 422s a TOIL
 * session for any of them; mirrored here so its 422 is never the first
 * line of defence, same reasoning as isWeekend above.
 */
function canTakeToil(doctorType: DoctorType | undefined): boolean {
  // Undefined is "the doctors query has not answered yet", not "no
  // entitlement": disabling the option and stating a reason during that
  // window would flash a claim about the doctor that is not known to be
  // true. The server's 422 is the backstop for the fraction of a second it
  // is open.
  if (doctorType === undefined) return true;
  return doctorType === "Partner" || doctorType === "Salaried" || doctorType === "Trainee";
}

/**
 * One doctor's one slot, as the key both superseded sets are built on.
 * Exported because the sets are built by the tab above, from its leave and
 * blocked rows, and the two sides must agree on the key. The doctor is in
 * it because the tab's "All doctors" option lists every doctor's sessions
 * at once.
 */
export function extraSessionSlotKey(doctorId: number, date: string, period: Period): string {
  return `${doctorId}|${date}|${period}`;
}

/**
 * Why a planned session is not going to be worked, or null when it is.
 *
 * Computed client-side from the leave and blocked rows the tab already
 * holds, rather than from a new server field. The other two reasons the
 * server withholds a TOIL credit for - a practice closure, and a shortened
 * employment window - are deliberately *not* reproduced here: neither is on
 * this page, and fetching them to re-implement the server's predicate in
 * TypeScript would put the rule in two places. The aggregate counts on the
 * balance line carry those. This flag answers "why is this row greyed
 * out"; the summary answers "why is my total not what I expected".
 */
function supersededBy(
  entry: ExtraSessionEntry,
  leaveSlots: ReadonlySet<string>,
  blockedSlots: ReadonlySet<string>,
): "leave" | "blocked" | null {
  const key = extraSessionSlotKey(entry.doctor_id, entry.date, entry.period);
  // Leave first, matching the server's own precedence order.
  if (leaveSlots.has(key)) return "leave";
  if (blockedSlots.has(key)) return "blocked";
  return null;
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
  /**
   * The (date, period) slots the listed doctors have leave or a blocked row
   * on, for the superseded flag on each row. Passed in rather than fetched
   * here, so this component keeps having no data-fetching of its own - the
   * tab already holds the leave rows, and it is the tab that adds the
   * blocked read.
   */
  leaveSlots?: ReadonlySet<string>;
  blockedSlots?: ReadonlySet<string>;
}

export function ExtraSessionsSection({
  doctorId,
  canAdd,
  leaveSlots = new Set<string>(),
  blockedSlots = new Set<string>(),
}: ExtraSessionsSectionProps) {
  const writeGate = useWriteGate();
  // Reads against *all* doctors (including inactive), same reasoning as
  // LeavePage's select: a deactivated doctor's historical entries should
  // still be listed here.
  const { data: allDoctors } = useDoctors(false);
  const doctorsById = new Map((allDoctors ?? []).map((d) => [d.id, d]));

  const { year } = useSessionYear();
  const { data: entries, isLoading, isError } = useExtraSessions(doctorId, year);
  const createExtraSession = useCreateExtraSession();
  const updateExtraSession = useUpdateExtraSession();
  const deleteExtraSession = useDeleteExtraSession();

  // the override runs once at staging-create time, so changes made here
  // never affect a staging already in progress. This banner states that
  // plainly rather than leaving the admin to discover it the hard way.
  const { data: activeStaging } = useActiveStaging();

  const [date, setDate] = useState("");
  const [period, setPeriod] = useState<Period>("AM");
  const [compensation, setCompensation] = useState<ExtraSessionCompensation>("Payment");
  const [formError, setFormError] = useState<string | null>(null);
  const [formSummary, setFormSummary] = useState<string | null>(null);
  // The inline compensation selects PATCH one row at a time and fail one
  // row at a time, so the error is held per row rather than in the form's
  // single message.
  const [rowError, setRowError] = useState<string | null>(null);

  const selectedDoctor = doctorId === null ? null : (doctorsById.get(doctorId) ?? null);
  // TOIL is a per-doctor question, and this list can span doctors ("All
  // doctors"): the form answers it for the selected doctor, each table row
  // for its own.
  const addToilAllowed = canTakeToil(selectedDoctor?.doctor_type);

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
    if (compensation === "TOIL" && !addToilAllowed) {
      setFormError(
        `${selectedDoctor?.doctor_type ?? "This"} doctors have no leave entitlement, so a session cannot be taken in lieu.`,
      );
      return;
    }

    try {
      await createExtraSession.mutateAsync({ doctor_id: doctorId, date, period, compensation });
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

  async function handleCompensationChange(id: number, next: ExtraSessionCompensation) {
    setRowError(null);
    try {
      await updateExtraSession.mutateAsync({ id, compensation: next });
    } catch (err) {
      setRowError(errorDetail(err, "Could not change how this session is compensated."));
    }
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
        <div>
          <label
            className="block text-xs font-medium text-ink/70"
            htmlFor="extra-session-compensation"
          >
            Compensation
          </label>
          <select
            id="extra-session-compensation"
            value={compensation}
            onChange={(e) => setCompensation(e.target.value as ExtraSessionCompensation)}
            className="mt-1 rounded border border-border p-1 text-sm"
          >
            <option value="Payment">Payment</option>
            <option value="TOIL" disabled={!addToilAllowed}>
              TOIL
            </option>
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
        {canAdd && !addToilAllowed ? (
          <p className="w-full text-xs text-ink/50">
            {`${selectedDoctor?.doctor_type} doctors have no leave entitlement, so a session cannot be taken in lieu - Payment only.`}
          </p>
        ) : null}
        {canAdd && addToilAllowed ? (
          <p className="w-full text-xs text-ink/50">
            TOIL credits one session to this doctor's leave entitlement for the year the session
            falls in. Payment records the decision only - no amount is held anywhere in the app.
          </p>
        ) : null}
      </form>
      {formError ? <p className="mt-2 text-sm text-red-700">{formError}</p> : null}
      {formSummary ? <p className="mt-2 text-sm text-ink/70">{formSummary}</p> : null}

      {rowError ? <p className="mt-2 text-sm text-red-700">{rowError}</p> : null}

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
              <th className="py-1 pr-4 font-medium">Compensation</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry: ExtraSessionEntry) => {
              const rowDoctor = doctorsById.get(entry.doctor_id);
              const rowToilAllowed = canTakeToil(rowDoctor?.doctor_type);
              const superseded = supersededBy(entry, leaveSlots, blockedSlots);
              return (
              <tr
                key={entry.id}
                className={`border-t border-border ${superseded !== null ? "text-ink/40" : ""}`}
              >
                <td className="py-1 pr-4">{formatDateWithDay(entry.date)}</td>
                <td className="py-1 pr-4">{rowDoctor?.code ?? entry.doctor_id}</td>
                <td className="py-1 pr-4">{entry.period}</td>
                <td className="py-1 pr-4">
                  <select
                    aria-label={`Compensation for ${entry.date} ${entry.period}`}
                    value={entry.compensation}
                    onChange={(e) =>
                      handleCompensationChange(
                        entry.id,
                        e.target.value as ExtraSessionCompensation,
                      )
                    }
                    className="rounded border border-border p-1 text-sm"
                    {...writeGate}
                  >
                    <option value="Payment">Payment</option>
                    <option value="TOIL" disabled={!rowToilAllowed}>
                      TOIL
                    </option>
                  </select>
                  {superseded !== null ? (
                    <span className="ml-2 text-xs">
                      {superseded === "leave" ? "superseded by leave" : "blocked"}
                      {entry.compensation === "TOIL" ? " - not credited" : ""}
                    </span>
                  ) : null}
                </td>
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
              );
            })}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
