import type { Doctor } from "@/api/types";

export type WeightedScoreResult =
  | { kind: "value"; value: number }
  | { kind: "infinite" }
  | { kind: "unknown" };

/**
 * Display-only variant of engine.datatypes.CounterState.weighted_clinic_score /
 * weighted_system_score: `((raw + adjustment) / sessions_per_week) * 10`,
 * with sessions_per_week == 0 treated as Infinity (a doctor with zero
 * sessions scores as maximally loaded and is never preferred for
 * allocation) - not as "no data". A missing doctor (the join failed -
 * shouldn't happen with active_only=false, but a counter row
 * referencing an id not in the doctors list shouldn't crash the row) is
 * the genuine "no data" case, kept as a separate `unknown` result so the
 * two situations aren't conflated in the UI.
 *
 * The adjustment is a signed nudge in sessions for any exceptional reason
 * the raw count misrepresents a fair share - a mid-year joiner, or a
 * compassionate or long-term absence - which would otherwise read as
 * maximally under-loaded. The engine adds it the same way (see
 * CounterState.weighted_clinic_score), so this function still mirrors the
 * engine's score; that mirror relationship is load-bearing and must be
 * kept true.
 *
 * The x10 scaling is purely cosmetic, to make small values more
 * readable in the counters/duty panels. It has no bearing on the
 * engine's actual tie-breaking score (`(raw + adjustment) / sessions_per_week`,
 * unscaled) - the engine never reads this value, so relative ordering
 * between doctors is what matters there, and a constant multiplier
 * preserves that ordering exactly. Do not use this function's output
 * anywhere that needs to match the engine's own score.
 *
 * Both `sessionsPerWeek` and `adjustment` are JSON strings on the wire
 * (Decimal serialisation, e.g. "10.0" - see Doctor.sessions_per_week and
 * the counter schemas), so both are parsed rather than used directly:
 * `rawCount + adjustment` on an unparsed string would concatenate
 * instead of adding, which is a silently wrong number rather than a crash.
 * `adjustment` is a required argument for the same reason - a default
 * would let a caller drop the adjustment without noticing.
 */
export function computeWeightedScore(
  rawCount: number,
  doctor: Doctor | undefined,
  adjustment: string,
): WeightedScoreResult {
  if (!doctor) {
    return { kind: "unknown" };
  }
  const spw = Number(doctor.sessions_per_week);
  if (spw === 0) {
    return { kind: "infinite" };
  }
  return { kind: "value", value: ((rawCount + parseAdjustment(adjustment)) / spw) * 10 };
}

/**
 * An adjustment that doesn't parse (an absent field from an older response,
 * an empty string) counts as no adjustment: the score is a display value and
 * a NaN in the column would be a worse failure than showing the unadjusted
 * figure. Every adjustment the API sends is a well-formed decimal string.
 */
export function parseAdjustment(adjustment: string): number {
  const parsed = Number(adjustment);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The adjustment as it is shown next to a raw count, signed, or null when
 * there is none to show. The raw count keeps meaning "work actually done" -
 * an admin asking how much duty someone has done must not be given a number
 * inflated by an adjustment - so the adjustment is rendered beside it rather
 * than folded into it.
 */
export function formatAdjustment(adjustment: string): string | null {
  const value = parseAdjustment(adjustment);
  if (value === 0) {
    return null;
  }
  return `${value > 0 ? "+" : "-"}${Math.abs(value).toFixed(1)}`;
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
