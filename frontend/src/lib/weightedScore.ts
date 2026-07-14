import type { Doctor } from "@/api/types";

export type WeightedScoreResult =
  | { kind: "value"; value: number }
  | { kind: "infinite" }
  | { kind: "unknown" };

/**
 * Mirrors engine.datatypes.CounterState.weighted_clinic_score /
 * weighted_system_score exactly: `raw / sessions_per_week`, with
 * sessions_per_week == 0 treated as Infinity (a doctor with zero
 * sessions scores as maximally loaded and is never preferred for
 * allocation) - not as "no data". A missing doctor (the join failed -
 * shouldn't happen with active_only=false, but a counter row
 * referencing an id not in the doctors list shouldn't crash the row) is
 * the genuine "no data" case, kept as a separate `unknown` result so the
 * two situations aren't conflated in the UI.
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
  
  // Multiply by 10 for better UI readability
  return { kind: "value", value: (rawCount / spw) * 10 };
}

export function formatWeightedScore(result: WeightedScoreResult): string {
  switch (result.kind) {
    case "unknown":
      return "-";
    case "infinite":
      return "\u221e";
    case "value":
      return result.value.toFixed(2);
  }
}