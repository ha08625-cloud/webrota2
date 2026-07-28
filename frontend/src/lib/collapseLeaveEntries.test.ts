import { describe, expect, it } from "vitest";

import type { LeaveBlock } from "./collapseLeaveEntries";
import { collapseLeaveEntries } from "./collapseLeaveEntries";
import { addDays } from "./date";
import type { FirstDayOption, LastDayOption } from "./expandLeaveRange";
import { expandLeaveRange, segmentsToSessionKeys } from "./expandLeaveRange";
import type { LeaveEntry, Period } from "@/api/types";

let nextId = 1;

function entry(doctorId: number, date: string, period: Period): LeaveEntry {
  return { id: nextId++, doctor_id: doctorId, date, period };
}

describe("collapseLeaveEntries", () => {
  it("empty input collapses to no blocks", () => {
    expect(collapseLeaveEntries([])).toEqual([]);
  });

  it("one full day (AM+PM) collapses to one BOTH block with no halves", () => {
    const blocks = collapseLeaveEntries([entry(1, "2026-07-15", "AM"), entry(1, "2026-07-15", "PM")]);
    expect(blocks).toEqual([
      { doctor_id: 1, start_date: "2026-07-15", end_date: "2026-07-15", period: "BOTH", half_start: false, half_end: false },
    ]);
  });

  it("one AM-only day collapses to one AM block with no halves", () => {
    const blocks = collapseLeaveEntries([entry(1, "2026-07-15", "AM")]);
    expect(blocks).toEqual([
      { doctor_id: 1, start_date: "2026-07-15", end_date: "2026-07-15", period: "AM", half_start: false, half_end: false },
    ]);
  });

  it("Mon-Fri full collapses to one block", () => {
    const entries = ["2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17"].flatMap((date) => [
      entry(1, date, "AM" as Period),
      entry(1, date, "PM" as Period),
    ]);
    const blocks = collapseLeaveEntries(entries);
    expect(blocks).toEqual([
      { doctor_id: 1, start_date: "2026-07-13", end_date: "2026-07-17", period: "BOTH", half_start: false, half_end: false },
    ]);
  });

  it("Thu-Tue full across a weekend collapses to one block", () => {
    const entries = ["2026-07-16", "2026-07-17", "2026-07-20", "2026-07-21"].flatMap((date) => [
      entry(1, date, "AM" as Period),
      entry(1, date, "PM" as Period),
    ]);
    const blocks = collapseLeaveEntries(entries);
    expect(blocks).toEqual([
      { doctor_id: 1, start_date: "2026-07-16", end_date: "2026-07-21", period: "BOTH", half_start: false, half_end: false },
    ]);
  });

  it("Mon-Fri full with Wednesday absent collapses to two blocks", () => {
    const entries = ["2026-07-13", "2026-07-14", "2026-07-16", "2026-07-17"].flatMap((date) => [
      entry(1, date, "AM" as Period),
      entry(1, date, "PM" as Period),
    ]);
    const blocks = collapseLeaveEntries(entries);
    expect(blocks).toEqual([
      { doctor_id: 1, start_date: "2026-07-13", end_date: "2026-07-14", period: "BOTH", half_start: false, half_end: false },
      { doctor_id: 1, start_date: "2026-07-16", end_date: "2026-07-17", period: "BOTH", half_start: false, half_end: false },
    ]);
  });

  it("Mon PM + Tue-Thu full + Fri AM collapses to one block with both half flags", () => {
    const entries = [
      entry(1, "2026-07-13", "PM"),
      ...["2026-07-14", "2026-07-15", "2026-07-16"].flatMap((date) => [entry(1, date, "AM" as Period), entry(1, date, "PM" as Period)]),
      entry(1, "2026-07-17", "AM"),
    ];
    const blocks = collapseLeaveEntries(entries);
    expect(blocks).toEqual([
      { doctor_id: 1, start_date: "2026-07-13", end_date: "2026-07-17", period: "BOTH", half_start: true, half_end: true },
    ]);
  });

  it("Wed PM + Thu AM, nothing else, collapses to one block with both half flags", () => {
    const blocks = collapseLeaveEntries([entry(1, "2026-07-15", "PM"), entry(1, "2026-07-16", "AM")]);
    expect(blocks).toEqual([
      { doctor_id: 1, start_date: "2026-07-15", end_date: "2026-07-16", period: "BOTH", half_start: true, half_end: true },
    ]);
  });

  it("an interior half day splits the run into two blocks", () => {
    const entries = [
      ...["2026-07-13", "2026-07-14"].flatMap((date) => [entry(1, date, "AM" as Period), entry(1, date, "PM" as Period)]),
      entry(1, "2026-07-15", "AM"),
      ...["2026-07-16", "2026-07-17"].flatMap((date) => [entry(1, date, "AM" as Period), entry(1, date, "PM" as Period)]),
    ];
    const blocks = collapseLeaveEntries(entries);
    expect(blocks).toEqual([
      { doctor_id: 1, start_date: "2026-07-13", end_date: "2026-07-15", period: "BOTH", half_start: false, half_end: true },
      { doctor_id: 1, start_date: "2026-07-16", end_date: "2026-07-17", period: "BOTH", half_start: false, half_end: false },
    ]);
  });

  it("a multi-day half-day run is never absorbed into the following full day", () => {
    const entries = [entry(1, "2026-07-13", "AM"), entry(1, "2026-07-14", "AM"), entry(1, "2026-07-15", "AM"), entry(1, "2026-07-15", "PM")];
    const blocks = collapseLeaveEntries(entries);
    expect(blocks).toEqual([
      { doctor_id: 1, start_date: "2026-07-13", end_date: "2026-07-14", period: "AM", half_start: false, half_end: false },
      { doctor_id: 1, start_date: "2026-07-15", end_date: "2026-07-15", period: "BOTH", half_start: false, half_end: false },
    ]);
  });

  it("a Saturday entry between a Friday and a Monday entry collapses to three blocks", () => {
    const entries = ["2026-07-17", "2026-07-18", "2026-07-20"].flatMap((date) => [
      entry(1, date, "AM" as Period),
      entry(1, date, "PM" as Period),
    ]);
    const blocks = collapseLeaveEntries(entries);
    expect(blocks).toEqual([
      { doctor_id: 1, start_date: "2026-07-17", end_date: "2026-07-17", period: "BOTH", half_start: false, half_end: false },
      { doctor_id: 1, start_date: "2026-07-18", end_date: "2026-07-18", period: "BOTH", half_start: false, half_end: false },
      { doctor_id: 1, start_date: "2026-07-20", end_date: "2026-07-20", period: "BOTH", half_start: false, half_end: false },
    ]);
  });

  it("a weekend day with AM+PM alone collapses to one single-date BOTH block", () => {
    const blocks = collapseLeaveEntries([entry(1, "2026-07-18", "AM"), entry(1, "2026-07-18", "PM")]);
    expect(blocks).toEqual([
      { doctor_id: 1, start_date: "2026-07-18", end_date: "2026-07-18", period: "BOTH", half_start: false, half_end: false },
    ]);
  });

  it("groups two doctors with interleaved dates by doctor, ascending doctor_id, chronological within a doctor", () => {
    const entries = [
      entry(2, "2026-07-14", "AM"),
      entry(2, "2026-07-14", "PM"),
      entry(1, "2026-07-16", "AM"),
      entry(1, "2026-07-16", "PM"),
      entry(2, "2026-07-13", "AM"),
      entry(2, "2026-07-13", "PM"),
      entry(1, "2026-07-15", "AM"),
      entry(1, "2026-07-15", "PM"),
    ];
    const blocks = collapseLeaveEntries(entries);
    expect(blocks).toEqual([
      { doctor_id: 1, start_date: "2026-07-15", end_date: "2026-07-16", period: "BOTH", half_start: false, half_end: false },
      { doctor_id: 2, start_date: "2026-07-13", end_date: "2026-07-14", period: "BOTH", half_start: false, half_end: false },
    ]);
  });

  it("is insensitive to input order", () => {
    const inOrder = ["2026-07-13", "2026-07-14", "2026-07-15"].flatMap((date) => [
      entry(1, date, "AM" as Period),
      entry(1, date, "PM" as Period),
    ]);
    const shuffled = [inOrder[3], inOrder[0], inOrder[5], inOrder[1], inOrder[4], inOrder[2]];
    expect(collapseLeaveEntries(shuffled)).toEqual(collapseLeaveEntries(inOrder));
  });

  describe("round trip with expandLeaveRange", () => {
    const edgeCombinations: { firstDay: FirstDayOption; lastDay: LastDayOption }[] = [
      { firstDay: "FULL", lastDay: "FULL" },
      { firstDay: "PM_ONLY", lastDay: "FULL" },
      { firstDay: "FULL", lastDay: "AM_ONLY" },
      { firstDay: "PM_ONLY", lastDay: "AM_ONLY" },
    ];

    // 2026-07-06 is a Monday, 2026-07-24 is a Friday: both weekday endpoints,
    // spanning several weeks and weekends, as required for the inverse to exist.
    const start = "2026-07-06";
    const end = "2026-07-24";

    it.each(edgeCombinations)("collapses back to one block for edges $firstDay/$lastDay", ({ firstDay, lastDay }) => {
      const segments = expandLeaveRange(start, end, firstDay, lastDay);
      const keys = segmentsToSessionKeys(segments);

      const entries: LeaveEntry[] = [];
      for (const key of keys) {
        const [date, period] = key.split("|") as [string, Period];
        const day = new Date(`${date}T00:00:00`).getDay();
        if (day >= 1 && day <= 5) {
          entries.push(entry(1, date, period));
        }
      }

      const blocks = collapseLeaveEntries(entries);
      expect(blocks).toEqual([
        {
          doctor_id: 1,
          start_date: start,
          end_date: end,
          period: "BOTH",
          half_start: firstDay === "PM_ONLY",
          half_end: lastDay === "AM_ONLY",
        },
      ]);
    });
  });

  it("delete exactness: every block's date span contains exactly the entries it was built from", () => {
    const entries = [
      entry(1, "2026-07-13", "PM"),
      entry(1, "2026-07-14", "AM"),
      entry(1, "2026-07-14", "PM"),
      entry(1, "2026-07-15", "AM"),
      entry(1, "2026-07-15", "PM"),
      entry(1, "2026-07-16", "AM"),
      entry(1, "2026-07-18", "AM"),
      entry(1, "2026-07-18", "PM"),
      entry(2, "2026-07-13", "AM"),
      entry(2, "2026-07-17", "AM"),
      entry(2, "2026-07-17", "PM"),
      entry(2, "2026-07-20", "AM"),
      entry(2, "2026-07-20", "PM"),
    ];

    const blocks = collapseLeaveEntries(entries);
    expect(blocks.length).toBeGreaterThan(0);

    function expandedPeriods(block: LeaveBlock): Period[] {
      return block.period === "BOTH" ? ["AM", "PM"] : [block.period];
    }

    for (const block of blocks) {
      const inSpan = entries.filter(
        (e) => e.doctor_id === block.doctor_id && e.date >= block.start_date && e.date <= block.end_date,
      );
      const matching = inSpan.filter((e) => expandedPeriods(block).includes(e.period));

      const builtFrom: LeaveEntry[] = [];
      for (let date = block.start_date; date <= block.end_date; date = addDays(date, 1)) {
        for (const period of expandedPeriods(block)) {
          const isHalfStartEdge = block.half_start && date === block.start_date && period === "AM";
          const isHalfEndEdge = block.half_end && date === block.end_date && period === "PM";
          if (isHalfStartEdge || isHalfEndEdge) continue;
          const found = entries.find((e) => e.doctor_id === block.doctor_id && e.date === date && e.period === period);
          if (found) builtFrom.push(found);
        }
      }

      expect(new Set(matching.map((e) => e.id))).toEqual(new Set(builtFrom.map((e) => e.id)));
    }
  });
});
