import { describe, expect, it } from "vitest";

import type { Period } from "@/api/types";
import { makeClinicType, makeDoctor, makeRoom } from "@/test/fixtures/reference";
import { makeRota, makeRotaSession } from "@/test/fixtures/rota";
import { BACKGROUND_HEX, CLOSED_COLUMN_HEX, FONT_HEX } from "@/lib/exportStyles";
import { DAYS } from "@/lib/pivot";

import {
  buildRotaPdfModel,
  chooseBodyFontSize,
  FONT_SIZE_CANDIDATES,
  type PdfCell,
  type PdfPage,
  type PdfRow,
} from "./rotaPdfModel";

/**
 * These tests use the same fixtures as exportRota.test.ts on purpose: the
 * two exports share exportContent.ts, so a regression in the shared
 * content logic should fail in both suites rather than in one.
 *
 * There is no `import("pdfmake")` anywhere in this file or in the module
 * under test - this suite passes with pdfmake uninstalled (Design
 * Decision 5).
 */

/** Full-day closed slots (both AM and PM) for the given dates. */
function fullDaySlots(dates: string[]) {
  return dates.flatMap((date) => [
    { date, period: "AM" as const },
    { date, period: "PM" as const },
  ]);
}

/** The single-week rota shape most of these tests build on. */
function oneWeekRota(overrides: Parameters<typeof makeRota>[0] = {}) {
  return makeRota({ num_weeks: 1, start_date: "2026-07-06", ...overrides });
}

const NO_CLOSURE_NAMES = new Map<string, string | null>();

function cellAt(page: PdfPage, rowIndex: number, day: (typeof DAYS)[number]): PdfCell {
  return page.rows[rowIndex].cells[DAYS.indexOf(day)];
}

describe("buildRotaPdfModel", () => {
  it("emits one page per generation week, titled by week-commencing date", () => {
    const rota = makeRota({ num_weeks: 3, start_date: "2026-07-06" });

    const doc = buildRotaPdfModel(rota, [], [], [], NO_CLOSURE_NAMES);

    expect(doc.pages.map((page) => page.title)).toEqual([
      "w/c 6 Jul 2026",
      "w/c 13 Jul 2026",
      "w/c 20 Jul 2026",
    ]);
  });

  it("emits two rows per doctor, AM then PM, with the label on the AM row only", () => {
    const doctor = makeDoctor({ code: "AA" });
    const rota = oneWeekRota();

    const [page] = buildRotaPdfModel(rota, [doctor], [], [], NO_CLOSURE_NAMES).pages;

    expect(page.rows).toHaveLength(2);
    expect(page.rows.map((row: PdfRow) => row.period)).toEqual(["AM", "PM"]);
    expect(page.rows.map((row: PdfRow) => row.doctorLabel)).toEqual(["AA", null]);
    expect(page.rows[0].cells).toHaveLength(DAYS.length);
  });

  it("orders rows by pivotRota display order (type, then code)", () => {
    const doctors = [
      makeDoctor({ code: "ZP", doctor_type: "Partner" }),
      makeDoctor({ code: "AT", doctor_type: "Trainee" }),
      makeDoctor({ code: "AS", doctor_type: "Salaried" }),
      makeDoctor({ code: "AP", doctor_type: "Partner" }),
    ];

    const [page] = buildRotaPdfModel(oneWeekRota(), doctors, [], [], NO_CLOSURE_NAMES).pages;

    expect(page.rows.filter((row: PdfRow) => row.doctorLabel !== null).map((row) => row.doctorLabel)).toEqual([
      "AP",
      "ZP",
      "AS",
      "AT",
    ]);
  });

  it("flags an inactive doctor who still has sessions in this rota", () => {
    const inactive = makeDoctor({ code: "XX", active: false });
    const rota = oneWeekRota({
      sessions: [makeRotaSession({ doctor_id: inactive.id, doctor_code: "XX" })],
    });

    const [page] = buildRotaPdfModel(rota, [inactive], [], [], NO_CLOSURE_NAMES).pages;

    expect(page.rows[0].doctorLabel).toBe("XX (inactive)");
  });

  it("takes cell text from the shared cellLines logic", () => {
    const doctor = makeDoctor({ code: "AA" });
    const room = makeRoom({ code: "D1", room_type: "D" });
    const clinicType = makeClinicType({ name: "Diabetic" });
    const rota = oneWeekRota({
      sessions: [
        makeRotaSession({
          doctor_id: doctor.id,
          day: "Monday",
          period: "AM",
          role: "clinic",
          clinic_type_id: clinicType.id,
          clinic_type_name: "Diabetic",
          room_id: room.id,
          room_code: "D1",
        }),
        makeRotaSession({ doctor_id: doctor.id, day: "Tuesday", period: "PM", is_on_leave: true }),
      ],
    });

    const [page] = buildRotaPdfModel(rota, [doctor], [room], [clinicType], NO_CLOSURE_NAMES).pages;

    expect(cellAt(page, 0, "Monday").lines).toEqual(["Diabetic", "D1"]);
    expect(cellAt(page, 1, "Tuesday").lines).toEqual(["LEAVE"]);
  });

  it("leaves an absent cell empty and unfilled", () => {
    const doctor = makeDoctor({ code: "AA" });

    const [page] = buildRotaPdfModel(oneWeekRota(), [doctor], [], [], NO_CLOSURE_NAMES).pages;

    expect(cellAt(page, 0, "Wednesday")).toEqual({
      lines: [],
      fillHex: null,
      fontHex: FONT_HEX.black,
      isNote: false,
    });
  });

  it("marks a trailing note so the PDF layer can leave it unbold", () => {
    const doctor = makeDoctor({ code: "AA" });
    const rota = oneWeekRota({
      sessions: [
        makeRotaSession({
          doctor_id: doctor.id,
          day: "Monday",
          period: "AM",
          role: "duty_primary",
          notes: "back late",
        }),
        makeRotaSession({ doctor_id: doctor.id, day: "Tuesday", period: "AM", role: "duty_primary" }),
      ],
    });

    const [page] = buildRotaPdfModel(rota, [doctor], [], [], NO_CLOSURE_NAMES).pages;

    expect(cellAt(page, 0, "Monday").lines).toEqual(["Duty", "back late"]);
    expect(cellAt(page, 0, "Monday").isNote).toBe(true);
    expect(cellAt(page, 0, "Tuesday").isNote).toBe(false);
  });

  it("resolves colours through cellStyle and the shared hex maps", () => {
    const doctor = makeDoctor({ code: "AA" });
    const wolvercote = makeRoom({ code: "W1", room_type: "W" });
    const cuttestlowe = makeRoom({ code: "C1", room_type: "C" });
    const rota = oneWeekRota({
      sessions: [
        makeRotaSession({
          doctor_id: doctor.id,
          day: "Monday",
          period: "AM",
          role: "duty_primary",
          room_id: wolvercote.id,
          room_code: "W1",
        }),
        makeRotaSession({
          doctor_id: doctor.id,
          day: "Tuesday",
          period: "AM",
          role: "clinic",
          room_id: cuttestlowe.id,
          room_code: "C1",
        }),
        makeRotaSession({
          doctor_id: doctor.id,
          day: "Wednesday",
          period: "AM",
          template_type: "no_surgery",
        }),
      ],
    });

    const [page] = buildRotaPdfModel(rota, [doctor], [wolvercote, cuttestlowe], [], NO_CLOSURE_NAMES).pages;

    expect(cellAt(page, 0, "Monday").fillHex).toBe(BACKGROUND_HEX.duty);
    expect(cellAt(page, 0, "Monday").fontHex).toBe(FONT_HEX.blue);
    expect(cellAt(page, 0, "Tuesday").fillHex).toBe(BACKGROUND_HEX.clinic);
    expect(cellAt(page, 0, "Tuesday").fontHex).toBe(FONT_HEX.red);
    expect(cellAt(page, 0, "Wednesday").fillHex).toBe(BACKGROUND_HEX.no_surgery);
  });

  it("uses compact day headers", () => {
    const [page] = buildRotaPdfModel(oneWeekRota(), [], [], [], NO_CLOSURE_NAMES).pages;

    expect(page.dayHeaders.map((header) => header.text)).toEqual([
      "MON 6th",
      "TUE 7th",
      "WED 8th",
      "THU 9th",
      "FRI 10th",
    ]);
    expect(page.dayHeaders.every((header) => !header.closed)).toBe(true);
  });

  it("greys a closed column full height and flags its header", () => {
    const doctor = makeDoctor({ code: "AA" });
    const rota = oneWeekRota({ closed_slots: fullDaySlots(["2026-07-08"]) });
    const closureNames = new Map<string, string | null>([["2026-07-08", "Training"]]);

    const [page] = buildRotaPdfModel(rota, [doctor], [], [], closureNames).pages;

    expect(page.dayHeaders[2]).toEqual({ text: "WED 8th\nTraining", closed: true });
    expect(cellAt(page, 0, "Wednesday").fillHex).toBe(CLOSED_COLUMN_HEX);
    expect(cellAt(page, 1, "Wednesday").fillHex).toBe(CLOSED_COLUMN_HEX);
    expect(cellAt(page, 0, "Tuesday").fillHex).toBeNull();
  });

  it("names that week's closures in the title, de-duplicated", () => {
    const rota = makeRota({
      num_weeks: 2,
      start_date: "2026-07-06",
      closed_slots: [
        ...fullDaySlots(["2026-07-08", "2026-07-09"]),
        ...fullDaySlots(["2026-07-16"]),
      ],
    });
    const closureNames = new Map<string, string | null>([
      ["2026-07-08", "Training"],
      ["2026-07-09", "Training"],
      ["2026-07-16", "Bank Holiday"],
    ]);

    const doc = buildRotaPdfModel(rota, [], [], [], closureNames);

    expect(doc.pages[0].title).toBe("w/c 6 Jul 2026 — Training");
    expect(doc.pages[1].title).toBe("w/c 13 Jul 2026 — Bank Holiday");
  });

  it("omits an unnamed closure from the title", () => {
    const rota = oneWeekRota({ closed_slots: fullDaySlots(["2026-07-08"]) });

    const doc = buildRotaPdfModel(rota, [], [], [], new Map([["2026-07-08", null]]));

    expect(doc.pages[0].title).toBe("w/c 6 Jul 2026");
  });

  it("gives the whole document one body font size, the smallest any page needs", () => {
    const doc = buildRotaPdfModel(oneWeekRota(), [makeDoctor({ code: "AA" })], [], [], NO_CLOSURE_NAMES);

    expect(doc.bodyFontSize).toBe(Math.min(...doc.pages.map(chooseBodyFontSize)));
    expect(FONT_SIZE_CANDIDATES).toContain(doc.bodyFontSize);
  });
});

/* ------------------------------------------------------------------ */

/**
 * Builds a synthetic page directly rather than through a rota: the fit
 * search cares only about row count and cell line lengths, and driving it
 * from raw geometry keeps these cases readable at the sizes that matter
 * (21 doctors is the real practice's size).
 */
function pageWith(doctorCount: number, linesPerCell: string[]): PdfPage {
  const rows: PdfRow[] = [];
  for (let i = 0; i < doctorCount; i++) {
    for (const period of ["AM", "PM"] as Period[]) {
      rows.push({
        period,
        doctorLabel: period === "AM" ? `D${i}` : null,
        cells: DAYS.map(() => ({
          lines: linesPerCell,
          fillHex: null,
          fontHex: FONT_HEX.black,
          isNote: false,
        })),
      });
    }
  }
  return { title: "w/c 6 Jul 2026", dayHeaders: [], rows };
}

describe("chooseBodyFontSize", () => {
  it("gives a small practice the largest candidate", () => {
    expect(chooseBodyFontSize(pageWith(6, ["Duty", "D1"]))).toBe(FONT_SIZE_CANDIDATES[0]);
  });

  it("shrinks a 21-doctor practice with two-line cells to 6-7pt", () => {
    const size = chooseBodyFontSize(pageWith(21, ["Diabetic", "W1"]));

    expect(size).toBeGreaterThanOrEqual(6);
    expect(size).toBeLessThanOrEqual(7);
  });

  it("falls through to the smallest candidate rather than going illegible", () => {
    const size = chooseBodyFontSize(pageWith(21, ["WFH", "Supervising x 3", "Diabetic", "W1", "back late"]));

    expect(size).toBe(FONT_SIZE_CANDIDATES[FONT_SIZE_CANDIDATES.length - 1]);
  });

  it("counts a long line as the several wrapped lines it will become", () => {
    const short = pageWith(14, ["Duty"]);
    const long = pageWith(14, ["Duty".padEnd(120, " x")]);

    expect(chooseBodyFontSize(long)).toBeLessThan(chooseBodyFontSize(short));
  });

  it("treats an all-absent row as one line high, not zero", () => {
    const empty = pageWith(200, []);

    // 400 rows of a single line cannot fit an A4 page at any candidate
    // size; a zero-height row would have wrongly reported a fit at 9pt.
    expect(chooseBodyFontSize(empty)).toBe(FONT_SIZE_CANDIDATES[FONT_SIZE_CANDIDATES.length - 1]);
  });
});
