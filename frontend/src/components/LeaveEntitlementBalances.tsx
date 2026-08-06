import type { LeaveEntitlement } from "@/api/types";

/**
 * Leave entitlement and balances for one leave year (1 Jan - 31 Dec), shown
 * at the top of the Individual Leave tab.
 *
 * Read-only. The entitlement rules (7 weeks for a partner, 6 for salaried
 * and trainee doctors, weighted by the doctor's sessions per week and
 * pro-rated by their employment window) are computed server-side, along
 * with any stored override, carry-over or adjustment; there is no editing
 * surface for those yet, so a row that carries one says so rather than
 * leaving an unexplained figure.
 *
 * Everything is counted in *sessions* - one session is one AM or PM half
 * day - never in days or weeks, because that is the unit leave is booked
 * in. "Used" is the *chargeable* count, not the number of booked slots: a
 * slot the doctor was never due to work (no surgery that session, a
 * practice closure, a weekend) does not charge, which is how bank holidays
 * come out free without being modelled separately.
 *
 * Two warnings earn their space here, both of which mean "this number is
 * not as good as it looks":
 *
 * - **Sessions mismatch.** Entitlement is credited against
 *   `sessions_per_week` but leave is charged against the master template,
 *   and when those disagree the balance accrues and burns in different
 *   units. One of the two fields is wrong and somebody has to fix it.
 * - **Sessions with no template row.** Leave booked against slots the
 *   doctor has no week-1 template row for at all. Shown distinctly rather
 *   than folded into a single "exempt" total because it usually means the
 *   master template was never populated for that doctor, which reads as a
 *   suspiciously low "used" figure and nothing else.
 */

export interface LeaveEntitlementBalancesProps {
  year: number;
  onPrevYear: () => void;
  onNextYear: () => void;
  rows: LeaveEntitlement[];
  isLoading?: boolean;
  isError?: boolean;
}

/**
 * Session counts arrive as decimal strings ("70.0", "18.1", "-1.0"). The
 * trailing ".0" is noise on a screen that is mostly whole sessions, and
 * `Number` drops it while keeping a real fraction.
 */
function formatSessions(value: string | null): string {
  if (value === null) return "-";
  const asNumber = Number(value);
  return Number.isNaN(asNumber) ? value : String(asNumber);
}

/** Why this row's entitlement is not simply the rule figure. Empty when it is. */
function adjustmentNotes(row: LeaveEntitlement): string[] {
  const notes: string[] = [];
  if (row.override_sessions !== null) {
    notes.push(`Entitlement overridden (rule: ${formatSessions(row.rule_sessions)})`);
  }
  if (Number(row.carry_over_sessions) !== 0) {
    notes.push(`Carried over: ${formatSessions(row.carry_over_sessions)}`);
  }
  if (Number(row.adjustment_sessions) !== 0) {
    notes.push(`Adjustment: ${formatSessions(row.adjustment_sessions)}`);
  }
  if (Number(row.pro_rata_fraction) < 1) {
    notes.push(`Pro-rata: ${Math.round(Number(row.pro_rata_fraction) * 100)}% of the year`);
  }
  return notes;
}

export function LeaveEntitlementBalances({
  year,
  onPrevYear,
  onNextYear,
  rows,
  isLoading = false,
  isError = false,
}: LeaveEntitlementBalancesProps) {
  const anyMismatch = rows.some((r) => r.sessions_mismatch);
  const anyMissingTemplate = rows.some((r) => r.exempt_by_reason.no_template_row > 0);

  return (
    <section className="rounded border border-border p-3" data-testid="leave-entitlement">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-semibold">Leave entitlement</h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onPrevYear}
            aria-label="Previous leave year"
            className="rounded border border-border px-2 py-0.5 text-sm"
          >
            ←
          </button>
          <span className="text-sm font-semibold">{year}</span>
          <button
            type="button"
            onClick={onNextYear}
            aria-label="Next leave year"
            className="rounded border border-border px-2 py-0.5 text-sm"
          >
            →
          </button>
        </div>
        <span className="text-xs text-ink/50">1 Jan - 31 Dec, counted in sessions</span>
      </div>

      {isLoading ? <p className="mt-2 text-sm text-ink/70">Loading...</p> : null}
      {isError ? (
        <p className="mt-2 text-sm text-red-700">Could not load leave entitlement.</p>
      ) : null}

      {!isLoading && !isError && rows.length === 0 ? (
        <p className="mt-2 text-sm text-ink/50">
          No doctors with a leave entitlement. AHPs and locums are not shown - their leave is not
          tracked here.
        </p>
      ) : null}

      {rows.length > 0 ? (
        <table className="mt-2 min-w-full text-sm">
          <thead>
            <tr className="text-left text-ink/70">
              <th className="py-1 pr-4 font-medium">Doctor</th>
              <th className="py-1 pr-4 font-medium">Sessions/wk</th>
              <th className="py-1 pr-4 font-medium">Entitlement</th>
              <th className="py-1 pr-4 font-medium">Used</th>
              <th className="py-1 pr-4 font-medium">Remaining</th>
              <th className="py-1 font-medium">Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const remaining = Number(row.remaining_sessions ?? 0);
              const notes = adjustmentNotes(row);
              return (
                <tr key={row.doctor_id} className="border-t border-border">
                  <td className="py-1 pr-4">{row.doctor_code}</td>
                  <td className="py-1 pr-4">{formatSessions(row.sessions_per_week)}</td>
                  <td className="py-1 pr-4">{formatSessions(row.entitlement_sessions)}</td>
                  <td className="py-1 pr-4">{row.used_sessions}</td>
                  <td
                    className={`py-1 pr-4 font-medium ${remaining < 0 ? "text-red-700" : ""}`}
                    data-testid={`remaining-${row.doctor_code}`}
                  >
                    {formatSessions(row.remaining_sessions)}
                  </td>
                  <td className="py-1 text-xs text-ink/60">
                    {row.sessions_mismatch ? (
                      <span className="mr-2 text-amber-700">
                        ⚠ Template implies {row.template_sessions_per_week} sessions/wk
                      </span>
                    ) : null}
                    {row.exempt_by_reason.no_template_row > 0 ? (
                      <span className="mr-2 text-amber-700">
                        ⚠ {row.exempt_by_reason.no_template_row} booked with no template row
                      </span>
                    ) : null}
                    {notes.join("; ")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}

      {anyMismatch ? (
        <p className="mt-2 text-xs text-amber-700">
          ⚠ Entitlement is credited from the doctor's sessions per week, but leave is charged
          against their master template. Where the two disagree, the balance above accrues and is
          spent in different units - correct whichever of the two is wrong.
        </p>
      ) : null}
      {anyMissingTemplate ? (
        <p className="mt-1 text-xs text-amber-700">
          ⚠ Sessions booked against slots with no master template row do not charge, so a doctor
          whose template has not been filled in will show an artificially low "used" figure.
        </p>
      ) : null}
      <p className="mt-1 text-xs text-ink/50">
        Used counts chargeable sessions only. Weekends, practice closures and no-surgery sessions
        are not charged.
      </p>
    </section>
  );
}
