import { useClinicCounters, useSystemCounters } from "@/api/counters";
import { useDoctors } from "@/api/doctors";
import type { Doctor } from "@/api/types";
import { computeWeightedScore, formatWeightedScore } from "@/lib/weightedScore";

export function CountersPage() {
  // active_only=false: a counter row can reference a since-deactivated
  // doctor (counters are never deleted when a doctor is deactivated),
  // and the weighted-score lookup needs to find them too, not just
  // active ones.
  const { data: doctors } = useDoctors(false);
  const { data: clinicCounters, isLoading: clinicLoading, isError: clinicError } = useClinicCounters();
  const { data: systemCounters, isLoading: systemLoading, isError: systemError } = useSystemCounters();

  const doctorsById = new Map((doctors ?? []).map((d) => [d.id, d]));

  function weightedFor(doctorId: number, rawCount: number): string {
    const doctor: Doctor | undefined = doctorsById.get(doctorId);
    return formatWeightedScore(computeWeightedScore(rawCount, doctor));
  }

  return (
    <div>
      <h1 className="text-lg font-semibold">Counters</h1>
      <p className="mt-1 text-sm text-ink/50">
        Values are live: the committed baseline plus any in-progress draft's increments and edits.
      </p>

      <h2 className="mt-6 text-sm font-semibold">Clinic counters</h2>
      {clinicLoading ? <p className="mt-2 text-sm text-ink/70">Loading...</p> : null}
      {clinicError ? <p className="mt-2 text-sm text-red-700">Could not load clinic counters.</p> : null}
      {clinicCounters && clinicCounters.length === 0 ? (
        <p className="mt-2 text-sm text-ink/50">No clinic counters yet.</p>
      ) : null}
      {clinicCounters && clinicCounters.length > 0 ? (
        <table aria-label="Clinic counters" className="mt-2 min-w-full text-sm">
          <thead>
            <tr className="text-left text-ink/70">
              <th className="py-1 pr-4 font-medium">Doctor</th>
              <th className="py-1 pr-4 font-medium">Clinic type</th>
              <th className="py-1 pr-4 font-medium">Raw count</th>
              <th className="py-1 pr-4 font-medium">Weighted score</th>
            </tr>
          </thead>
          <tbody>
            {clinicCounters.map((c) => (
              <tr key={c.id} className="border-t border-border">
                <td className="py-1 pr-4">{c.doctor_code}</td>
                <td className="py-1 pr-4">{c.clinic_type_name}</td>
                <td className="py-1 pr-4">{c.raw_count}</td>
                <td className="py-1 pr-4">{weightedFor(c.doctor_id, c.raw_count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <h2 className="mt-6 text-sm font-semibold">System counters</h2>
      {systemLoading ? <p className="mt-2 text-sm text-ink/70">Loading...</p> : null}
      {systemError ? <p className="mt-2 text-sm text-red-700">Could not load system counters.</p> : null}
      {systemCounters && systemCounters.length === 0 ? (
        <p className="mt-2 text-sm text-ink/50">No system counters yet.</p>
      ) : null}
      {systemCounters && systemCounters.length > 0 ? (
        <table aria-label="System counters" className="mt-2 min-w-full text-sm">
          <thead>
            <tr className="text-left text-ink/70">
              <th className="py-1 pr-4 font-medium">Doctor</th>
              <th className="py-1 pr-4 font-medium">Counter type</th>
              <th className="py-1 pr-4 font-medium">Raw count</th>
              <th className="py-1 pr-4 font-medium">Weighted score</th>
            </tr>
          </thead>
          <tbody>
            {systemCounters.map((c) => (
              <tr key={c.id} className="border-t border-border">
                <td className="py-1 pr-4">{c.doctor_code}</td>
                <td className="py-1 pr-4">{c.counter_type}</td>
                <td className="py-1 pr-4">{c.raw_count}</td>
                <td className="py-1 pr-4">{weightedFor(c.doctor_id, c.raw_count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}