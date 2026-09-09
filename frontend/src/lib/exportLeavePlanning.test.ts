import { describe, expect, it } from "vitest";

import type { CoverageSlot, Doctor, Period } from "@/api/types";
import {
  makeBlockedEntry,
  makeDoctor,
  makeExtraSessionEntry,
  makeFullDayClosure,
  makeLeaveEntitlement,
  makeLeaveEntry,
  makeSchool,
  makeSchoolHoliday,
} from "@/test/fixtures/reference";
import { makeMasterRotaSession } from "@/test/fixtures/masterRota";
import {
  CLOSED_COLUMN_HEX,
  LEAVE_CELL_HEX,
  NO_SURGERY_HEX,
  OUT_OF_WINDOW_HEX,
  SCHOOL_HOLIDAY_HEX,
  argb,
} from "@/lib/exportStyles";
import { weekdaysInMonth } from "@/lib/planningMonth";

import { buildLeavePlanningWorkbook, type LeavePlanningExportInput } from "./exportLeavePlanning";

/**
 * As in exportRota.test.ts: assertions run against the *serialised*
 * .xlsx read back through a fresh exceljs workbook, not the in-memory
 * sheet objects the builder wrote, so this tests the artefact the user
 * actually opens.
 */
function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  // jsdom's Blob has no arrayBuffer(); FileReader is the one path it
  // fully supports. Test-only, same as the rota export's suite.
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsArrayBuffer(blob);
  });
}

async function reload(blob: Blob) {
  const ExcelJS = await import("exceljs");
  const buffer = await blobToArrayBuffer(blob);
  const workbook = new ExcelJS.Workbook();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await workbook.xlsx.load(buffer as any);
  return workbook;
}

const YEAR = 2026;
const LABEL_COL = 1;
const FIRST_DATE_COL = 3;

const MARCH_DATES = weekdaysInMonth(YEAR, 3);
/** Monday 2 March 2026 - the first column of the March sheet, and a date
 * every doctor in these fixtures is employed on. */
const MONDAY = MARCH_DATES[0];

function dateColumn(dates: string[], date: string): number {
  return FIRST_DATE_COL + dates.indexOf(date);
}

/** First row whose label column reads `label`. Merged AM/PM label cells
 * report the master's value on both rows, so this lands on the AM row. */
function rowWithLabel(sheet: import("exceljs").Worksheet, label: string): number {
  for (let row = 1; row <= sheet.rowCount; row++) {
    if (sheet.getCell(row, LABEL_COL).value === label) return row;
  }
  throw new Error(`No row labelled "${label}"`);
}

function hasLabel(sheet: import("exceljs").Worksheet, label: string): boolean {
  for (let row = 1; row <= sheet.rowCount; row++) {
    if (sheet.getCell(row, LABEL_COL).value === label) return true;
  }
  return false;
}

function fillArgb(cell: import("exceljs").Cell): string | undefined {
  const fill = cell.fill;
  if (fill === undefined || fill.type !== "pattern") return undefined;
  return fill.fgColor?.argb;
}

/** Full clinical cover for every slot of the given dates. */
function fullCoverage(dates: string[], headcount = 5): CoverageSlot[] {
  return dates.flatMap((date) =>
    (["AM", "PM"] as Period[]).map((period) => ({
      date,
      period,
      headcount,
      is_closed: false,
    })),
  );
}

const partner = makeDoctor({ code: "AA", doctor_type: "Partner" });
const leaver = makeDoctor({ code: "AB", doctor_type: "Salaried", end_date: "2026-03-15" });
const locum = makeDoctor({ code: "LC", doctor_type: "Locum" });
const trainee = makeDoctor({ code: "TR", doctor_type: "Trainee" });

function makeInput(overrides: Partial<LeavePlanningExportInput> = {}): LeavePlanningExportInput {
  return {
    year: YEAR,
    doctors: [partner, leaver, locum, trainee],
    entitlements: [
      makeLeaveEntitlement({ doctor_id: partner.id, doctor_code: partner.code, doctor_type: "Partner" }),
      makeLeaveEntitlement({ doctor_id: leaver.id, doctor_code: leaver.code }),
      makeLeaveEntitlement({ doctor_id: trainee.id, doctor_code: trainee.code, doctor_type: "Trainee" }),
    ],
    leave: [],
    extraSessions: [],
    blocked: [],
    closures: [],
    schools: [],
    // Only the partner's Monday AM is a surgery session; everything else
    // falls through to the no-surgery grey.
    templateSessions: [
      makeMasterRotaSession({ doctor_id: partner.id, day: "Monday", period: "AM", session_type: "requires_room" }),
    ],
    coverageByMonth: new Map([[3, fullCoverage(MARCH_DATES)]]),
    exportedAt: new Date("2026-03-02T09:30:00Z"),
    ...overrides,
  };
}

async function buildMarch(overrides: Partial<LeavePlanningExportInput> = {}) {
  const workbook = await reload(await buildLeavePlanningWorkbook(makeInput(overrides)));
  return workbook.getWorksheet("March")!;
}

describe("buildLeavePlanningWorkbook", () => {
  it("produces a Summary sheet and twelve month sheets, named and ordered", async () => {
    const workbook = await reload(await buildLeavePlanningWorkbook(makeInput()));

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "Summary",
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ]);
  });

  it("gives every month a sheet even with nothing planned in it", async () => {
    const workbook = await reload(await buildLeavePlanningWorkbook(makeInput()));

    // No leave, no coverage fetched for November - the sheet is still
    // there, with its doctor rows and a cover row reading "-".
    const november = workbook.getWorksheet("November")!;
    expect(rowWithLabel(november, partner.code)).toBeGreaterThan(1);
    const coverRow = rowWithLabel(november, "Clinical cover");
    expect(november.getCell(coverRow, FIRST_DATE_COL).value).toBe("—");
  });

  it("drops a mid-year leaver from months after their end date", async () => {
    const workbook = await reload(await buildLeavePlanningWorkbook(makeInput()));

    expect(hasLabel(workbook.getWorksheet("March")!, leaver.code)).toBe(true);
    expect(hasLabel(workbook.getWorksheet("June")!, leaver.code)).toBe(false);
    // ...and still has a Summary row, because they appear on a month sheet.
    expect(hasLabel(workbook.getWorksheet("Summary")!, leaver.code)).toBe(true);
  });

  it("gives a locum a Summary row with dashes rather than dropping them", async () => {
    const summary = (await reload(await buildLeavePlanningWorkbook(makeInput()))).getWorksheet("Summary")!;
    const row = rowWithLabel(summary, locum.code);

    expect(summary.getCell(row, 2).value).toBe("Locum");
    // Entitlement, carry-over, adjustment, booked, used, remaining.
    for (let col = 3; col <= 8; col++) {
      expect(summary.getCell(row, col).value).toBe("—");
    }
  });

  it("carries the two integrity flags on the Summary sheet", async () => {
    const input = makeInput({
      entitlements: [
        makeLeaveEntitlement({
          doctor_id: partner.id,
          doctor_code: partner.code,
          doctor_type: "Partner",
          entitlement_sessions: "36.5",
          used_sessions: 4,
          booked_sessions: 5,
          sessions_mismatch: true,
          exempt_by_reason: { closed: 1, weekend: 0, no_template_row: 3, no_surgery: 2 },
        }),
      ],
    });
    const summary = (await reload(await buildLeavePlanningWorkbook(input))).getWorksheet("Summary")!;
    const row = rowWithLabel(summary, partner.code);

    // Numbers, not display strings: a text cell cannot be summed.
    expect(summary.getCell(row, 3).value).toBe(36.5);
    expect(summary.getCell(row, 6).value).toBe(5);
    expect(summary.getCell(row, 7).value).toBe(4);
    expect(summary.getCell(row, 9).value).toBe("Yes");
    expect(summary.getCell(row, 10).value).toBe(3);
  });

  it("labels the export as saved data only", async () => {
    const summary = (await reload(await buildLeavePlanningWorkbook(makeInput()))).getWorksheet("Summary")!;

    expect(summary.getCell(1, 1).value).toBe(`Annual leave plan ${YEAR}`);
    expect(String(summary.getCell(2, 1).value)).toMatch(/^Exported .* — saved data only$/);
  });

  it("puts trainees below a divider that says they are not counted", async () => {
    const march = await buildMarch();

    const divider = rowWithLabel(march, "Trainees — not counted in clinical cover");
    expect(rowWithLabel(march, partner.code)).toBeLessThan(divider);
    expect(rowWithLabel(march, trainee.code)).toBeGreaterThan(divider);
    expect(divider).toBeLessThan(rowWithLabel(march, "Clinical cover"));
  });

  it("writes a state letter for a plain leave cell and the note when there is one", async () => {
    const march = await buildMarch({
      leave: [
        makeLeaveEntry({ doctor_id: partner.id, date: MONDAY, period: "AM" }),
        makeLeaveEntry({ doctor_id: partner.id, date: MONDAY, period: "PM", notes: "Conference" }),
      ],
      extraSessions: [makeExtraSessionEntry({ doctor_id: leaver.id, date: MONDAY, period: "AM" })],
      blocked: [makeBlockedEntry({ doctor_id: leaver.id, date: MONDAY, period: "PM", notes: null })],
    });

    const col = dateColumn(MARCH_DATES, MONDAY);
    const partnerRow = rowWithLabel(march, partner.code);
    const leaverRow = rowWithLabel(march, leaver.code);

    expect(march.getCell(partnerRow, col).value).toBe("L");
    expect(fillArgb(march.getCell(partnerRow, col))).toBe(argb(LEAVE_CELL_HEX.leave!));
    // The note wins over the letter - the state is still carried by colour.
    expect(march.getCell(partnerRow + 1, col).value).toBe("Conference");
    expect(fillArgb(march.getCell(partnerRow + 1, col))).toBe(argb(LEAVE_CELL_HEX.leave!));
    expect(march.getCell(leaverRow, col).value).toBe("E");
    expect(march.getCell(leaverRow + 1, col).value).toBe("B");
  });

  it("greys a normal cell that is not a surgery session and leaves a surgery one unfilled", async () => {
    const march = await buildMarch();
    const col = dateColumn(MARCH_DATES, MONDAY);
    const partnerRow = rowWithLabel(march, partner.code);

    // Monday AM is requires_room in the template; Monday PM is not.
    expect(fillArgb(march.getCell(partnerRow, col))).toBeUndefined();
    expect(fillArgb(march.getCell(partnerRow + 1, col))).toBe(argb(NO_SURGERY_HEX));
    expect(march.getCell(partnerRow, col).value).toBeNull();
  });

  it("leaves a closed slot blank with the closed fill", async () => {
    const march = await buildMarch({
      closures: makeFullDayClosure({ date: MONDAY, name: "Training" }),
      // A leave row on a closed slot must not resurrect the cell's text.
      leave: [makeLeaveEntry({ doctor_id: partner.id, date: MONDAY, period: "AM" })],
    });

    const col = dateColumn(MARCH_DATES, MONDAY);
    const partnerRow = rowWithLabel(march, partner.code);

    expect(march.getCell(partnerRow, col).value).toBeNull();
    expect(fillArgb(march.getCell(partnerRow, col))).toBe(argb(CLOSED_COLUMN_HEX));
    expect(fillArgb(march.getCell(1, col))).toBe(argb(CLOSED_COLUMN_HEX));
  });

  it("greys the cells of a doctor's row outside their employment window", async () => {
    const march = await buildMarch();
    const leaverRow = rowWithLabel(march, leaver.code);
    const afterEnd = MARCH_DATES.find((date) => date > leaver.end_date!)!;

    const cell = march.getCell(leaverRow, dateColumn(MARCH_DATES, afterEnd));
    expect(cell.value).toBeNull();
    expect(fillArgb(cell)).toBe(argb(OUT_OF_WINDOW_HEX));
  });

  it("shades school-holiday dates on a row per school with a holiday in view", async () => {
    const inHoliday = MARCH_DATES[1];
    const march = await buildMarch({
      schools: [
        makeSchool({
          name: "St Mary's Primary",
          holidays: [makeSchoolHoliday({ start_date: inHoliday, end_date: inHoliday })],
        }),
        // No holiday anywhere in March - no row at all, same as the page.
        makeSchool({ name: "Northgate High", holidays: [] }),
      ],
    });

    const row = rowWithLabel(march, "St Mary's Primary");
    expect(fillArgb(march.getCell(row, dateColumn(MARCH_DATES, inHoliday)))).toBe(argb(SCHOOL_HOLIDAY_HEX));
    expect(fillArgb(march.getCell(row, dateColumn(MARCH_DATES, MONDAY)))).toBeUndefined();
    expect(hasLabel(march, "Northgate High")).toBe(false);
  });

  it("merges each Weekly cover cell across its five columns and totals its dailies", async () => {
    const march = await buildMarch();

    const coverRow = rowWithLabel(march, "Clinical cover");
    const weeklyRow = coverRow + 2;
    expect(march.getCell(weeklyRow, LABEL_COL).value).toBe("Weekly cover");

    const first = march.getCell(weeklyRow, FIRST_DATE_COL);
    for (let offset = 1; offset < 5; offset++) {
      expect(march.getCell(weeklyRow, FIRST_DATE_COL + offset).master.address).toBe(first.address);
    }
    expect(march.getCell(weeklyRow, FIRST_DATE_COL + 5).master.address).not.toBe(first.address);

    // Five weekdays x AM+PM x headcount 5.
    let dailySum = 0;
    for (let offset = 0; offset < 5; offset++) {
      dailySum += Number(march.getCell(coverRow, FIRST_DATE_COL + offset).value);
      dailySum += Number(march.getCell(coverRow + 1, FIRST_DATE_COL + offset).value);
    }
    expect(first.value).toBe(dailySum);
    expect(dailySum).toBe(50);
  });

  it("shows a closed cover slot as a dash rather than zero", async () => {
    const coverage = fullCoverage(MARCH_DATES).map((slot) =>
      slot.date === MONDAY && slot.period === "AM"
        ? { ...slot, headcount: 0, is_closed: true }
        : slot,
    );
    const march = await buildMarch({ coverageByMonth: new Map([[3, coverage]]) });

    const coverRow = rowWithLabel(march, "Clinical cover");
    expect(march.getCell(coverRow, dateColumn(MARCH_DATES, MONDAY)).value).toBe("—");
  });
});
