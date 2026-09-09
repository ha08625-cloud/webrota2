import type { Doctor } from "@/api/types";

export type WeightedScoreResult =
  | { kind: "value"; value: number }
  | { kind: "infinite" }
  | { kind: "unknown" };

/**
 * Display-only variant of engine.datatypes.CounterState.weighted_clinic_score /
 * weighted_system_score: `((raw + opening_balance) / sessions_per_week) * 10`,
 * with sessions_per_week == 0 treated as Infinity (a doctor with zero
 * sessions scores as maximally loaded and is never preferred for
 * allocation) - not as "no data". A missing doctor (the join failed -
 * shouldn't happen with active_only=false, but a counter row
 * referencing an id not in the doctors list shouldn't crash the row) is
 * the genuine "no data" case, kept as a separate `unknown` result so the
 * two situations aren't conflated in the UI.
 *
 * The opening balance is a credit in sessions for a doctor whose count
 * does not cover the whole period the others' counts do - a mid-year
 * joiner starting every counter at zero otherwise reads as maximally
 * under-loaded. The engine adds it the same way (see the counter opening
 * balances plan), so this function still mirrors the engine's score; that
 * mirror relationship is load-bearing and must be kept true.
 *
 * The x10 scaling is purely cosmetic, to make small values more
 * readable in the counters/duty panels. It has no bearing on the
 * engine's actual tie-breaking score (`(raw + balance) / sessions_per_week`,
 * unscaled) - the engine never reads this value, so relative ordering
 * between doctors is what matters there, and a constant multiplier
 * preserves that ordering exactly. Do not use this function's output
 * anywhere that needs to match the engine's own score.
 *
 * Both `sessionsPerWeek` and `openingBalance` are JSON strings on the wire
 * (Decimal serialisation, e.g. "10.0" - see Doctor.sessions_per_week and
 * the counter schemas), so both are parsed rather than used directly:
 * `rawCount + openingBalance` on an unparsed string would concatenate
 * instead of adding, which is a silently wrong number rather than a crash.
 * `openingBalance` is a required argument for the same reason - a default
 * would let a caller drop the credit without noticing.
 */
export function computeWeightedScore(
  rawCount: number,
  doctor: Doctor | undefined,
  openingBalance: string,
): WeightedScoreResult {
  if (!doctor) {
    return { kind: "unknown" };
  }
  const spw = Number(doctor.sessions_per_week);
  if (spw === 0) {
    return { kind: "infinite" };
  }
  return { kind: "value", value: ((rawCount + parseBalance(openingBalance)) / spw) * 10 };
}

/**
 * A balance that doesn't parse (an absent field from an older response, an
 * empty string) counts as no credit: the score is a display value and a
 * NaN in the column would be a worse failure than showing the uncredited
 * figure. Every balance the API sends is a well-formed decimal string.
 */
export function parseBalance(openingBalance: string): number {
  const parsed = Number(openingBalance);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The credit as it is shown next to a raw count, signed, or null when
 * there is no credit to show. The raw count keeps meaning "work actually
 * done" - an admin asking how much duty someone has done must not be given
 * a number inflated by a credit - so the balance is rendered beside it
 * rather than folded into it.
 */
export function formatOpeningBalance(openingBalance: string): string | null {
  const balance = parseBalance(openingBalance);
  if (balance === 0) {
    return null;
  }
  return `${balance > 0 ? "+" : "-"}${Math.abs(balance).toFixed(1)}`;
}

/**
 * `decimals` defaults to 2 (the counters page). The duty grid passes 1:
 * its column is a quick "who is furthest behind" glance rather than a
 * precise figure, and the second decimal only added noise there.
 */
export function formatWeightedScore(result: WeightedScoreResult, decimals = 2): string {
  switch (result.kind) {
    case "unknown":
      return "-";
    case "infinite":
      return "\u221e";
    case "value":
      return result.value.toFixed(decimals);
  }
}
