import type { Day, Doctor, Period, RotaSession } from "@/api/types";

/**
 * Frontend mirror of engine.phases.phase9c.count_supervisable_trainees
 * (Phase 9C implementation plan, section 5). The number of trainees in
 * one (week, day, period) session who need supervision: doctor_type ===
 * "Trainee", not on leave, not WFH, and template_type not in
 * ("no_surgery", "admin_time"). No room criterion - an off-site trainee
 * still counts.
 *
 * Null template_type counts as a normal session (countable). This is a
 * frontend-only case: the backend helper never sees null, because
 * grid_utils.rebuild_rota_grid() always resolves template_type to a
 * concrete MasterSessionType before Phase 12 runs. RotaSession.template_type
 * is nullable here, with null meaning "normal session" (legacy pre-M3.6
 * rows) - treating null as excluded would silently break rule parity for
 * those rows.
 */
export function countSupervisableTrainees(
  sessions: RotaSession[],
  doctors: Doctor[],
  week: number,
  day: Day,
  period: Period,
): number {
  const doctorTypeById = new Map(doctors.map((d) => [d.id, d.doctor_type]));
  let count = 0;
  for (const s of sessions) {
    if (s.week !== week || s.day !== day || s.period !== period) continue;
    if (doctorTypeById.get(s.doctor_id) !== "Trainee") continue;
    if (s.is_on_leave || s.is_wfh) continue;
    if (s.template_type === "no_surgery" || s.template_type === "admin_time") continue;
    count += 1;
  }
  return count;
}