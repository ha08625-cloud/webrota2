import { describe, expect, it } from "vitest";

import type { CoverageSlot, MasterSessionType, PlanningAction } from "@/api/types";
import { makeDoctor, makeExtraSessionEntry, makeLeaveEntry } from "@/test/fixtures/reference";
import { makeMasterRotaSession } from "@/test/fixtures/masterRota";

import {
  applyPendingToCoverage,
  buildPlanningActions,
  buildTemplateIndex,
  isInMonth,
  isWithinWindow,
  mergeCellState,
  nextCellState,
  overlapsRange,
  parsePlanningCellKey,
  planningCellKey,
  serverRows,
  stateToAction,
  toCellKeySet,
  toCellState,
  weekdayName,
  weekdaysInMonth,
} from "./planningMonth";

// A Monday, matching the backend suite's own anchor convention. AA is
// doctor 1 (Partner) and BB doctor 2 (Salaried); both work requires_room
// Monday AM and PM on template week 1, so the baseline Monday headcount
// is 2 and every other weekday is 0 - the same world
// tests/test_api/test_leave_planning.py::TestCoverage sets up.
const MONDAY = "2026-08-03";
const TUESDAY = "2026-08-04";

const AA = makeDoctor({ id: 1, code: "AA", doctor_type: "Partner" });
const BB = makeDoctor({ id: 2, code: "BB", doctor_type: "Salaried" });

function templateRow(doctorId: number, day: "Monday" | "Tuesday", period: "AM" | "PM", sessionType: MasterSessionType) {
  return makeMasterRotaSession({ doctor_id: doctorId, week: 1, day, period, session_type: sessionType });
}

const BASE_TEMPLATE = [
  templateRow(1, "Monday", "AM", "requires_room"),
  templateRow(1, "Monday", "PM", "requires_room"),
  templateRow(2, "Monday", "AM", "requires_room"),
  templateRow(2, "Monday", "PM", "requires_room"),
];

function slot(date: string, period: "AM" | "PM", headcount: number, isClosed = false): CoverageSlot {
  return { date, period, headcount, is_closed: isClosed };
}

const BASE_COVERAGE = [
  slot(MONDAY, "AM", 2),
  slot(MONDAY, "PM", 2),
  slot(TUESDAY, "AM", 0),
  slot(TUESDAY, "PM", 0),
];

function pendingMap(entries: [string, PlanningAction][]): Map<string, PlanningAction> {
  return new Map(entries);
}

/** Totals for one slot, with the full world defaulted to the baseline. */
function totalFor(
  date: string,
  period: "AM" | "PM",
  {
    coverage = BASE_COVERAGE,
    pending = new Map<string, PlanningAction>(),
    doctors = [AA, BB],
    sessions = BASE_TEMPLATE,
    leave = [],
    extraSessions = [],
  }: Partial<Parameters<typeof applyPendingToCoverage>[0]> = {},
): number | null | undefined {
  return applyPendingToCoverage({ coverage, pending, doctors, sessions, leave, extraSessions }).get(
    `${date}|${period}`,
  );
}

describe("weekdaysInMonth", () => {
  it("returns every Mon-Fri date of the month as YYYY-MM-DD", () => {
    // 2026-08-01 is a Saturday, so August's own weekdays start on the 3rd
    // with no lead-in borrowed from July.
    const dates = weekdaysInMonth(2026, 8);
    expect(dates).toContain("2026-08-03");
    expect(dates).toContain("2026-08-31");
  });

  it("excludes weekends", () => {
    // 2026-08-01 is a Saturday and 2026-08-02 a Sunday.
    expect(weekdaysInMonth(2026, 8)).not.toContain("2026-08-01");
    expect(weekdaysInMonth(2026, 8)).not.toContain("2026-08-02");
  });

  it("borrows lead-out days from the next month to complete the last week", () => {
    // 2026-08-31 is a Monday, so the grid runs through that week's Friday.
    const dates = weekdaysInMonth(2026, 8);
    expect(dates[dates.length - 1]).toBe("2026-09-04");
    expect(dates).toContain("2026-09-01");
  });

  it("borrows lead-in days from the previous month to complete the first week", () => {
    // 2026-01-01 is a Thursday, so the grid starts from that week's Monday.
    const dates = weekdaysInMonth(2026, 1);
    expect(dates[0]).toBe("2025-12-29");
    expect(dates).toContain("2026-01-01");
  });

  it("pads single-digit months and days", () => {
    expect(weekdaysInMonth(2026, 1)).toContain("2026-01-02");
  });

  it("handles a leap February", () => {
    const dates = weekdaysInMonth(2028, 2);
    expect(dates).toContain("2028-02-29");
  });

  it("rolls a borrowed lead-out week into the next calendar year", () => {
    // 2026-12-31 is a Thursday, so the grid runs one day into January 2027.
    const dates = weekdaysInMonth(2026, 12);
    expect(dates[dates.length - 1]).toBe("2027-01-01");
    expect(dates).toContain("2026-12-31");
  });
});

describe("isInMonth", () => {
  it("is true for a date within the given month", () => {
    expect(isInMonth("2026-08-14", 2026, 8)).toBe(true);
  });

  it("is false for a borrowed lead-in/lead-out date from an adjacent month", () => {
    expect(isInMonth("2026-09-01", 2026, 8)).toBe(false);
    expect(isInMonth("2025-12-29", 2026, 1)).toBe(false);
  });
});

describe("weekdayName", () => {
  it("maps a date onto its template day", () => {
    expect(weekdayName(MONDAY)).toBe("Monday");
    expect(weekdayName("2026-08-07")).toBe("Friday");
  });

  it("returns null for a weekend", () => {
    expect(weekdayName("2026-08-01")).toBeNull();
  });
});

describe("planningCellKey", () => {
  it("round-trips through parsePlanningCellKey", () => {
    expect(parsePlanningCellKey(planningCellKey(7, MONDAY, "PM"))).toEqual({
      doctorId: 7,
      date: MONDAY,
      period: "PM",
    });
  });

  it("returns null for a malformed key", () => {
    expect(parsePlanningCellKey("nonsense")).toBeNull();
    expect(parsePlanningCellKey(`1|${MONDAY}|EVENING`)).toBeNull();
  });
});

describe("cell state machine", () => {
  it("cycles normal -> leave -> extra planned -> normal", () => {
    expect(nextCellState("normal")).toBe("leave");
    expect(nextCellState("leave")).toBe("extra_session");
    expect(nextCellState("extra_session")).toBe("normal");
  });

  it("resolves leave over an extra session where both rows exist", () => {
    expect(toCellState({ hasLeave: true, hasExtra: true })).toBe("leave");
    expect(toCellState({ hasLeave: false, hasExtra: true })).toBe("extra_session");
    expect(toCellState({ hasLeave: false, hasExtra: false })).toBe("normal");
  });

  it("lets a pending edit override the server state, with clear meaning normal", () => {
    expect(mergeCellState("leave", undefined)).toBe("leave");
    expect(mergeCellState("leave", "clear")).toBe("normal");
    expect(mergeCellState("normal", "extra_session")).toBe("extra_session");
  });

  it("maps normal onto the clear action", () => {
    expect(stateToAction("normal")).toBe("clear");
    expect(stateToAction("leave")).toBe("leave");
    expect(stateToAction("extra_session")).toBe("extra_session");
  });
});

describe("isWithinWindow", () => {
  it("treats a null bound as unbounded", () => {
    expect(isWithinWindow({ start_date: null, end_date: null }, MONDAY)).toBe(true);
  });

  it("includes both bounds", () => {
    expect(isWithinWindow({ start_date: MONDAY, end_date: MONDAY }, MONDAY)).toBe(true);
  });

  it("excludes dates before the start and after the end", () => {
    expect(isWithinWindow({ start_date: TUESDAY, end_date: null }, MONDAY)).toBe(false);
    expect(isWithinWindow({ start_date: null, end_date: MONDAY }, TUESDAY)).toBe(false);
  });
});

describe("overlapsRange", () => {
  it("includes a doctor who leaves mid-range", () => {
    expect(overlapsRange({ start_date: null, end_date: "2026-08-12" }, "2026-08-03", "2026-08-31")).toBe(true);
  });

  it("includes a doctor who joins mid-range", () => {
    expect(overlapsRange({ start_date: "2026-08-12", end_date: null }, "2026-08-03", "2026-08-31")).toBe(true);
  });

  it("excludes a window entirely before or after the range", () => {
    expect(overlapsRange({ start_date: null, end_date: "2026-07-31" }, "2026-08-03", "2026-08-31")).toBe(false);
    expect(overlapsRange({ start_date: "2026-09-01", end_date: null }, "2026-08-03", "2026-08-31")).toBe(false);
  });
});

describe("buildTemplateIndex", () => {
  it("keeps week 1 rows only (Design Decision 1)", () => {
    const index = buildTemplateIndex([
      templateRow(1, "Monday", "AM", "requires_room"),
      makeMasterRotaSession({ doctor_id: 1, week: 2, day: "Tuesday", period: "AM", session_type: "requires_room" }),
    ]);
    expect(index.get("1|Monday|AM")).toBe("requires_room");
    expect(index.has("1|Tuesday|AM")).toBe(false);
  });
});

// The matrix below mirrors tests/test_api/test_leave_planning.py::TestCoverage
// case for case. If the server's rules change, both must change together
// - a divergence here shows up as a total row that jumps when the page
// refetches after a save.
describe("applyPendingToCoverage", () => {
  it("returns the server's own headcount where there are no pending edits", () => {
    expect(totalFor(MONDAY, "AM")).toBe(2);
    expect(totalFor(TUESDAY, "AM")).toBe(0);
  });

  it("renders a closed slot as null, not zero", () => {
    expect(totalFor(MONDAY, "AM", { coverage: [slot(MONDAY, "AM", 0, true)] })).toBeNull();
  });

  it("drops one from the headcount for pending leave on a working slot", () => {
    expect(
      totalFor(MONDAY, "AM", {
        pending: pendingMap([[planningCellKey(1, MONDAY, "AM"), "leave"]]),
      }),
    ).toBe(1);
  });

  it("leaves the other period of the same day alone", () => {
    expect(
      totalFor(MONDAY, "PM", {
        pending: pendingMap([[planningCellKey(1, MONDAY, "AM"), "leave"]]),
      }),
    ).toBe(2);
  });

  it("adds one for a pending extra session on a no_surgery slot", () => {
    expect(
      totalFor(TUESDAY, "AM", {
        sessions: [...BASE_TEMPLATE, templateRow(1, "Tuesday", "AM", "no_surgery")],
        pending: pendingMap([[planningCellKey(1, TUESDAY, "AM"), "extra_session"]]),
      }),
    ).toBe(1);
  });

  it("adds one for a pending extra session where there is no template row at all", () => {
    expect(
      totalFor(TUESDAY, "PM", {
        pending: pendingMap([[planningCellKey(2, TUESDAY, "PM"), "extra_session"]]),
      }),
    ).toBe(1);
  });

  it("does not double-count an extra session on a slot already requires_room", () => {
    // Design Decision 4: the override is conditional, so a flat +1 would
    // over-count a doctor who was already working the slot.
    expect(
      totalFor(MONDAY, "AM", {
        pending: pendingMap([[planningCellKey(1, MONDAY, "AM"), "extra_session"]]),
      }),
    ).toBe(2);
  });

  it("counts the doctor back in when a leave cell is moved to extra planned", () => {
    // Not a contradiction of the server's "leave wins": moving the cell
    // off leave is exactly what the click means, and buildPlanningActions
    // emits the matching `clear` so the saved state agrees.
    expect(
      totalFor(MONDAY, "AM", {
        leave: [makeLeaveEntry({ doctor_id: 1, date: MONDAY, period: "AM" })],
        // Server headcount already reflects the leave.
        coverage: [slot(MONDAY, "AM", 1)],
        pending: pendingMap([[planningCellKey(1, MONDAY, "AM"), "extra_session"]]),
      }),
    ).toBe(2);
  });

  it("treats a slot carrying both rows as leave, so clearing it counts the doctor back in once", () => {
    expect(
      totalFor(MONDAY, "AM", {
        leave: [makeLeaveEntry({ doctor_id: 1, date: MONDAY, period: "AM" })],
        extraSessions: [makeExtraSessionEntry({ doctor_id: 1, date: MONDAY, period: "AM" })],
        coverage: [slot(MONDAY, "AM", 1)],
        pending: pendingMap([[planningCellKey(1, MONDAY, "AM"), "clear"]]),
      }),
    ).toBe(2);
  });

  it.each(["admin_time", "wfh", "no_surgery"] as const)(
    "counts a %s slot as zero when cleared back to normal",
    (sessionType) => {
      // Doctor 1's Monday AM is non-clinical, so the server's headcount is
      // 1; clearing an existing extra session there takes it back to 0.
      expect(
        totalFor(MONDAY, "AM", {
          sessions: [templateRow(1, "Monday", "AM", sessionType), templateRow(2, "Monday", "PM", "requires_room")],
          coverage: [slot(MONDAY, "AM", 1)],
          extraSessions: [makeExtraSessionEntry({ doctor_id: 1, date: MONDAY, period: "AM" })],
          pending: pendingMap([[planningCellKey(1, MONDAY, "AM"), "clear"]]),
        }),
      ).toBe(0);
    },
  );

  it("counts a pre_assigned slot as working", () => {
    // Clearing an extra session on a pre_assigned slot changes nothing:
    // the doctor was already counted either way.
    expect(
      totalFor(TUESDAY, "AM", {
        sessions: [...BASE_TEMPLATE, templateRow(1, "Tuesday", "AM", "pre_assigned")],
        coverage: [slot(TUESDAY, "AM", 1)],
        extraSessions: [makeExtraSessionEntry({ doctor_id: 1, date: TUESDAY, period: "AM" })],
        pending: pendingMap([[planningCellKey(1, TUESDAY, "AM"), "clear"]]),
      }),
    ).toBe(1);
  });

  it("restores the headcount when existing leave is cleared", () => {
    expect(
      totalFor(MONDAY, "AM", {
        leave: [makeLeaveEntry({ doctor_id: 1, date: MONDAY, period: "AM" })],
        coverage: [slot(MONDAY, "AM", 1)],
        pending: pendingMap([[planningCellKey(1, MONDAY, "AM"), "clear"]]),
      }),
    ).toBe(2);
  });

  it("ignores a pending edit on a doctor outside their employment window", () => {
    const leaver = makeDoctor({ id: 3, code: "CC", doctor_type: "Partner", end_date: "2026-07-31" });
    expect(
      totalFor(MONDAY, "AM", {
        doctors: [AA, BB, leaver],
        sessions: [...BASE_TEMPLATE, templateRow(3, "Monday", "AM", "requires_room")],
        pending: pendingMap([[planningCellKey(3, MONDAY, "AM"), "leave"]]),
      }),
    ).toBe(2);
  });

  it("ignores a pending edit on a doctor with no visible row (e.g. a Trainee)", () => {
    expect(
      totalFor(MONDAY, "AM", {
        pending: pendingMap([[planningCellKey(99, MONDAY, "AM"), "leave"]]),
      }),
    ).toBe(2);
  });

  it("ignores a pending edit on a closed slot", () => {
    expect(
      totalFor(MONDAY, "AM", {
        coverage: [slot(MONDAY, "AM", 0, true)],
        pending: pendingMap([[planningCellKey(1, MONDAY, "AM"), "leave"]]),
      }),
    ).toBeNull();
  });

  it("ignores a pending edit outside the fetched range", () => {
    const totals = applyPendingToCoverage({
      coverage: [slot(MONDAY, "AM", 2)],
      pending: pendingMap([[planningCellKey(1, "2026-09-07", "AM"), "leave"]]),
      doctors: [AA, BB],
      sessions: BASE_TEMPLATE,
      leave: [],
      extraSessions: [],
    });
    expect(totals.get(`${MONDAY}|AM`)).toBe(2);
    expect(totals.get("2026-09-07|AM")).toBeUndefined();
  });

  it("accumulates several pending edits on the same slot", () => {
    expect(
      totalFor(MONDAY, "AM", {
        pending: pendingMap([
          [planningCellKey(1, MONDAY, "AM"), "leave"],
          [planningCellKey(2, MONDAY, "AM"), "leave"],
        ]),
      }),
    ).toBe(0);
  });

  it("reads zero cover with no active template, rather than throwing", () => {
    expect(
      totalFor(MONDAY, "AM", {
        sessions: [],
        coverage: [slot(MONDAY, "AM", 0)],
        pending: pendingMap([[planningCellKey(1, MONDAY, "AM"), "leave"]]),
      }),
    ).toBe(0);
  });
});

describe("buildPlanningActions", () => {
  const key = planningCellKey(1, MONDAY, "AM");

  function actionsFor(
    action: PlanningAction,
    { leave = false, extra = false } = {},
  ) {
    return buildPlanningActions({
      pending: pendingMap([[key, action]]),
      leaveKeys: leave ? new Set([key]) : new Set(),
      extraKeys: extra ? new Set([key]) : new Set(),
    });
  }

  it("emits a single leave action on an empty cell", () => {
    expect(actionsFor("leave")).toEqual([
      { doctor_id: 1, date: MONDAY, period: "AM", action: "leave" },
    ]);
  });

  it("emits a single extra_session action on an empty cell", () => {
    expect(actionsFor("extra_session")).toEqual([
      { doctor_id: 1, date: MONDAY, period: "AM", action: "extra_session" },
    ]);
  });

  it("emits a clear for a cell being emptied", () => {
    expect(actionsFor("clear", { leave: true })).toEqual([
      { doctor_id: 1, date: MONDAY, period: "AM", action: "clear" },
    ]);
  });

  it("clears the existing leave before adding an extra session", () => {
    // Without the clear the endpoint would skip the extra session as
    // "leave_exists" and the saved state would not match the grid.
    expect(actionsFor("extra_session", { leave: true })).toEqual([
      { doctor_id: 1, date: MONDAY, period: "AM", action: "clear" },
      { doctor_id: 1, date: MONDAY, period: "AM", action: "extra_session" },
    ]);
  });

  it("clears the existing extra session before adding leave", () => {
    // Otherwise the extra session survives and comes back as a
    // superseded-extra-session warning the admin did not ask for.
    expect(actionsFor("leave", { extra: true })).toEqual([
      { doctor_id: 1, date: MONDAY, period: "AM", action: "clear" },
      { doctor_id: 1, date: MONDAY, period: "AM", action: "leave" },
    ]);
  });

  it("emits nothing for a pending state that already matches the server", () => {
    expect(actionsFor("leave", { leave: true })).toEqual([]);
    expect(actionsFor("clear")).toEqual([]);
  });

  it("skips a malformed key rather than posting garbage", () => {
    expect(
      buildPlanningActions({
        pending: pendingMap([["nonsense", "leave"]]),
        leaveKeys: new Set(),
        extraKeys: new Set(),
      }),
    ).toEqual([]);
  });
});

describe("toCellKeySet / serverRows", () => {
  it("builds membership keys matching planningCellKey", () => {
    const keys = toCellKeySet([makeLeaveEntry({ doctor_id: 4, date: MONDAY, period: "PM" })]);
    expect(serverRows(keys, new Set(), planningCellKey(4, MONDAY, "PM"))).toEqual({
      hasLeave: true,
      hasExtra: false,
    });
  });
});
