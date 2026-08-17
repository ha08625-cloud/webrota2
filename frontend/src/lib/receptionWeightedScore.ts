import type { ReceptionRole } from "@/api/types";

export type ReceptionWeightedScoreResult =
  | { kind: "value"; value: number }
  | { kind: "not-applicable" }
  | { kind: "unknown" };

/**
 * A sibling of weightedScore.ts, not a reuse of it. Both answer "how loaded
 * is this person", but they are different quantities computed for different
 * consumers, and the two places they differ are both deliberate:
 *
 * 1. **No x10 scaling.** This score is `role_hours / hours_worked`, a
 *    proportion of time that reads directly as "31% of Sam's working time
 *    was on phones". The clinical function's x10 exists only to make a
 *    unitless engine tie-break score readable in a panel; there is nothing
 *    to make readable here.
 *
 * 2. **Zero hours is "unknown", not infinity.** The clinical rule maps
 *    `sessions_per_week == 0` to Infinity because that value is a sort key
 *    and infinity is a real answer to "who is least loaded" - the engine
 *    must never prefer a doctor with no sessions. Here, zero hours worked
 *    means the numerator is zero too, nothing is being ordered yet, and a
 *    staff member who worked no days in the window genuinely has no data.
 *    Rendering that as an infinity sign would claim a fairness fact that
 *    does not exist.
 *
 * `not_working` gets no score at all. Its slots are counted in the
 * numerator's reach but excluded from the denominator (hours worked
 * excludes `not_working` and nothing else - see compute_role_counters),
 * so the ratio is not a proportion of anything and can exceed 100%: two
 * `phones` slots and ten `not_working` slots would read as 500%. "What
 * proportion of Sam's working time was spent not working" is not a
 * question with an answer, and inventing one would be worse than an empty
 * cell. This is the only place that rule lives - the backend returns raw
 * counts and hours and knows nothing about it.
 */
export function computeReceptionWeightedScore(
  role: ReceptionRole,
  roleSlots: number,
  hoursWorked: number,
): ReceptionWeightedScoreResult {
  if (role === "not_working") {
    return { kind: "not-applicable" };
  }
  if (hoursWorked === 0) {
    return { kind: "unknown" };
  }
  return { kind: "value", value: (roleSlots * 0.5) / hoursWorked };
}

/** Percent to whole numbers: these are proportions of a ~30-day window, and
 * a decimal place would imply a precision the underlying half-hour slots do
 * not have. Both non-value cases render as an em dash - the distinction
 * between "not a proportion of anything" and "no data" matters to the
 * caller's reasoning, not to a reader looking at one cell. */
export function formatReceptionWeightedScore(result: ReceptionWeightedScoreResult): string {
  switch (result.kind) {
    case "not-applicable":
    case "unknown":
      return "—";
    case "value":
      return `${Math.round(result.value * 100)}%`;
  }
}
