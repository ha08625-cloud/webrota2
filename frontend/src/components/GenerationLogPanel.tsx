import * as Dialog from "@radix-ui/react-dialog";
import { useMemo, useState } from "react";

import { useDoctors } from "@/api/doctors";
import { useRotaLog } from "@/api/rota";
import type { GenerationLogEntry } from "@/api/types";

interface GenerationLogPanelProps {
  rotaId: number;
}

/**
 * Human-readable phase labels for the filter dropdown, matching the
 * `phase` string values DecisionLogEntry/ValidationIssue both use
 * (datatypes.py). Only the five decision-logging phases appear here -
 * Phase 0/2/12 never log decisions (see the decision-log ticket's Scope).
 */
const PHASE_OPTIONS: { value: string; label: string }[] = [
  { value: "phase4", label: "Phase 4 duty" },
  { value: "phase5", label: "Phase 5 clinics" },
  { value: "phase7_9a", label: "Phases 7-9A rooms" },
  { value: "phase9b", label: "Phase 9B swaps" },
  { value: "phase9c", label: "Phase 9C supervision" },
];

const RUN_LEVEL_LABEL = "Run-level";

interface EntryGroup {
  key: string;
  label: string;
  entries: GenerationLogEntry[];
}

/**
 * Groups the already sequence-ordered entries under `Week {n} — {Day}`
 * headers, in first-appearance order. Entries with `week === null` (none
 * currently produced, but the type allows it) are collected separately
 * and appended last under a trailing "Run-level" header, regardless of
 * where they appeared in sequence order.
 */
function groupByWeekDay(entries: GenerationLogEntry[]): EntryGroup[] {
  const groups = new Map<string, EntryGroup>();
  const runLevel: GenerationLogEntry[] = [];

  for (const entry of entries) {
    if (entry.week === null) {
      runLevel.push(entry);
      continue;
    }
    const key = `${entry.week}-${entry.day ?? ""}`;
    const existing = groups.get(key);
    if (existing) {
      existing.entries.push(entry);
    } else {
      groups.set(key, {
        key,
        label: entry.day ? `Week ${entry.week} — ${entry.day}` : `Week ${entry.week}`,
        entries: [entry],
      });
    }
  }

  const result = [...groups.values()];
  if (runLevel.length > 0) {
    result.push({ key: RUN_LEVEL_LABEL, label: RUN_LEVEL_LABEL, entries: runLevel });
  }
  return result;
}

/**
 * Modal over GET /rota/{id}/log (decision-log ticket, Task 5), opened by
 * a button in the rota toolbar. It used to be an inline collapsed panel
 * beside the grid, but even collapsed it claimed horizontal space and
 * narrowed the rota, so it is now a dialog: the trigger keeps the entry
 * count visible, and the log itself gets the full dialog width rather
 * than a sidebar column. Unlike IssuesPanel, which is small enough to
 * show unfiltered, a full 4-week run produces several hundred entries,
 * so phase and doctor filtering are functional requirements, not
 * conveniences.
 */
export function GenerationLogPanel({ rotaId }: GenerationLogPanelProps) {
  const { data: entries, isLoading, isError } = useRotaLog(rotaId);
  const { data: doctors } = useDoctors();
  const [open, setOpen] = useState(false);
  const [phaseFilter, setPhaseFilter] = useState<string>("all");
  const [doctorFilter, setDoctorFilter] = useState<string>("all");

  const doctorCodeById = useMemo(() => {
    const map = new Map<number, string>();
    for (const doctor of doctors ?? []) {
      map.set(doctor.id, doctor.code);
    }
    return map;
  }, [doctors]);

  const doctorOptions = useMemo(() => {
    const ids = new Set<number>();
    for (const entry of entries ?? []) {
      if (entry.doctor_id !== null) ids.add(entry.doctor_id);
      if (entry.related_doctor_id !== null) ids.add(entry.related_doctor_id);
    }
    return [...ids].sort((a, b) => a - b);
  }, [entries]);

  const filtered = useMemo(() => {
    return (entries ?? []).filter((entry) => {
      if (phaseFilter !== "all" && entry.phase !== phaseFilter) {
        return false;
      }
      if (doctorFilter !== "all") {
        const id = Number(doctorFilter);
        if (entry.doctor_id !== id && entry.related_doctor_id !== id) {
          return false;
        }
      }
      return true;
    });
  }, [entries, phaseFilter, doctorFilter]);

  const groups = useMemo(() => groupByWeekDay(filtered), [filtered]);
  const count = entries?.length ?? 0;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className="rounded border border-border px-3 py-1.5 text-sm font-medium text-ink">
        Generation log ({count} entries)
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-ink/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 max-h-[85vh] w-[48rem] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded bg-surface p-5 shadow-lg">
          <div className="flex items-start justify-between gap-4">
            <Dialog.Title className="text-base font-semibold text-ink">
              Generation log ({count} entries)
            </Dialog.Title>
            <Dialog.Close className="rounded border border-border px-2 py-1 text-xs font-medium text-ink">
              Close
            </Dialog.Close>
          </div>

          <div className="mt-3">
            {isLoading ? (
              <p className="text-sm text-ink/70">Loading generation log...</p>
            ) : isError ? (
              <p className="text-sm text-red-700">Could not load the generation log.</p>
            ) : count === 0 ? (
              <p className="text-sm text-ink/50">No generation log entries.</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-4">
                  <label className="text-xs text-ink/70">
                    Phase{" "}
                    <select
                      value={phaseFilter}
                      onChange={(e) => setPhaseFilter(e.target.value)}
                      className="ml-1 rounded border border-border px-1 py-0.5 text-xs"
                    >
                      <option value="all">All</option>
                      {PHASE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-ink/70">
                    Doctor{" "}
                    <select
                      value={doctorFilter}
                      onChange={(e) => setDoctorFilter(e.target.value)}
                      className="ml-1 rounded border border-border px-1 py-0.5 text-xs"
                    >
                      <option value="all">All</option>
                      {doctorOptions.map((id) => (
                        <option key={id} value={id}>
                          {doctorCodeById.get(id) ?? `id=${id}`}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {filtered.length === 0 ? (
                  <p className="mt-2 text-sm text-ink/50">No entries match the current filters.</p>
                ) : (
                  <ul className="mt-2 space-y-3">
                    {groups.map((group) => (
                      <li key={group.key}>
                        <h3 className="text-xs font-semibold text-ink/70">{group.label}</h3>
                        <ul className="mt-1 space-y-1 pl-2">
                          {group.entries.map((entry) => (
                            <li key={entry.sequence} className="text-xs text-ink/80">
                              <span className="mr-1 rounded bg-ink/5 px-1 text-[10px] text-ink/50">
                                {entry.phase} · {entry.action}
                              </span>
                              {entry.message}
                              {entry.rationale ? (
                                <details className="mt-0.5">
                                  <summary className="cursor-pointer text-[10px] text-ink/50">
                                    Why
                                  </summary>
                                  {/* Pre-wrapped, not parsed: the engine writes one
                                      line per stage of the decision and the panel
                                      shows exactly those lines. */}
                                  <pre className="mt-0.5 whitespace-pre-wrap border-l-2 border-border pl-2 font-sans text-[11px] text-ink/70">
                                    {entry.rationale}
                                  </pre>
                                </details>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
