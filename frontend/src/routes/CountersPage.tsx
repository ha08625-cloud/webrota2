import { useState } from "react";

import {
  useClinicCounters,
  useResetAllClinicCounters,
  useResetAllSystemCounters,
  useResetClinicCounter,
  useResetSystemCounter,
  useSystemCounters,
} from "@/api/counters";
import { useClinicTypes } from "@/api/clinicTypes";
import { useDoctors } from "@/api/doctors";
import { useRotaList } from "@/api/rota";
import type { ClinicCounter, ClinicType, Doctor } from "@/api/types";
import { useWriteGate } from "@/auth/AuthContext";
import { computeWeightedScore, formatWeightedScore } from "@/lib/weightedScore";

// Appended to a base confirm message whenever a draft rota is active.
// Must say scrapping *undoes* the reset (restores pre-generation values),
// never that scrap "corrects" or "fixes" counters toward the reset.
const DRAFT_WARNING =
  " Note: a draft rota is currently active. If that draft is scrapped, all counters will be restored to their pre-generation values and this reset will be undone. To make the reset permanent, commit or scrap the draft first.";

// Same order the generation engine iterates clinic types in (Phase 5):
// clinic_priority ascending, then id ascending as a tiebreak. Using this
// for the tab order (rather than alphabetical) means the tab layout
// matches the order doctors already see on the clinic types admin page.
function sortByClinicPriority(clinicTypes: ClinicType[]): ClinicType[] {
  return [...clinicTypes].sort((a, b) => a.clinic_priority - b.clinic_priority || a.id - b.id);
}

export function CountersPage() {
  const writeGate = useWriteGate();
  // active_only=false: a counter row can reference a since-deactivated
  // doctor (counters are never deleted when a doctor is deactivated),
  // and the weighted-score lookup needs to find them too, not just
  // active ones.
  const { data: doctors } = useDoctors(false);
  const { data: clinicCounters, isLoading: clinicLoading, isError: clinicError } = useClinicCounters();
  const { data: systemCounters, isLoading: systemLoading, isError: systemError } = useSystemCounters();
  // Clinic types drive the tab bar itself (not just the counters that
  // happen to exist), so a clinic with zero counters still gets a tab,
  // and the tabs still appear even before generation has run at all.
  // Deletion is blocked server-side while a clinic type has any counter
  // rows (see routers_clinic_types.py), so every counter's clinic_type_id
  // is guaranteed to still be present in this list.
  const { data: clinicTypes, isLoading: clinicTypesLoading, isError: clinicTypesError } = useClinicTypes();
  // Loading/error states are deliberately not surfaced here: a draft
  // rota is the only thing this hook feeds into (the confirm-message
  // warning), and if the list can't be determined the safer default is
  // to fall through to the plain warning rather than block resets.
  const { data: rotas } = useRotaList();

  const resetClinicCounter = useResetClinicCounter();
  const resetSystemCounter = useResetSystemCounter();
  const resetAllClinicCounters = useResetAllClinicCounters();
  const resetAllSystemCounters = useResetAllSystemCounters();

  const [activeClinicTypeId, setActiveClinicTypeId] = useState<number | null>(null);

  const draftActive = (rotas ?? []).some((r) => r.status === "draft");

  const doctorsById = new Map((doctors ?? []).map((d) => [d.id, d]));

  const sortedClinicTypes = sortByClinicPriority(clinicTypes ?? []);

  const clinicCountersByTypeId = new Map<number, ClinicCounter[]>();
  for (const c of clinicCounters ?? []) {
    const bucket = clinicCountersByTypeId.get(c.clinic_type_id);
    if (bucket) {
      bucket.push(c);
    } else {
      clinicCountersByTypeId.set(c.clinic_type_id, [c]);
    }
  }

  const activeClinicType = sortedClinicTypes.find((ct) => ct.id === activeClinicTypeId) ?? sortedClinicTypes[0];
  const activeClinicCounters = activeClinicType ? (clinicCountersByTypeId.get(activeClinicType.id) ?? []) : [];

  function weightedFor(doctorId: number, rawCount: number): string {
    const doctor: Doctor | undefined = doctorsById.get(doctorId);
    return formatWeightedScore(computeWeightedScore(rawCount, doctor));
  }

  function confirmMessage(base: string): string {
    return draftActive ? `${base}${DRAFT_WARNING}` : base;
  }

  function handleResetClinic(id: number) {
    if (!window.confirm(confirmMessage("Reset this counter to 0? This cannot be undone."))) {
      return;
    }
    resetClinicCounter.mutate(id);
  }

  function handleResetSystem(id: number) {
    if (!window.confirm(confirmMessage("Reset this counter to 0? This cannot be undone."))) {
      return;
    }
    resetSystemCounter.mutate(id);
  }

  function handleResetAllClinic() {
    if (
      !window.confirm(
        confirmMessage(
          "Reset ALL clinic counters to 0, including counters for doctors not shown on this page? This cannot be undone.",
        ),
      )
    ) {
      return;
    }
    resetAllClinicCounters.mutate();
  }

  function handleResetAllSystem() {
    if (
      !window.confirm(
        confirmMessage(
          "Reset ALL system counters to 0, including counters for doctors not shown on this page? This cannot be undone.",
        ),
      )
    ) {
      return;
    }
    resetAllSystemCounters.mutate();
  }

  return (
    <div>
      <h1 className="text-lg font-semibold">Counters</h1>
      <p className="mt-1 text-sm text-ink/50">
        Values are live: the committed baseline plus any in-progress draft's increments and edits. Counters can be
        reset to zero here.
      </p>

      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Clinic counters</h2>
        {clinicCounters && clinicCounters.length > 0 ? (
          <button
            type="button"
            onClick={handleResetAllClinic}
            disabled={resetAllClinicCounters.isPending}
            className="rounded border border-red-300 px-3 py-1 text-xs font-medium text-red-700 disabled:opacity-50"
            {...writeGate}
          >
            Reset all clinic counters
          </button>
        ) : null}
      </div>
      {clinicLoading || clinicTypesLoading ? <p className="mt-2 text-sm text-ink/70">Loading...</p> : null}
      {clinicError || clinicTypesError ? (
        <p className="mt-2 text-sm text-red-700">Could not load clinic counters.</p>
      ) : null}
      {resetClinicCounter.isError || resetAllClinicCounters.isError ? (
        <p className="mt-2 text-sm text-red-700">Could not reset clinic counter(s).</p>
      ) : null}
      {!clinicTypesLoading && sortedClinicTypes.length === 0 ? (
        <p className="mt-2 text-sm text-ink/50">No clinic counters yet.</p>
      ) : null}
      {sortedClinicTypes.length > 0 ? (
        <>
          <div role="tablist" aria-label="Clinic types" className="mt-3 flex flex-wrap gap-1 border-b border-border">
            {sortedClinicTypes.map((ct) => {
              const selected = ct.id === activeClinicType?.id;
              return (
                <button
                  key={ct.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setActiveClinicTypeId(ct.id)}
                  className={
                    selected
                      ? "-mb-px rounded-t border border-b-0 border-border bg-surface px-3 py-1.5 text-sm font-medium text-ink"
                      : "-mb-px rounded-t border border-transparent px-3 py-1.5 text-sm text-ink/60 hover:text-ink"
                  }
                >
                  {ct.name}
                </button>
              );
            })}
          </div>
          {activeClinicType ? (
            <div role="tabpanel" aria-label={`${activeClinicType.name} counters`}>
              {activeClinicCounters.length === 0 ? (
                <p className="mt-2 text-sm text-ink/50">No counters yet for this clinic.</p>
              ) : (
                <table aria-label="Clinic counters" className="mt-2 min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-ink/70">
                      <th className="py-1 pr-4 font-medium">Doctor</th>
                      <th className="py-1 pr-4 font-medium">Raw count</th>
                      <th className="py-1 pr-4 font-medium">Weighted score</th>
                      <th className="py-1 pr-4 font-medium"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeClinicCounters.map((c) => (
                      <tr key={c.id} className="border-t border-border">
                        <td className="py-1 pr-4">{c.doctor_code}</td>
                        <td className="py-1 pr-4">{c.raw_count}</td>
                        <td className="py-1 pr-4">{weightedFor(c.doctor_id, c.raw_count)}</td>
                        <td className="py-1 pr-4">
                          <button
                            type="button"
                            onClick={() => handleResetClinic(c.id)}
                            disabled={resetClinicCounter.isPending}
                            className="rounded border border-red-300 px-2 py-0.5 text-xs font-medium text-red-700 disabled:opacity-50"
                            {...writeGate}
                          >
                            Reset
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ) : null}
        </>
      ) : null}

      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-sm font-semibold">System counters</h2>
        {systemCounters && systemCounters.length > 0 ? (
          <button
            type="button"
            onClick={handleResetAllSystem}
            disabled={resetAllSystemCounters.isPending}
            className="rounded border border-red-300 px-3 py-1 text-xs font-medium text-red-700 disabled:opacity-50"
            {...writeGate}
          >
            Reset all system counters
          </button>
        ) : null}
      </div>
      {systemLoading ? <p className="mt-2 text-sm text-ink/70">Loading...</p> : null}
      {systemError ? <p className="mt-2 text-sm text-red-700">Could not load system counters.</p> : null}
      {resetSystemCounter.isError || resetAllSystemCounters.isError ? (
        <p className="mt-2 text-sm text-red-700">Could not reset system counter(s).</p>
      ) : null}
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
              <th className="py-1 pr-4 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {systemCounters.map((c) => (
              <tr key={c.id} className="border-t border-border">
                <td className="py-1 pr-4">{c.doctor_code}</td>
                <td className="py-1 pr-4">{c.counter_type}</td>
                <td className="py-1 pr-4">{c.raw_count}</td>
                <td className="py-1 pr-4">{weightedFor(c.doctor_id, c.raw_count)}</td>
                <td className="py-1 pr-4">
                  <button
                    type="button"
                    onClick={() => handleResetSystem(c.id)}
                    disabled={resetSystemCounter.isPending}
                    className="rounded border border-red-300 px-2 py-0.5 text-xs font-medium text-red-700 disabled:opacity-50"
                    {...writeGate}
                  >
                    Reset
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}