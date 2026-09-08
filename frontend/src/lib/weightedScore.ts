import type { Doctor } from "@/api/types";

export type WeightedScoreResult =
  | { kind: "value"; value: number }
  | { kind: "infinite" }
  | { kind: "unknown" };

/**
 * Display-only variant of engine.datatypes.CounterState.weighted_clinic_score /
 * weighted_system_score: `(raw / sessions_per_week) * 10`, with
 * sessions_per_week == 0 treated as Infinity (a doctor with zero
 * sessions scores as maximally loaded and is never preferred for
 * allocation) - not as "no data". A missing doctor (the join failed -
 * shouldn't happen with active_only=false, but a counter row
 * referencing an id not in the doctors list shouldn't crash the row) is
 * the genuine "no data" case, kept as a separate `unknown` result so the
 * two situations aren't conflated in the UI.
 *
 * The x10 scaling is purely cosmetic, to make small values more
 * readable in the counters/duty panels. It has no bearing on the
 * engine's actual tie-breaking score (`raw / sessions_per_week`,
 * unscaled) - the engine never reads this value, so relative ordering
 * between doctors is what matters there, and a constant multiplier
 * preserves that ordering exactly. Do not use this function's output
 * anywhere that needs to match the engine's own score.
 *
 * `sessionsPerWeek` on the wire is a JSON string (Decimal
 * serialisation, e.g. "10.0" - see Doctor.sessions_per_week), so this
 * parses it rather than dividing by the string directly.
 */
export function computeWeightedScore(rawCount: number, doctor: Doctor | undefined): WeightedScoreResult {
  if (!doctor) {
    return { kind: "unknown" };
  }
  const spw = Number(doctor.sessions_per_week);
  if (spw === 0) {
    return { kind: "infinite" };
  }
  return { kind: "value", value: (rawCount / spw) * 10 };
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