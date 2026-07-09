import { useState } from "react";
import type { FormEvent } from "react";

import { useDoctors } from "@/api/doctors";
import { useCreateLeave, useDeleteLeave, useLeave } from "@/api/leave";
import type { Period } from "@/api/types";
import { groupDoctorsByType } from "@/lib/groupDoctors";

type PeriodChoice = Period | "BOTH";

export function LeavePage() {
  // The filter reads against *all* doctors (including inactive) - a
  // deactivated doctor's historical leave entries are still real rows
  // that should be findable here, not hidden because they're no longer
  // an active doctor.
  const { data: allDoctors } = useDoctors(false);
  // The add-row doctor select is deliberately narrower: the API will
  // happily create a leave entry for an inactive doctor (it only 404s on
  // an unknown id), but there's no legitimate reason to be adding new
  // leave for someone no longer working here.
  const activeDoctors = (allDoctors ?? []).filter((d) => d.active);

  const [filterDoctorId, setFilterDoctorId] = useState<number | null>(null);
  const { data: entries, isLoading, isError } = useLeave(filterDoctorId);
  const createLeave = useCreateLeave();
  const deleteLeave = useDeleteLeave();

  const [addDoctorId, setAddDoctorId] = useState<number | "">("");
  const [addDate, setAddDate] = useState("");
  const [addPeriod, setAddPeriod] = useState<PeriodChoice>("AM");
  const [addError, setAddError] = useState<string | null>(null);

  const doctorsById = new Map((allDoctors ?? []).map((d) => [d.id, d]));
  const filterDoctorGroups = groupDoctorsByType(allDoctors ?? []);
  const addDoctorGroups = groupDoctorsByType(activeDoctors);

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    setAddError(null);
    if (addDoctorId === "" || !addDate) {
      setAddError("Doctor and date are required.");
      return;
    }
    const doctorId = addDoctorId;
    const periods: Period[] = addPeriod === "BOTH" ? ["AM", "PM"] : [addPeriod];

    const results = await Promise.allSettled(
      periods.map((period) => createLeave.mutateAsync({ doctor_id: doctorId, date: addDate, period })),
    );

    const failures = results
      .map((r, i) => ({ r, period: periods[i] }))
      .filter((x): x is { r: PromiseRejectedResult; period: Period } => x.r.status === "rejected");

    if (failures.length > 0) {
      const messages = failures.map(({ r, period }) => {
        const err = r.reason as { detail?: unknown } | undefined;
        const detail = typeof err?.detail === "string" ? err.detail : "could not be added";
        return `${period}: ${detail}`;
      });
      const succeededCount = periods.length - failures.length;
      setAddError(
        succeededCount > 0
          ? `${succeededCount} of ${periods.length} entries added. ${messages.join(" ")}`
          : messages.join(" "),
      );
    } else {
      setAddDate("");
    }
  }

  function handleDelete(id: number) {
    deleteLeave.mutate(id);
  }

  return (
    <div>
      <h1 className="text-lg font-semibold">Leave</h1>

      <div className="mt-4">
        <label className="text-sm font-medium" htmlFor="leave-filter">
          Doctor
        </label>
        <select
          id="leave-filter"
          value={filterDoctorId ?? ""}
          onChange={(e) => setFilterDoctorId(e.target.value === "" ? null : Number(e.target.value))}
          className="ml-2 rounded border border-border p-1 text-sm"
        >
          <option value="">All doctors</option>
          {filterDoctorGroups.map((group) => (
            <optgroup key={group.type} label={group.label}>
              {group.doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.code}
                  {d.active ? "" : " (inactive)"}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <form onSubmit={handleAdd} className="mt-4 flex flex-wrap items-end gap-2 rounded border border-border p-3">
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="leave-add-doctor">
            Doctor
          </label>
          <select
            id="leave-add-doctor"
            value={addDoctorId}
            onChange={(e) => setAddDoctorId(e.target.value === "" ? "" : Number(e.target.value))}
            className="mt-1 rounded border border-border p-1 text-sm"
          >
            <option value="">Select...</option>
            {addDoctorGroups.map((group) => (
              <optgroup key={group.type} label={group.label}>
                {group.doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.code}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="leave-add-date">
            Date
          </label>
          <input
            id="leave-add-date"
            type="date"
            value={addDate}
            onChange={(e) => setAddDate(e.target.value)}
            className="mt-1 rounded border border-border p-1 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="leave-add-period">
            Period
          </label>
          <select
            id="leave-add-period"
            value={addPeriod}
            onChange={(e) => setAddPeriod(e.target.value as PeriodChoice)}
            className="mt-1 rounded border border-border p-1 text-sm"
          >
            <option value="AM">AM</option>
            <option value="PM">PM</option>
            <option value="BOTH">Both (AM + PM)</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={createLeave.isPending}
          className="rounded bg-accent px-4 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          Add
        </button>
      </form>
      {addError ? <p className="mt-2 text-sm text-red-700">{addError}</p> : null}

      {isLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}
      {isError ? <p className="mt-4 text-sm text-red-700">Could not load leave entries.</p> : null}

      {entries && entries.length === 0 ? <p className="mt-4 text-sm text-ink/50">No leave entries.</p> : null}

      {entries && entries.length > 0 ? (
        <table className="mt-4 min-w-full text-sm">
          <thead>
            <tr className="text-left text-ink/70">
              <th className="py-1 pr-4 font-medium">Date</th>
              <th className="py-1 pr-4 font-medium">Doctor</th>
              <th className="py-1 pr-4 font-medium">Period</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} className="border-t border-border">
                <td className="py-1 pr-4">{entry.date}</td>
                <td className="py-1 pr-4">{doctorsById.get(entry.doctor_id)?.code ?? entry.doctor_id}</td>
                <td className="py-1 pr-4">{entry.period}</td>
                <td className="py-1">
                  <button type="button" onClick={() => handleDelete(entry.id)} className="text-xs text-red-700">
                    Delete
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