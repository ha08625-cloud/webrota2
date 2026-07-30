import { useState } from "react";
import type { FormEvent } from "react";

import { useDoctors } from "@/api/doctors";
import { useBulkCreateLeave, useBulkDeleteLeave, useLeave } from "@/api/leave";
import type { ApiError, PeriodOrBoth } from "@/api/types";
import { LeaveRangePreview } from "@/components/LeaveRangePreview";
import { LeaveYearCalendar } from "@/components/LeaveYearCalendar";
import { parseLocalDate } from "@/lib/date";
import { collapseLeaveEntries } from "@/lib/collapseLeaveEntries";
import type { LeaveBlock } from "@/lib/collapseLeaveEntries";
import {
  expandLeaveRange,
  singleDayToEdges,
} from "@/lib/expandLeaveRange";
import type {
  FirstDayOption,
  LastDayOption,
  LeaveSegment,
  SingleDayOption,
} from "@/lib/expandLeaveRange";
import { compareDoctorDisplayOrder, groupDoctorsByType } from "@/lib/groupDoctors";

import { formatDateWithDay } from "@/lib/date";

/** Mirrors MAX_BULK_RANGE_DAYS in schemas_leave.py, so the server's own 422 is never the first line of defence. */
const MAX_RANGE_DAYS = 366;

function errorDetail(err: unknown, fallback: string): string {
  const apiErr = err as ApiError | undefined;
  if (apiErr && typeof apiErr.detail === "string") {
    return apiErr.detail;
  }
  return fallback;
}

/** Whole days from start to end, both "YYYY-MM-DD". Local-midnight arithmetic; Math.round absorbs DST-shortened/lengthened days. */
function daysBetween(start: string, end: string): number {
  return Math.round((parseLocalDate(end).getTime() - parseLocalDate(start).getTime()) / 86_400_000);
}

/** Human label for one segment in per-segment failure messages, in the same "<what>: <detail>" style the old per-period reporting used. */
function segmentLabel(segment: LeaveSegment): string {
  if (segment.start_date === segment.end_date) {
    return `${segment.start_date} (${segment.period === "BOTH" ? "AM + PM" : segment.period})`;
  }
  return `${segment.start_date} to ${segment.end_date}`;
}

/** Bare-date wording shared by the range form's confirm dialog and a block's delete confirm. */
function describeSpan(span: {
  start_date: string;
  end_date: string;
  period: PeriodOrBoth;
  half_start: boolean;
  half_end: boolean;
}): string {
  if (span.start_date === span.end_date) {
    const suffix = span.period === "AM" ? " (AM only)" : span.period === "PM" ? " (PM only)" : "";
    return `on ${span.start_date}${suffix}`;
  }
  const startSuffix = span.half_start ? " (PM only)" : "";
  const endSuffix = span.half_end ? " (AM only)" : "";
  return `from ${span.start_date}${startSuffix} to ${span.end_date}${endSuffix}`;
}

export function LeavePage() {
  // The filter reads against *all* doctors (including inactive) - a
  // deactivated doctor's historical leave entries are still real rows
  // that should be findable here, not hidden because they're no longer
  // an active doctor.
  const { data: allDoctors } = useDoctors(false);
  // The range form's doctor select is deliberately narrower: active
  // only, in *both* modes. For Add, the old reasoning holds unchanged
  // (no legitimate reason to add new leave for someone who has left).
  // For Remove this is a small semantics change from the old separate
  // range-delete form, which allowed inactive doctors - keeping one
  // doctor list keeps the unified form coherent, and an inactive
  // doctor's rows remain deletable per-row from the table below (the
  // filter select still lists inactive doctors to find them).
  const activeDoctors = (allDoctors ?? []).filter((d) => d.active);

  const [filterDoctorId, setFilterDoctorId] = useState<number | null>(null);
  const [calendarYear, setCalendarYear] = useState(() => new Date().getFullYear());
  const { data: entries, isLoading, isError } = useLeave(filterDoctorId);
  const bulkCreateLeave = useBulkCreateLeave();
  const bulkDeleteLeave = useBulkDeleteLeave();

  const [mode, setMode] = useState<"add" | "remove">("add");
  const [formDoctorId, setFormDoctorId] = useState<number | "">("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [firstDay, setFirstDay] = useState<FirstDayOption>("FULL");
  const [lastDay, setLastDay] = useState<LastDayOption>("FULL");
  const [singleDay, setSingleDay] = useState<SingleDayOption>("FULL");
  const [formError, setFormError] = useState<string | null>(null);
  const [formSummary, setFormSummary] = useState<string | null>(null);
  const [tableError, setTableError] = useState<string | null>(null);

  // The preview needs the *form* doctor's existing leave, which may
  // differ from the table's filter doctor - the hook's cache key is
  // already parameterised by doctor id, so the two queries coexist.
  // With no doctor selected this shares the table's unfiltered query
  // cache; the preview isn't rendered in that state anyway.
  const { data: previewLeave } = useLeave(formDoctorId === "" ? null : formDoctorId);

  const doctorsById = new Map((allDoctors ?? []).map((d) => [d.id, d]));
  const filterDoctorGroups = groupDoctorsByType(allDoctors ?? []);
  const addDoctorGroups = groupDoctorsByType(activeDoctors);

  const isSingleDay = startDate !== "" && startDate === endDate;
  const datesValid = startDate !== "" && endDate !== "" && startDate <= endDate;
  const edges = isSingleDay ? singleDayToEdges(singleDay) : { firstDay, lastDay };
  const segments = datesValid
    ? expandLeaveRange(startDate, endDate, edges.firstDay, edges.lastDay)
    : [];

  /**
   * Any date change resets the half-day selects to full days. The
   * plan's minimum requirement is resetting when crossing the
   * single-day/multi-day boundary (the two control shapes don't map
   * onto each other); resetting on *every* date change is a deliberate
   * superset - a half-day choice refers to a specific day, so it should
   * not silently survive that day changing.
   */
  function resetEdges() {
    setFirstDay("FULL");
    setLastDay("FULL");
    setSingleDay("FULL");
  }

  function handleStartDateChange(value: string) {
    setStartDate(value);
    resetEdges();
  }

  function handleEndDateChange(value: string) {
    setEndDate(value);
    resetEdges();
  }

  function switchMode(next: "add" | "remove") {
    setMode(next);
    setFormError(null);
    setFormSummary(null);
  }

  function resetDatesAfterSuccess() {
    // Doctor and mode deliberately persist - entering several ranges
    // for one doctor in a row is the common batch pattern.
    setStartDate("");
    setEndDate("");
    resetEdges();
  }

  function describeRangeForConfirm(): string {
    if (isSingleDay) {
      const period: PeriodOrBoth =
        singleDay === "AM_ONLY" ? "AM" : singleDay === "PM_ONLY" ? "PM" : "BOTH";
      return describeSpan({
        start_date: startDate,
        end_date: startDate,
        period,
        half_start: false,
        half_end: false,
      });
    }
    return describeSpan({
      start_date: startDate,
      end_date: endDate,
      period: "BOTH",
      half_start: firstDay === "PM_ONLY",
      half_end: lastDay === "AM_ONLY",
    });
  }

  async function submitAdd(doctorId: number, plan: LeaveSegment[]) {
    const results = await Promise.allSettled(
      plan.map((segment) =>
        bulkCreateLeave.mutateAsync({
          doctor_id: doctorId,
          start_date: segment.start_date,
          end_date: segment.end_date,
          period: segment.period,
        }),
      ),
    );

    let created = 0;
    let duplicates = 0;
    let weekends = 0;
    const supersededDates: string[] = [];
    const failures: string[] = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        created += result.value.created.length;
        duplicates += result.value.skipped.filter((s) => s.reason === "duplicate").length;
        weekends += result.value.skipped.filter((s) => s.reason === "weekend").length;
        supersededDates.push(...result.value.superseded_extra_sessions.map((e) => e.date));
      } else {
        failures.push(`${segmentLabel(plan[index])}: ${errorDetail(result.reason, "could not be added")}.`);
      }
    });

    const parts = [`${created} entries added`];
    if (duplicates > 0) parts.push(`${duplicates} already existed`);
    if (weekends > 0) parts.push(`${weekends} weekend slots skipped`);
    let summary = `${parts.join(", ")}.`;
    if (supersededDates.length > 0) {
      // Warning, not an error - the leave was created successfully
      // (extra sessions plan, Design Decision 7). Nothing is deleted
      // automatically; the admin decides whether to remove the planned
      // extra sessions on the Extra Sessions page.
      summary += ` Warning: this leave supersedes ${supersededDates.length} planned extra session${
        supersededDates.length === 1 ? "" : "s"
      } (${supersededDates.join(", ")}) - review them on the Extra Sessions page.`;
    }

    if (failures.length > 0) {
      // Partial failure is reported honestly, per segment, alongside
      // what did succeed - fulfilled segments are not rolled back and
      // atomicity is not faked (same reasoning as the M4 Task 6
      // PATCH-then-PUT decision).
      setFormError(`${failures.join(" ")} ${summary}`);
    } else {
      setFormSummary(summary);
      resetDatesAfterSuccess();
    }
  }

  async function submitRemove(doctorId: number, plan: LeaveSegment[]) {
    const doctorCode = doctorsById.get(doctorId)?.code ?? doctorId;
    const confirmed = window.confirm(
      `Remove all leave for ${doctorCode} ${describeRangeForConfirm()}? This cannot be undone from here.`,
    );
    if (!confirmed) return;

    const results = await Promise.allSettled(
      plan.map((segment) =>
        bulkDeleteLeave.mutateAsync({
          doctor_id: doctorId,
          start_date: segment.start_date,
          end_date: segment.end_date,
          period: segment.period,
        }),
      ),
    );

    let deleted = 0;
    const failures: string[] = [];
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        deleted += result.value.deleted_count;
      } else {
        failures.push(
          `${segmentLabel(plan[index])}: ${errorDetail(result.reason, "could not be removed")}.`,
        );
      }
    });

    if (failures.length > 0) {
      setFormError(`${failures.join(" ")} ${deleted} entries removed.`);
    } else {
      setFormSummary(`${deleted} entries removed.`);
      resetDatesAfterSuccess();
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setFormSummary(null);

    if (formDoctorId === "" || !startDate || !endDate) {
      setFormError("Doctor, start date and end date are required.");
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

    const plan = expandLeaveRange(startDate, endDate, edges.firstDay, edges.lastDay);
    if (mode === "add") {
      await submitAdd(formDoctorId, plan);
    } else {
      await submitRemove(formDoctorId, plan);
    }
  }

  async function handleDeleteBlock(block: LeaveBlock) {
    setTableError(null);
    const doctorCode = doctorsById.get(block.doctor_id)?.code ?? block.doctor_id;
    const confirmed = window.confirm(
      `Remove all leave for ${doctorCode} ${describeSpan(block)}? This cannot be undone from here.`,
    );
    if (!confirmed) return;

    try {
      await bulkDeleteLeave.mutateAsync({
        doctor_id: block.doctor_id,
        start_date: block.start_date,
        end_date: block.end_date,
        period: block.period,
      });
    } catch (err) {
      setTableError(errorDetail(err, "Could not remove leave."));
    }
  }

  const pending = bulkCreateLeave.isPending || bulkDeleteLeave.isPending;

  const blocks = collapseLeaveEntries(entries ?? []).sort((a, b) => {
    const doctorA = doctorsById.get(a.doctor_id);
    const doctorB = doctorsById.get(b.doctor_id);
    if (doctorA && doctorB) {
      const typeDiff = compareDoctorDisplayOrder(
        { type: doctorA.doctor_type, code: doctorA.code },
        { type: doctorB.doctor_type, code: doctorB.code },
      );
      if (typeDiff !== 0) return typeDiff;
    } else if (a.doctor_id !== b.doctor_id) {
      return a.doctor_id - b.doctor_id;
    }
    return a.start_date.localeCompare(b.start_date);
  });

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <div className="min-w-0 lg:flex-1">
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
              name="leave-mode"
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
              name="leave-mode"
              value="remove"
              checked={mode === "remove"}
              onChange={() => switchMode("remove")}
              className="mr-1"
            />
            Remove leave
          </label>
        </fieldset>

        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="leave-range-doctor">
            Doctor
          </label>
          <select
            id="leave-range-doctor"
            value={formDoctorId}
            onChange={(e) => {
                const value = e.target.value === "" ? "" : Number(e.target.value);
                setFormDoctorId(value);
                setFilterDoctorId(value === "" ? null : value);
              }}
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
          <label className="block text-xs font-medium text-ink/70" htmlFor="leave-range-start">
            Start date
          </label>
          <input
            id="leave-range-start"
            type="date"
            value={startDate}
            onChange={(e) => handleStartDateChange(e.target.value)}
            className="mt-1 rounded border border-border p-1 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-ink/70" htmlFor="leave-range-end">
            End date
          </label>
          <input
            id="leave-range-end"
            type="date"
            value={endDate}
            onChange={(e) => handleEndDateChange(e.target.value)}
            className="mt-1 rounded border border-border p-1 text-sm"
          />
        </div>

        {datesValid && isSingleDay ? (
          <div>
            <label className="block text-xs font-medium text-ink/70" htmlFor="leave-range-single-day">
              Day
            </label>
            <select
              id="leave-range-single-day"
              value={singleDay}
              onChange={(e) => setSingleDay(e.target.value as SingleDayOption)}
              className="mt-1 rounded border border-border p-1 text-sm"
            >
              <option value="FULL">Full day</option>
              <option value="AM_ONLY">AM only</option>
              <option value="PM_ONLY">PM only</option>
            </select>
          </div>
        ) : null}

        {datesValid && !isSingleDay ? (
          <>
            <div>
              <label className="block text-xs font-medium text-ink/70" htmlFor="leave-range-first-day">
                First day
              </label>
              <select
                id="leave-range-first-day"
                value={firstDay}
                onChange={(e) => setFirstDay(e.target.value as FirstDayOption)}
                className="mt-1 rounded border border-border p-1 text-sm"
              >
                <option value="FULL">Full day</option>
                <option value="PM_ONLY">Half day (PM only)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-ink/70" htmlFor="leave-range-last-day">
                Last day
              </label>
              <select
                id="leave-range-last-day"
                value={lastDay}
                onChange={(e) => setLastDay(e.target.value as LastDayOption)}
                className="mt-1 rounded border border-border p-1 text-sm"
              >
                <option value="FULL">Full day</option>
                <option value="AM_ONLY">Half day (AM only)</option>
              </select>
            </div>
          </>
        ) : null}

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
            ? "Removes every matching entry in the range, including weekends. This cannot be undone from here."
            : "Weekdays only (Mon-Fri); weekends in the range are skipped."}
        </p>

        {formDoctorId !== "" && datesValid ? (
          <div className="w-full">
            <LeaveRangePreview
              mode={mode}
              startDate={startDate}
              endDate={endDate}
              segments={segments}
              existingEntries={(previewLeave ?? []).filter((e) => e.doctor_id === formDoctorId)}
            />
          </div>
        ) : null}
      </form>
      {formError ? <p className="mt-2 text-sm text-red-700">{formError}</p> : null}
      {formSummary ? <p className="mt-2 text-sm text-ink/70">{formSummary}</p> : null}

      <div className="mt-6">
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

      {isLoading ? <p className="mt-4 text-sm text-ink/70">Loading...</p> : null}
      {isError ? <p className="mt-4 text-sm text-red-700">Could not load leave entries.</p> : null}
      {tableError ? <p className="mt-4 text-sm text-red-700">{tableError}</p> : null}

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
            {blocks.map((block) => (
              <tr
                key={`${block.doctor_id}-${block.start_date}-${block.end_date}-${block.period}`}
                className="border-t border-border"
              >
                <td className="py-1 pr-4">
                  {block.start_date === block.end_date
                    ? formatDateWithDay(block.start_date)
                    : `${formatDateWithDay(block.start_date)}${block.half_start ? " (PM only)" : ""} to ${formatDateWithDay(block.end_date)}${block.half_end ? " (AM only)" : ""}`}
                </td>
                <td className="py-1 pr-4">{doctorsById.get(block.doctor_id)?.code ?? block.doctor_id}</td>
                <td className="py-1 pr-4">{block.period === "BOTH" ? "Full day" : block.period}</td>
                <td className="py-1">
                  <button
                    type="button"
                    onClick={() => handleDeleteBlock(block)}
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

      {filterDoctorId !== null ? (
        <div className="min-w-0 lg:flex-1">
          <LeaveYearCalendar
            year={calendarYear}
            onPrevYear={() => setCalendarYear((y) => y - 1)}
            onNextYear={() => setCalendarYear((y) => y + 1)}
            entries={entries ?? []}
          />
        </div>
      ) : null}
    </div>
  );
}