import { useState } from "react";
import type { FormEvent } from "react";

import { useCreateSchool, useDeleteHoliday, useDeleteSchool, useSchools } from "@/api/schools";
import type { ApiError, School, SchoolHoliday } from "@/api/types";
import { useWriteGate } from "@/auth/AuthContext";
import { formatHolidayRange } from "@/lib/date";
import { SchoolHolidayFormDialog } from "@/components/SchoolHolidayFormDialog";

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function extractAddErrorMessage(err: unknown): string {
  const detail = (err as ApiError | undefined)?.detail;
  return typeof detail === "string" ? detail : "Could not add this school.";
}

function visibleHolidays(school: School, showPast: boolean): SchoolHoliday[] {
  const today = todayKey();
  const holidays = showPast ? school.holidays : school.holidays.filter((h) => h.end_date >= today);
  return [...holidays].sort((a, b) => a.start_date.localeCompare(b.start_date));
}

interface HolidayDialogState {
  schoolId: number;
  schoolName: string;
  holiday?: SchoolHoliday;
}

export function SchoolHolidaysPage() {
  const writeGate = useWriteGate();
  const { data: schools, isLoading, isError } = useSchools();
  const createSchool = useCreateSchool();
  const deleteSchool = useDeleteSchool();
  const deleteHoliday = useDeleteHoliday();

  const [showPast, setShowPast] = useState(false);
  const [addName, setAddName] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [holidayDialog, setHolidayDialog] = useState<HolidayDialogState | null>(null);

  function handleAdd(event: FormEvent) {
    event.preventDefault();
    setAddError(null);
    if (!addName.trim()) {
      setAddError("Name is required.");
      return;
    }
    createSchool.mutate(
      { name: addName },
      {
        onSuccess: () => setAddName(""),
        onError: (err) => setAddError(extractAddErrorMessage(err)),
      },
    );
  }

  function handleDeleteSchool(school: School) {
    const count = school.holidays.length;
    const holidayText = count === 1 ? "1 holiday" : `${count} holidays`;
    if (!window.confirm(`Delete "${school.name}" and its ${holidayText}? This cannot be undone.`)) {
      return;
    }
    deleteSchool.mutate(school.id);
  }

  function handleDeleteHoliday(schoolId: number, holidayId: number) {
    deleteHoliday.mutate({ schoolId, holidayId });
  }

  return (
    <div>
      <p className="text-sm text-ink/70">
        Schools and their holiday date ranges, for context only - nothing here affects rota
        generation, coverage, or duty assignments. Use it to see at a glance whether a leave
        request lands in half term.
      </p>

      <label className="mt-4 flex items-center gap-2 text-sm text-ink/70">
        <input type="checkbox" checked={showPast} onChange={(e) => setShowPast(e.target.checked)} />
        Show past holidays
      </label>

      <form
        onSubmit={handleAdd}
        className="mt-4 flex flex-wrap items-end gap-2 rounded border border-border p-3"
      >
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="school-add-name">
            School name
          </label>
          <input
            id="school-add-name"
            type="text"
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            placeholder="e.g. St Mary's Primary"
            className="mt-1 rounded border border-border p-1 text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={createSchool.isPending}
          className="rounded bg-accent px-4 py-1 text-sm font-medium text-white disabled:opacity-50"
          {...writeGate}
        >
          Add school
        </button>
      </form>
      {addError ? <p className="mt-2 text-sm text-red-700">{addError}</p> : null}

      {isLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}
      {isError ? <p className="mt-4 text-sm text-red-700">Could not load schools.</p> : null}

      {schools && schools.length === 0 ? <p className="mt-4 text-sm text-ink/50">No schools.</p> : null}

      {schools && schools.length > 0 ? (
        <table aria-label="Schools" className="mt-4 w-full table-fixed border-collapse text-sm">
          <colgroup>
            <col className="w-48" />
            <col />
            <col className="w-32" />
          </colgroup>
          <thead>
            <tr className="border-b border-border text-left text-ink/70">
              <th className="py-2 pr-4 font-medium">School</th>
              <th className="py-2 pr-4 font-medium">Holidays</th>
              <th className="py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {schools.map((school) => {
              const holidays = visibleHolidays(school, showPast);
              return (
                <tr key={school.id} className="align-top">
                  <td className="py-3 pr-4 font-medium">{school.name}</td>
                  <td className="py-3 pr-4">
                    {holidays.length === 0 ? (
                      <p className="text-ink/50">None recorded</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {holidays.map((h) => (
                          <li key={h.id} className="flex items-center justify-between gap-3">
                            <span>
                              {formatHolidayRange(h.start_date, h.end_date)}
                              {h.name ? ` (${h.name})` : ""}
                            </span>
                            <span className="flex shrink-0 items-center gap-3">
                              <button
                                type="button"
                                onClick={() =>
                                  setHolidayDialog({ schoolId: school.id, schoolName: school.name, holiday: h })
                                }
                                className="text-xs text-accent disabled:opacity-50"
                                {...writeGate}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteHoliday(school.id, h.id)}
                                className="text-xs text-red-700 disabled:opacity-50"
                                {...writeGate}
                              >
                                Delete
                              </button>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <button
                      type="button"
                      onClick={() => setHolidayDialog({ schoolId: school.id, schoolName: school.name })}
                      className="mt-2 text-xs text-accent disabled:opacity-50"
                      {...writeGate}
                    >
                      Add holiday
                    </button>
                  </td>
                  <td className="py-3 text-right">
                    <button
                      type="button"
                      onClick={() => handleDeleteSchool(school)}
                      className="text-xs text-red-700 disabled:opacity-50"
                      {...writeGate}
                    >
                      Delete school
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}

      {holidayDialog ? (
        <SchoolHolidayFormDialog
          key={`${holidayDialog.schoolId}-${holidayDialog.holiday?.id ?? "new"}`}
          schoolId={holidayDialog.schoolId}
          schoolName={holidayDialog.schoolName}
          holiday={holidayDialog.holiday}
          open
          onOpenChange={(open) => {
            if (!open) setHolidayDialog(null);
          }}
        />
      ) : null}
    </div>
  );
}
