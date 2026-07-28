import { describe, it, expect } from "vitest";

import { makeClosure, makeFullDayClosure } from "@/test/fixtures/reference";

import { buildColumns, firstOpenWeekday, weekDutySlots } from "./dutyWeekSlots";
import { toClosedSlotSet } from "./closedSlots";

const MONDAY = "2026-01-05";

describe("firstOpenWeekday", () => {
  // Mirrors backend TestBuildFirstOpenWeekday (test_closures.py).
  it("is Monday for an open week", () => {
    expect(firstOpenWeekday(MONDAY, new Set())).toBe("2026-01-05");
  });

  it("is Tuesday when Monday is fully closed", () => {
    const closed = toClosedSlotSet(makeFullDayClosure({ date: "2026-01-05" }));
    expect(firstOpenWeekday(MONDAY, closed)).toBe("2026-01-06");
  });

  it("is Tuesday when Monday is only partly closed (PM only)", () => {
    const closed = toClosedSlotSet([makeClosure({ date: "2026-01-05", period: "PM" })]);
    expect(firstOpenWeekday(MONDAY, closed)).toBe("2026-01-06");
  });

  it("is Wednesday when Monday and Tuesday are both fully closed", () => {
    const closed = toClosedSlotSet([
      ...makeFullDayClosure({ date: "2026-01-05" }),
      ...makeFullDayClosure({ date: "2026-01-06" }),
    ]);
    expect(firstOpenWeekday(MONDAY, closed)).toBe("2026-01-07");
  });

  it("is null when the whole week is closed", () => {
    const closed = toClosedSlotSet(
      ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"].flatMap((date) =>
        makeFullDayClosure({ date }),
      ),
    );
    expect(firstOpenWeekday(MONDAY, closed)).toBe(null);
  });
});

describe("buildColumns", () => {
  it("with no closures, matches the pre-M5 layout exactly", () => {
    const columns = buildColumns(MONDAY);
    expect(columns.map((c) => c.label)).toEqual(["Mon (1st)", "Mon (2nd)", "Tue", "Wed", "Thu", "Fri"]);
    expect(columns.every((c) => !c.fullyClosed)).toBe(true);
  });

  it("a fully closed Monday becomes one inert column, and Tuesday gains the secondary pair", () => {
    const columns = buildColumns(MONDAY, makeFullDayClosure({ date: MONDAY }));
    expect(columns.map((c) => c.label)).toEqual(["Mon", "Tue (1st)", "Tue (2nd)", "Wed", "Thu", "Fri"]);
    expect(columns[0].fullyClosed).toBe(true);
    expect(columns[0].dutyType).toBe(null);
    expect(columns[1].dutyType).toBe("primary");
    expect(columns[2].dutyType).toBe("secondary");
  });

  it("a partly closed Monday (PM only) is an ordinary open column, and secondary stays on Monday", () => {
    const columns = buildColumns(MONDAY, [makeClosure({ date: MONDAY, period: "PM" })]);
    expect(columns.map((c) => c.label)).toEqual(["Mon", "Tue (1st)", "Tue (2nd)", "Wed", "Thu", "Fri"]);
    const mon = columns.find((c) => c.date === MONDAY)!;
    expect(mon.fullyClosed).toBe(false);
    expect(mon.dutyType).toBe("primary");
  });

  it("a fully closed week is five inert columns", () => {
    const closures = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"].flatMap(
      (date) => makeFullDayClosure({ date }),
    );
    const columns = buildColumns(MONDAY, closures);
    expect(columns).toHaveLength(5);
    expect(columns.every((c) => c.fullyClosed && c.dutyType === null)).toBe(true);
  });
});

describe("weekDutySlots", () => {
  it("returns exactly 12 required duty slots for an open week", () => {
    const slots = weekDutySlots(MONDAY);

    expect(slots).toHaveLength(12);
    expect(slots.filter((s) => s.dutyType === "secondary")).toHaveLength(2);
    expect(slots.filter((s) => s.dutyType === "primary")).toHaveLength(10);
    expect(slots.some((s) => s.date === "2026-01-06")).toBe(true);
    expect(slots.some((s) => s.date === "2026-01-09")).toBe(true);
  });

  it("returns 10 slots when Monday is fully closed (secondary moves to Tuesday)", () => {
    const slots = weekDutySlots(MONDAY, makeFullDayClosure({ date: MONDAY }));

    expect(slots).toHaveLength(10);
    expect(slots.every((s) => s.date !== MONDAY)).toBe(true);
    expect(slots.filter((s) => s.dutyType === "secondary")).toHaveLength(2);
    expect(slots.filter((s) => s.dutyType === "secondary").every((s) => s.date === "2026-01-06")).toBe(true);
    expect(slots.filter((s) => s.dutyType === "primary")).toHaveLength(8);
  });

  it("returns 11 slots when Monday is only partly closed (PM only)", () => {
    const slots = weekDutySlots(MONDAY, [makeClosure({ date: MONDAY, period: "PM" })]);

    expect(slots).toHaveLength(11);
    expect(slots.some((s) => s.date === MONDAY && s.period === "AM" && s.dutyType === "primary")).toBe(true);
    expect(slots.some((s) => s.date === MONDAY && s.period === "PM")).toBe(false);
    // Monday keeps the secondary pair, since it's the first fully-open... no,
    // Monday is only partly open here, so secondary must NOT sit on Monday.
    expect(slots.filter((s) => s.dutyType === "secondary").every((s) => s.date === "2026-01-06")).toBe(true);
  });

  it("returns 8 slots when Monday and Tuesday are both fully closed", () => {
    const slots = weekDutySlots(MONDAY, [
      ...makeFullDayClosure({ date: "2026-01-05" }),
      ...makeFullDayClosure({ date: "2026-01-06" }),
    ]);

    expect(slots).toHaveLength(8);
    expect(slots.filter((s) => s.dutyType === "secondary").every((s) => s.date === "2026-01-07")).toBe(true);
  });

  it("returns no slots for a fully closed week", () => {
    const closures = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08", "2026-01-09"].flatMap(
      (date) => makeFullDayClosure({ date }),
    );
    expect(weekDutySlots(MONDAY, closures)).toHaveLength(0);
  });
});
