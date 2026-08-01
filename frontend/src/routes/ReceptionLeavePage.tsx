import { useState } from "react";
import type { FormEvent } from "react";

import {
  useBulkCreateReceptionLeave,
  useBulkDeleteReceptionLeave,
  useDeleteReceptionLeave,
  useReceptionLeave,
  useReceptionStaff,
} from "@/api/reception";
import type { ApiError } from "@/api/types";
import { formatDateWithDay, parseLocalDate } from "@/lib/date";

/** Mirrors MAX_RECEPTION_LEAVE_RANGE_DAYS in schemas/reception.py, so the server's 422 is never the first line of defence. */
const MAX_RANGE_DAYS = 366;

function errorDetail(err: unknown, fallback: string): string {
  const apiErr = err as ApiError | undefined;
  return apiErr && typeof apiErr.detail === "string" ? apiErr.detail : fallback;
}

/** Whole days from start to end, both "YYYY-MM-DD". Local-midnight arithmetic; Math.round absorbs DST-shortened days. */
function daysBetween(start: string, end: string): number {
  return Math.round((parseLocalDate(end).getTime() - parseLocalDate(start).getTime()) / 86_400_000);
}

/**
 * Reception leave: whole days off, recorded per staff member.
 *
 * Much plainer than the clinical LeavePage, and deliberately so - there
 * are no half-day edge controls, no range preview and no year calendar,
 * because reception leave has no period dimension to preview or collapse.
 * A range form (add or remove) plus a flat table of entries is the whole
 * surface.
 *
 * Recording leave never edits a generated day: the staff member keeps
 * every session row they had, and the only effect is that the day rota's
 * coverage panel stops counting them toward the phones minimum and the
 * grid dims their row. Slot-level absence ("off from 2pm") is still done
 * on the day rota itself, by deleting or retagging those slots.
 */
export function ReceptionLeavePage() {
  // The table filter reads all staff including inactive - a deactivated
  // staff member's existing entries are real rows that should stay
  // findable - while the range form offers active staff only, matching
  // LeavePage's split.
  const { data: allStaff } = useReceptionStaff(true);
  const activeStaff = (allStaff ?? []).filter((s) => s.active);
  const staffById = new Map((allStaff ?? []).map((s) => [s.id, s]));

  const [filterStaffId, setFilterStaffId] = useState<number | null>(null);
  const { data: entries, isLoading, isError } = useReceptionLeave(filterStaffId);

  const bulkCreate = useBulkCreateReceptionLeave();
  const bulkDelete = useBulkDeleteReceptionLeave();
  const deleteEntry = useDeleteReceptionLeave();

  const [mode, setMode] = useState<"add" | "remove">("add");
  const [formStaffId, setFormStaffId] = useState<number | "">("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formSummary, setFormSummary] = useState<string | null>(null);
  const [tableError, setTableError] = useState<string | null>(null);

  const pending = bulkCreate.isPending || bulkDelete.isPending;

  function switchMode(next: "add" | "remove") {
    setMode(next);
    setFormError(null);
    setFormSummary(null);
  }

  /** Both submit paths resolve false when nothing was written, so a cancelled confirm leaves the form as the user left it. */
  async function submitAdd(staffId: number): Promise<boolean> {
    const result = await bulkCreate.mutateAsync({
      staff_id: staffId,
      start_date: startDate,
      end_date: endDate,
    });
    const parts = [`${result.created} day${result.created === 1 ? "" : "s"} added`];
    if (result.skipped_existing > 0) parts.push(`${result.skipped_existing} already recorded`);
    if (result.skipped_weekend > 0) parts.push(`${result.skipped_weekend} weekend days skipped`);
    setFormSummary(`${parts.join(", ")}.`);
    return true;
  }

  async function submitRemove(staffId: number): Promise<boolean> {
    const staffCode = staffById.get(staffId)?.code ?? staffId;
    const range = startDate === endDate ? `on ${startDate}` : `from ${startDate} to ${endDate}`;
    if (!window.confirm(`Remove all leave for ${staffCode} ${range}? This cannot be undone from here.`)) {
      return false;
    }
    const result = await bulkDelete.mutateAsync({
      staff_id: staffId,
      start_date: startDate,
      end_date: endDate,
    });
    setFormSummary(`${result.deleted_count} day${result.deleted_count === 1 ? "" : "s"} removed.`);
    return true;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setFormSummary(null);

    if (formStaffId === "" || !startDate || !endDate) {
      setFormError("Staff member, start date and end date are required.");
      return;
    }
    if (endDate < startDate) {
      setFormError("End date must not be before start date.");
      return;
    }
    if (daysBetween(startDate, endDate) > MAX_RANGE_DAYS) {
      setFormError(`Range must not exceed ${MAX_RANGE_DAYS} days.`);
      return;
    }

    try {
      const written = mode === "add" ? await submitAdd(formStaffId) : await submitRemove(formStaffId);
      if (written) {
        // Staff member and mode persist - entering several ranges for one
        // person in a row is the common batch pattern.
        setStartDate("");
        setEndDate("");
      }
    } catch (err) {
      setFormError(errorDetail(err, mode === "add" ? "Could not add leave." : "Could not remove leave."));
    }
  }

  async function handleDeleteEntry(id: number) {
    setTableError(null);
    try {
      await deleteEntry.mutateAsync(id);
    } catch (err) {
      setTableError(errorDetail(err, "Could not remove this entry."));
    }
  }

  return (
    <div>
      <h1 className="text-lg font-semibold">Leave</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink/70">
        Whole days off for reception staff. A day rota that has already been generated keeps every
        row, but anyone on leave stops counting toward the phones minimum and is greyed out on the
        day grid. For part of a day, edit the slots on the day rota instead.
      </p>

      <form
        onSubmit={handleSubmit}
        className={`mt-4 flex flex-wrap items-end gap-2 rounded border p-3 ${
          mode === "remove" ? "border-red-300 bg-red-50/40" : "border-border"
        }`}
      >
        <fieldset className="w-full">
          <legend className="sr-only">Mode</legend>
          <label className="mr-4 text-sm font-medium">
            <input
              type="radio"
              name="reception-leave-mode"
              value="add"
              checked={mode === "add"}
              onChange={() => switchMode("add")}
              className="mr-1"
            />
            Add leave
          </label>
          <label className="text-sm font-medium">
            <input
              type="radio"
              name="reception-leave-mode"
              value="remove"
              checked={mode === "remove"}
              onChange={() => switchMode("remove")}
              className="mr-1"
            />
            Remove leave
          </label>
        </fieldset>

        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="reception-leave-staff">
            Staff member
          </label>
          <select
            id="reception-leave-staff"
            value={formStaffId}
            onChange={(e) => {
              const value = e.target.value === "" ? "" : Number(e.target.value);
              setFormStaffId(value);
              setFilterStaffId(value === "" ? null : value);
            }}
            className="mt-1 rounded border border-border p-1 text-sm"
          >
            <option value="">Select...</option>
            {activeStaff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="reception-leave-start">
            Start date
          </label>
          <input
            id="reception-leave-start"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="mt-1 rounded border border-border p-1 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="reception-leave-end">
            End date
          </label>
          <input
            id="reception-leave-end"
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="mt-1 rounded border border-border p-1 text-sm"
          />
        </div>

        <button
          type="submit"
          disabled={pending}
          className={`rounded px-4 py-1 text-sm font-medium text-white disabled:opacity-50 ${
            mode === "remove" ? "bg-red-700" : "bg-accent"
          }`}
        >
          {mode === "remove" ? "Remove leave" : "Add leave"}
        </button>

        <p className="w-full text-xs text-ink/50">
          {mode === "remove"
            ? "Removes every entry in the range, weekends included. This cannot be undone from here."
            : "Weekdays only (Mon-Fri); reception rotas never cover weekends, so weekend dates in the range are skipped."}
        </p>
      </form>

      {formError ? <p className="mt-2 text-sm text-red-700">{formError}</p> : null}
      {formSummary ? <p className="mt-2 text-sm text-ink/70">{formSummary}</p> : null}

      <div className="mt-6">
        <label className="text-sm font-medium" htmlFor="reception-leave-filter">
          Staff member
        </label>
        <select
          id="reception-leave-filter"
          value={filterStaffId ?? ""}
          onChange={(e) => setFilterStaffId(e.target.value === "" ? null : Number(e.target.value))}
          className="ml-2 rounded border border-border p-1 text-sm"
        >
          <option value="">All staff</option>
          {(allStaff ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.code}
              {s.active ? "" : " (inactive)"}
            </option>
          ))}
        </select>
      </div>

      {isLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}
      {isError ? <p className="mt-4 text-sm text-red-700">Could not load leave entries.</p> : null}
      {tableError ? <p className="mt-4 text-sm text-red-700">{tableError}</p> : null}

      {entries && entries.length === 0 ? (
        <p className="mt-4 text-sm text-ink/50">No leave entries.</p>
      ) : null}

      {entries && entries.length > 0 ? (
        <table className="mt-4 min-w-full text-sm">
          <thead>
            <tr className="text-left text-ink/70">
              <th className="py-1 pr-4 font-medium">Date</th>
              <th className="py-1 pr-4 font-medium">Staff</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} className="border-t border-border">
                <td className="py-1 pr-4">{formatDateWithDay(entry.date)}</td>
                <td className="py-1 pr-4">{staffById.get(entry.staff_id)?.code ?? entry.staff_id}</td>
                <td className="py-1">
                  <button
                    type="button"
                    onClick={() => handleDeleteEntry(entry.id)}
                    className="text-xs text-red-700"
                  >
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
