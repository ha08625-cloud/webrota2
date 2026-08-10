import { describe, expect, it } from "vitest";

import { makeDoctor } from "@/test/fixtures/reference";
import { makeRotaSession } from "@/test/fixtures/rota";
import { formatDate } from "@/lib/date";

import {
  buildSupervisedCounts,
  cellLines,
  compactDayHeaderText,
  dayHeaderText,
  roleLabelText,
  roomCellLines,
  supervisedCountKey,
  toIdMap,
} from "./exportContent";

/**
 * These functions were previously private to exportRota.ts and only
 * covered indirectly, through assertions on the produced .xlsx artefact.
 * Now that both exports consume them, they are tested directly here -
 * exportRota.test.ts keeps its artefact-level coverage of the Excel
 * rendering, and the PDF export will rely on this suite for content.
 */

const NO_CLOSURES = new Set<string>();
const NO_CLOSURE_NAMES = new Map<string, string | null>();

describe("roleLabelText", () => {
  it("maps each role to its grid label", () => {
    expect(roleLabelText("duty_primary", null)).toBe("Duty");
    expect(roleLabelText("duty_secondary", null)).toBe("Duty (2nd)");
    expect(roleLabelText("clinic", "Diabetic")).toBe("Diabetic");
  });

  it("falls back to 'Clinic' for a clinic role with no clinic name", () => {
    expect(roleLabelText("clinic", null)).toBe("Clinic");
  });

  it("returns null for a null role", () => {
    expect(roleLabelText(null, "Diabetic")).toBeNull();
  });
});

describe("cellLines", () => {
  it("suppresses everything but a note when on leave", () => {
    const session = makeRotaSession({
      is_on_leave: true,
      is_wfh: true,
      is_supervising: true,
      role: "duty_primary",
      room_code: "D1",
      template_type: "no_surgery",
    });
    expect(cellLines(session, 3)).toEqual(["LEAVE"]);
  });

  it("keeps a trailing note alongside LEAVE", () => {
    const session = makeRotaSession({ is_on_leave: true, notes: "back Thursday" });
    expect(cellLines(session, 0)).toEqual(["LEAVE", "back Thursday"]);
  });

  it("ignores a whitespace-only note", () => {
    const session = makeRotaSession({ role: "duty_primary", notes: "   " });
    expect(cellLines(session, 0)).toEqual(["Duty"]);
  });

  it("suppresses the room code when WFH, but not the role label", () => {
    const session = makeRotaSession({ is_wfh: true, role: "duty_primary", room_code: "D1" });
    expect(cellLines(session, 0)).toEqual(["WFH", "Duty"]);
  });

  it("shows the room code when not WFH", () => {
    const session = makeRotaSession({ role: "clinic", clinic_type_name: "Diabetic", room_code: "W2" });
    expect(cellLines(session, 0)).toEqual(["Diabetic", "W2"]);
  });

  it("qualifies Supervising with the trainee count when there is one", () => {
    const session = makeRotaSession({ is_supervising: true });
    expect(cellLines(session, 2)).toEqual(["Supervising x 2"]);
  });

  it("shows a bare Supervising when the count is zero", () => {
    const session = makeRotaSession({ is_supervising: true });
    expect(cellLines(session, 0)).toEqual(["Supervising"]);
  });

  it("shows No surgery / Admin only when the role is null", () => {
    expect(cellLines(makeRotaSession({ template_type: "no_surgery" }), 0)).toEqual(["No surgery"]);
    expect(cellLines(makeRotaSession({ template_type: "admin_time" }), 0)).toEqual(["Admin"]);

    const withRole = makeRotaSession({ template_type: "no_surgery", role: "duty_primary" });
    expect(cellLines(withRole, 0)).toEqual(["Duty"]);
  });

  it("orders WFH, Supervising, Admin, role, room, note", () => {
    const session = makeRotaSession({
      is_wfh: true,
      is_supervising: true,
      template_type: "admin_time",
      role: null,
      notes: "half day",
    });
    expect(cellLines(session, 1)).toEqual(["WFH", "Supervising x 1", "Admin", "half day"]);
  });

  it("puts the note last, after the room code", () => {
    const session = makeRotaSession({ role: "duty_secondary", room_code: "C3", notes: "phone only" });
    expect(cellLines(session, 0)).toEqual(["Duty (2nd)", "C3", "phone only"]);
  });

  it("returns no lines for a bare session", () => {
    expect(cellLines(makeRotaSession(), 0)).toEqual([]);
  });
});

describe("roomCellLines", () => {
  it("leads with the occupying doctor's code", () => {
    const session = makeRotaSession({ doctor_code: "XY", role: "duty_primary" });
    expect(roomCellLines(session)).toEqual(["XY", "Duty"]);
  });

  it("shows LEAVE instead of the role label, and never a note", () => {
    const session = makeRotaSession({
      doctor_code: "XY",
      is_on_leave: true,
      role: "duty_primary",
      is_supervising: true,
      notes: "back Thursday",
    });
    expect(roomCellLines(session)).toEqual(["XY", "LEAVE"]);
  });

  it("appends a bare Supervising - never a count, unlike cellLines", () => {
    const session = makeRotaSession({ doctor_code: "XY", is_supervising: true, role: "clinic", clinic_type_name: "Diabetic" });
    expect(roomCellLines(session)).toEqual(["XY", "Diabetic", "Supervising"]);
  });
});

describe("dayHeaderText", () => {
  const DATE = "2026-07-06";

  it("is day name plus formatted date when the day is open", () => {
    expect(dayHeaderText("Monday", DATE, NO_CLOSURES, NO_CLOSURE_NAMES)).toBe(`Monday ${formatDate(DATE)}`);
  });

  it("appends the closure name on a second line when fully closed", () => {
    const closed = new Set([`${DATE}|AM`, `${DATE}|PM`]);
    const names = new Map([[DATE, "Bank Holiday"]]);
    expect(dayHeaderText("Monday", DATE, closed, names)).toBe(`Monday ${formatDate(DATE)}\nBank Holiday`);
  });

  it("qualifies a partial closure with the closed period", () => {
    const closed = new Set([`${DATE}|PM`]);
    const names = new Map([[DATE, "Training"]]);
    expect(dayHeaderText("Monday", DATE, closed, names)).toBe(`Monday ${formatDate(DATE)}\nTraining (PM)`);
  });

  it("falls back to 'closed' when the live closures list has no name", () => {
    const closed = new Set([`${DATE}|AM`, `${DATE}|PM`]);
    expect(dayHeaderText("Monday", DATE, closed, NO_CLOSURE_NAMES)).toBe(`Monday ${formatDate(DATE)}\nclosed`);
  });
});

describe("compactDayHeaderText", () => {
  it("is an uppercase 3-letter day plus the ordinal day of month", () => {
    expect(compactDayHeaderText("Monday", "2026-08-10", NO_CLOSURES, NO_CLOSURE_NAMES)).toBe("MON 10th");
    expect(compactDayHeaderText("Wednesday", "2026-08-12", NO_CLOSURES, NO_CLOSURE_NAMES)).toBe("WED 12th");
    expect(compactDayHeaderText("Friday", "2026-08-14", NO_CLOSURES, NO_CLOSURE_NAMES)).toBe("FRI 14th");
  });

  it("uses the right ordinal suffix, including the 11-13 exceptions", () => {
    const suffixFor = (date: string) =>
      compactDayHeaderText("Monday", date, NO_CLOSURES, NO_CLOSURE_NAMES).replace("MON ", "");
    expect(suffixFor("2026-06-01")).toBe("1st");
    expect(suffixFor("2026-06-02")).toBe("2nd");
    expect(suffixFor("2026-06-03")).toBe("3rd");
    expect(suffixFor("2026-06-04")).toBe("4th");
    expect(suffixFor("2026-06-11")).toBe("11th");
    expect(suffixFor("2026-06-12")).toBe("12th");
    expect(suffixFor("2026-06-13")).toBe("13th");
    expect(suffixFor("2026-06-21")).toBe("21st");
    expect(suffixFor("2026-06-22")).toBe("22nd");
    expect(suffixFor("2026-06-23")).toBe("23rd");
    expect(suffixFor("2026-06-30")).toBe("30th");
    expect(suffixFor("2026-05-31")).toBe("31st");
  });

  it("carries the same closure suffix behaviour as dayHeaderText", () => {
    const date = "2026-08-10";
    const fullyClosed = new Set([`${date}|AM`, `${date}|PM`]);
    const partlyClosed = new Set([`${date}|AM`]);
    const names = new Map([[date, "Bank Holiday"]]);

    expect(compactDayHeaderText("Monday", date, fullyClosed, names)).toBe("MON 10th\nBank Holiday");
    expect(compactDayHeaderText("Monday", date, partlyClosed, names)).toBe("MON 10th\nBank Holiday (AM)");
    expect(compactDayHeaderText("Monday", date, fullyClosed, NO_CLOSURE_NAMES)).toBe("MON 10th\nclosed");
  });
});

describe("toIdMap", () => {
  it("keys items by id", () => {
    const map = toIdMap([{ id: 2, code: "B" }, { id: 7, code: "G" }]);
    expect(map.get(2)?.code).toBe("B");
    expect(map.get(7)?.code).toBe("G");
    expect(map.size).toBe(2);
  });
});

describe("buildSupervisedCounts", () => {
  it("counts supervisable trainees per week/day/period", () => {
    const doctors = [
      makeDoctor({ id: 1, code: "AA", doctor_type: "Partner" }),
      makeDoctor({ id: 2, code: "T1", doctor_type: "Trainee" }),
      makeDoctor({ id: 3, code: "T2", doctor_type: "Trainee" }),
    ];
    const sessions = [
      makeRotaSession({ doctor_id: 2, week: 1, day: "Monday", period: "AM" }),
      makeRotaSession({ doctor_id: 3, week: 1, day: "Monday", period: "AM" }),
      // Not countable: on leave.
      makeRotaSession({ doctor_id: 2, week: 1, day: "Tuesday", period: "AM", is_on_leave: true }),
      // Not countable: not a trainee.
      makeRotaSession({ doctor_id: 1, week: 2, day: "Friday", period: "PM" }),
    ];

    const counts = buildSupervisedCounts(sessions, doctors, [1, 2]);

    expect(counts.get(supervisedCountKey(1, "Monday", "AM"))).toBe(2);
    expect(counts.get(supervisedCountKey(1, "Tuesday", "AM"))).toBe(0);
    expect(counts.get(supervisedCountKey(2, "Friday", "PM"))).toBe(0);
    // One entry per week x day x period, so every key the render loop
    // asks for is present.
    expect(counts.size).toBe(2 * 5 * 2);
  });
});
