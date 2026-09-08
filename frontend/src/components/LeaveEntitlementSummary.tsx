import type { LeaveEntitlement } from "@/api/types";

/**
 * One doctor's leave entitlement and usage for one leave year (1 Jan - 31
 * Dec), shown on the Individual Leave tab beside the year calendar.
 *
 * Deliberately a single line rather than the full-practice table this
 * replaced: the tab is about one doctor at a time, and a whole-practice
 * breakdown above it was reading as noise. Everything is a *fraction of
 * sessions used out of entitlement* ("7/49") - one session is one AM or PM
 * half day, which is the unit leave is booked in.
 *
 * Read-only. The entitlement rules (7 weeks for a partner, 6 for salaried
 * and trainee doctors, weighted by the doctor's sessions per week and
 * pro-rated by their employment window) are computed server-side, along
 * with any stored override, carry-over or adjustment; there is no editing
 * surface for those yet, so a doctor who carries one says so rather than
 * leaving an unexplained figure.
 *
 * "Used" is the *chargeable* count, not the number of booked slots: a slot
 * the doctor was never due to work (no surgery that session, a practice
 * closure, a weekend) does not charge, which is how bank holidays come out
 * free without being modelled separately.
 *
 * The sessions-mismatch warning that used to live here now sits on the
 * Staff tab, next to the sessions/week field it is actually about.
 * Sessions booked with no master template row stay here, because they
 * explain *this* screen's number: they do not charge, so a doctor whose
 * template was never populated shows a suspiciously low "used".
 */

export interface LeaveEntitlementSummaryProps {
  year: number;
  /** The selected doctor's row, or null when there is none (AHP, locum, still loading). */
  row: LeaveEntitlement | null;
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

/** Why this doctor's entitlement is not simply the rule figure. Empty when it is. */
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

export function LeaveEntitlementSummary({
  year,
  row,
  isLoading = false,
  isError = false,
}: LeaveEntitlementSummaryProps) {
  if (isLoading) {
    return (
      <p className="text-sm text-ink/70" data-testid="leave-entitlement">
        Loading leave entitlement...
      </p>
    );
  }
  if (isError) {
    return (
      <p className="text-sm text-red-700" data-testid="leave-entitlement">
        Could not load leave entitlement.
      </p>
    );
  }
  if (row === null) {
    // AHPs and locums have no entitlement to report, so there is nothing
    // honest to put here - better an absent line than a row of dashes.
    return null;
  }

  const remaining = Number(row.remaining_sessions ?? 0);
  const notes = adjustmentNotes(row);

  return (
    <section className="text-sm" data-testid="leave-entitlement">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-semibold">Leave {year}:</span>
        <span
          className={`font-semibold tabular-nums ${remaining < 0 ? "text-red-700" : ""}`}
          data-testid={`leave-fraction-${row.doctor_code}`}
        >
          {row.used_sessions}/{formatSessions(row.entitlement_sessions)}
        </span>
        <span className="text-xs text-ink/50">
          sessions used
          {row.remaining_sessions !== null
            ? ` (${formatSessions(row.remaining_sessions)} remaining)`
            : ""}
        </span>
      </div>

      {notes.length > 0 ? (
        <p className="mt-1 text-xs text-ink/60">{notes.join("; ")}</p>
      ) : null}

      {row.exempt_by_reason.no_template_row > 0 ? (
        <p className="mt-1 text-xs text-amber-700">
          ⚠ {row.exempt_by_reason.no_template_row} sessions booked against slots with no master
          template row. Those do not charge, so this "used" figure is artificially low until the
          template is filled in.
        </p>
      ) : null}
    </section>
  );
}
