import type { LeaveEntry, Period, PeriodOrBoth } from "@/api/types";

import { addDays, parseLocalDate } from "./date";

/**
 * The inverse of expandLeaveRange: groups a doctor's individual (date,
 * period) leave entries back into the fewest possible contiguous blocks,
 * for display as one row per absence instead of one row per half day.
 *
 * Invariants on the returned blocks:
 * - `start_date <= end_date`.
 * - `half_start` / `half_end` are only ever true when `period === "BOTH"`.
 * Delete-exactness (see the LeaveBlock.period doc): for every block, the set of input entries for
 *   that doctor with `start_date <= date <= end_date` and period matching
 *   the block's expanded periods is exactly the set of entries the block
 *   was built from - never more, never fewer. This holds because a block
 *   never spans a weekend: bulk add is weekday-only, so a stray weekend
 *   entry always ends the run it's adjacent to and becomes its own
 *   single-day block, which guarantees no block's date span can contain an
 *   entry that isn't part of that block. It is what makes a single
 *   POST /leave/bulk-delete call over a block's own span (start_date,
 *   end_date, period) safe to attach to that block's row.
 */

export interface LeaveBlock {
  doctor_id: number;
  start_date: string;
  end_date: string;
  /** BOTH for a full-day block (including one with half-day edges); AM or PM for a uniform half-day block. */
  period: PeriodOrBoth;
  /** start_date is a PM-only half day. Only ever true when period is BOTH. */
  half_start: boolean;
  /** end_date is an AM-only half day. Only ever true when period is BOTH. */
  half_end: boolean;
}

function isWeekday(dateString: string): boolean {
  const day = parseLocalDate(dateString).getDay();
  return day >= 1 && day <= 5;
}

function nextWeekday(dateString: string): string {
  let next = addDays(dateString, 1);
  while (!isWeekday(next)) {
    next = addDays(next, 1);
  }
  return next;
}

interface DayRecord {
  date: string;
  period: PeriodOrBoth;
}

/** Merges same-date entries into day records and sorts ascending by date. */
function buildDayRecords(entries: LeaveEntry[]): DayRecord[] {
  const periodsByDate = new Map<string, Set<Period>>();
  for (const entry of entries) {
    if (!periodsByDate.has(entry.date)) {
      periodsByDate.set(entry.date, new Set());
    }
    periodsByDate.get(entry.date)!.add(entry.period);
  }

  const records: DayRecord[] = [];
  for (const [date, periods] of periodsByDate) {
    const period: PeriodOrBoth = periods.size === 2 ? "BOTH" : [...periods][0];
    records.push({ date, period });
  }
  return records.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Splits day records into maximal date runs: a new run starts whenever the
 * previous or current date isn't a weekday, or the current date isn't the
 * previous date's next weekday. Weekend gaps (Fri -> Mon) don't break a
 * run; weekend entries do, since they can only exist as stray data that a
 * range delete must not swallow (see the module docstring).
 */
function splitDateRuns(records: DayRecord[]): DayRecord[][] {
  const runs: DayRecord[][] = [];
  let current: DayRecord[] = [];

  for (const record of records) {
    const prev = current[current.length - 1];
    const continuesRun =
      prev !== undefined && isWeekday(prev.date) && isWeekday(record.date) && nextWeekday(prev.date) === record.date;

    if (continuesRun) {
      current.push(record);
    } else {
      if (current.length > 0) runs.push(current);
      current = [record];
    }
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

interface SubRun {
  start_date: string;
  end_date: string;
  period: PeriodOrBoth;
}

/** Run-length-encodes a date run into maximal uniform-period sub-runs. */
function runLengthEncode(records: DayRecord[]): SubRun[] {
  const subRuns: SubRun[] = [];
  for (const record of records) {
    const last = subRuns[subRuns.length - 1];
    if (last !== undefined && last.period === record.period) {
      last.end_date = record.date;
    } else {
      subRuns.push({ start_date: record.date, end_date: record.date, period: record.period });
    }
  }
  return subRuns;
}

function isSingleDay(run: SubRun): boolean {
  return run.start_date === run.end_date;
}

/**
 * Absorbs a trailing single-day AM sub-run following a BOTH run, if
 * present. Shared by both places a BOTH run can start a block (a plain
 * full-day run, and one already merged with a leading PM half day).
 */
function absorbTrailingAm(
  runs: SubRun[],
  index: number,
): { end_date: string; half_end: boolean; consumed: number } {
  const next = runs[index];
  if (next !== undefined && next.period === "AM" && isSingleDay(next)) {
    return { end_date: next.end_date, half_end: true, consumed: 1 };
  }
  return { end_date: runs[index - 1].end_date, half_end: false, consumed: 0 };
}

/** Folds one date run's sub-runs into blocks. */
function foldRunsIntoBlocks(doctorId: number, runs: SubRun[]): LeaveBlock[] {
  const blocks: LeaveBlock[] = [];
  let i = 0;

  while (i < runs.length) {
    const run = runs[i];

    if (run.period === "PM" && isSingleDay(run) && i + 1 < runs.length) {
      const next = runs[i + 1];

      if (next.period === "BOTH") {
        const trailing = absorbTrailingAm(runs, i + 2);
        blocks.push({
          doctor_id: doctorId,
          start_date: run.start_date,
          end_date: trailing.end_date,
          period: "BOTH",
          half_start: true,
          half_end: trailing.half_end,
        });
        i += 2 + trailing.consumed;
        continue;
      }

      if (next.period === "AM" && isSingleDay(next)) {
        blocks.push({
          doctor_id: doctorId,
          start_date: run.start_date,
          end_date: next.end_date,
          period: "BOTH",
          half_start: true,
          half_end: true,
        });
        i += 2;
        continue;
      }
    }

    if (run.period === "BOTH") {
      const trailing = absorbTrailingAm(runs, i + 1);
      blocks.push({
        doctor_id: doctorId,
        start_date: run.start_date,
        end_date: trailing.end_date,
        period: "BOTH",
        half_start: false,
        half_end: trailing.half_end,
      });
      i += 1 + trailing.consumed;
      continue;
    }

    blocks.push({
      doctor_id: doctorId,
      start_date: run.start_date,
      end_date: run.end_date,
      period: run.period,
      half_start: false,
      half_end: false,
    });
    i += 1;
  }

  return blocks;
}

/**
 * Collapses a doctor's leave entries into blocks - see the module
 * docstring for the invariants every returned block satisfies. Sorts
 * defensively rather than trusting the caller's ordering; does not
 * sort or group by anything other than
 * doctor_id/date, since display ordering (e.g. by doctor display order) is
 * the caller's job.
 */
export function collapseLeaveEntries(entries: LeaveEntry[]): LeaveBlock[] {
  const entriesByDoctor = new Map<number, LeaveEntry[]>();
  for (const entry of entries) {
    if (!entriesByDoctor.has(entry.doctor_id)) {
      entriesByDoctor.set(entry.doctor_id, []);
    }
    entriesByDoctor.get(entry.doctor_id)!.push(entry);
  }

  const doctorIds = [...entriesByDoctor.keys()].sort((a, b) => a - b);

  const blocks: LeaveBlock[] = [];
  for (const doctorId of doctorIds) {
    const records = buildDayRecords(entriesByDoctor.get(doctorId)!);
    for (const dateRun of splitDateRuns(records)) {
      blocks.push(...foldRunsIntoBlocks(doctorId, runLengthEncode(dateRun)));
    }
  }
  return blocks;
}
