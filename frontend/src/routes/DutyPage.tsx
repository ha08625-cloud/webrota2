import { useMemo, useState } from "react";
import type { FormEvent } from "react";

import { useDoctors } from "@/api/doctors";
import { useCreateDuty, useDeleteDuty, useDuty } from "@/api/duty";
import type { DutyType, Period } from "@/api/types";
import { DutyGrid } from "@/components/DutyGrid";
import { formatWeekLabel, getUpcomingMondays } from "@/lib/date";
import { groupDoctorsByType } from "@/lib/groupDoctors";

const UPCOMING_WEEK_COUNT = 12;

export function DutyPage() {
  const upcomingMondays = useMemo(() => getUpcomingMondays(UPCOMING_WEEK_COUNT), []);
  const [selectedWeek, setSelectedWeek] = useState(upcomingMondays[0]);

  const { data: allDoctors } = useDoctors(false);
  const activeDoctors = (allDoctors ?? []).filter((d) => d.active);
  const doctorsById = new Map((allDoctors ?? []).map((d) => [d.id, d]));
  const addDoctorGroups = groupDoctorsByType(activeDoctors);

  const { data: assignments, isLoading, isError } = useDuty();
  const createDuty = useCreateDuty();
  const deleteDuty = useDeleteDuty();

  const [addDoctorId, setAddDoctorId] = useState<number | "">("");
  const [addDate, setAddDate] = useState("");
  const [addPeriod, setAddPeriod] = useState<Period>("AM");
  const [addDutyType, setAddDutyType] = useState<DutyType>("primary");
  const [addError, setAddError] = useState<string | null>(null);

  function handleAdd(event: FormEvent) {
    event.preventDefault();
    setAddError(null);
    if (addDoctorId === "" || !addDate) {
      setAddError("Doctor and date are required.");
      return;
    }
    createDuty.mutate(
      { date: addDate, period: addPeriod, doctor_id: addDoctorId, duty_type: addDutyType },
      {
        onSuccess: () => setAddDate(""),
        onError: (err) => {
          setAddError(typeof err.detail === "string" ? err.detail : "Could not add this duty assignment.");
        },
      },
    );
  }

  function handleDelete(id: number) {
    deleteDuty.mutate(id);
  }

  return (
    <div>
      <h1 className="text-lg font-semibold">Duty</h1>

      <div className="mt-4">
        <label className="block text-xs font-medium text-ink/70" htmlFor="duty-week-select">
          Week
        </label>
        <select
          id="duty-week-select"
          value={selectedWeek}
          onChange={(e) => setSelectedWeek(e.target.value)}
          className="mt-1 rounded border border-border p-1 text-sm"
        >
          {upcomingMondays.map((monday) => (
            <option key={monday} value={monday}>
              {formatWeekLabel(monday)}
            </option>
          ))}
        </select>
      </div>

      <div className="mt-4">
        <DutyGrid weekStartDate={selectedWeek} />
      </div>

      <form
        onSubmit={handleAdd}
        className="mt-8 flex flex-wrap items-end gap-2 rounded border border-border p-3"
      >
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="duty-add-doctor">
            Doctor
          </label>
          <select
            id="duty-add-doctor"
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
          <label className="block text-xs font-medium text-ink/70" htmlFor="duty-add-date">
            Date
          </label>
          <input
            id="duty-add-date"
            type="date"
            value={addDate}
            onChange={(e) => setAddDate(e.target.value)}
            className="mt-1 rounded border border-border p-1 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="duty-add-period">
            Period
          </label>
          <select
            id="duty-add-period"
            value={addPeriod}
            onChange={(e) => setAddPeriod(e.target.value as Period)}
            className="mt-1 rounded border border-border p-1 text-sm"
          >
            <option value="AM">AM</option>
            <option value="PM">PM</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="duty-add-type">
            Duty type
          </label>
          <select
            id="duty-add-type"
            value={addDutyType}
            onChange={(e) => setAddDutyType(e.target.value as DutyType)}
            className="mt-1 rounded border border-border p-1 text-sm"
          >
            <option value="primary">Primary</option>
            <option value="secondary">Secondary</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={createDuty.isPending}
          className="rounded bg-accent px-4 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          Add
        </button>
      </form>
      {addError ? <p className="mt-2 text-sm text-red-700">{addError}</p> : null}

      {isLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}
      {isError ? <p className="mt-4 text-sm text-red-700">Could not load duty assignments.</p> : null}

      {assignments && assignments.length === 0 ? (
        <p className="mt-4 text-sm text-ink/50">No duty assignments.</p>
      ) : null}

      {assignments && assignments.length > 0 ? (
        <table className="mt-4 min-w-full text-sm">
          <thead>
            <tr className="text-left text-ink/70">
              <th className="py-1 pr-4 font-medium">Date</th>
              <th className="py-1 pr-4 font-medium">Period</th>
              <th className="py-1 pr-4 font-medium">Doctor</th>
              <th className="py-1 pr-4 font-medium">Type</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {assignments.map((a) => (
              <tr key={a.id} className="border-t border-border">
                <td className="py-1 pr-4">{a.date}</td>
                <td className="py-1 pr-4">{a.period}</td>
                <td className="py-1 pr-4">{doctorsById.get(a.doctor_id)?.code ?? a.doctor_id}</td>
                <td className="py-1 pr-4">{a.duty_type}</td>
                <td className="py-1">
                  <button type="button" onClick={() => handleDelete(a.id)} className="text-xs text-red-700">
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