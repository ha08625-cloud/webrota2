import { describe, expect, it } from "vitest";

import { makeClinicType, makeDoctor, makeRoom } from "@/test/fixtures/reference";
import { makeRota, makeRotaSession } from "@/test/fixtures/rota";
import { formatDate } from "@/lib/date";
import { BACKGROUND_HEX, CLOSED_COLUMN_HEX, FONT_HEX, ROOM_OCCUPIED_HEX, argb } from "@/lib/exportStyles";

import { buildRotaWorkbook } from "./exportRota";

/**
 * Builder tests reload the produced Blob through a fresh ExcelJS workbook
 * rather than inspecting buildRotaWorkbook's in-memory sheet objects -
 * this asserts against the serialised .xlsx artefact (what the user
 * actually opens), so a future exceljs upgrade that changes in-memory
 * shapes but keeps the file format intact won't false-fail here.
 */
function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  // Not blob.arrayBuffer(): this suite runs under jsdom (vite_config.ts),
  // whose Blob does not implement that method. FileReader is the one
  // Blob-reading path jsdom fully supports, so it's used here even
  // though production code (downloadBlob in RotaDetailPage.tsx) has no
  // reason to touch it.
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
  // exceljs's Buffer type doesn't line up with a browser ArrayBuffer;
  // this is a test helper only, so a loose cast is a reasonable trade-off
  // over importing Node's Buffer type into a browser-targeted project.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await workbook.xlsx.load(buffer as any);
  return workbook;
}

interface RichTextRun {
  text: string;
  font?: { bold?: boolean; color?: { argb?: string }; size?: number };
}

/**
 * Content cells now carry rich text (bold per run, plain string for
 * everything else) so a trailing note can stay unbold in the same cell
 * as bold role/room lines. This reassembles the plain string for tests
 * that only care about displayed text, independent of that run split.
 */
function textOf(cellValue: unknown): string {
  if (typeof cellValue === "string") return cellValue;
  if (cellValue !== null && typeof cellValue === "object" && "richText" in cellValue) {
    return (cellValue as { richText: RichTextRun[] }).richText.map((run) => run.text).join("");
  }
  return "";
}

function richTextOf(cellValue: unknown): RichTextRun[] {
  if (cellValue !== null && typeof cellValue === "object" && "richText" in cellValue) {
    return (cellValue as { richText: RichTextRun[] }).richText;
  }
  throw new Error("Expected a rich text cell value");
}

const START_DATE = "2026-07-06"; // Monday, matches makeRota's own default.
const MONDAY = "2026-07-06";
const THURSDAY = "2026-07-09";

const DOCTOR_COL = 1;
const SESSION_COL = 2;
const MONDAY_COL = 3;
const TUESDAY_COL = 4;
const WEDNESDAY_COL = 5;
const THURSDAY_COL = 6;
const FRIDAY_COL = 7;

describe("buildRotaWorkbook", () => {
  const doctor1 = makeDoctor({ id: 1, code: "AB", doctor_type: "Partner" });
  const doctor2 = makeDoctor({ id: 2, code: "CD", doctor_type: "Trainee" });
  const room = makeRoom({ id: 10, code: "C1", room_type: "C" });
  const clinicType = makeClinicType({ id: 20, name: "Diabetic clinic", category: null });

  const sessions = [
    // Monday AM: duty, no room -> "Duty", black font, duty background.
    makeRotaSession({ session_id: 1, doctor_id: 1, week: 1, day: "Monday", period: "AM", role: "duty_primary" }),
    // Monday PM: named clinic in a C room -> role label + room code, red font.
    makeRotaSession({
      session_id: 2,
      doctor_id: 1,
      week: 1,
      day: "Monday",
      period: "PM",
      role: "clinic",
      clinic_type_id: 20,
      clinic_type_name: "Diabetic clinic",
      room_id: 10,
      room_code: "C1",
    }),
    // Tuesday AM: on leave -> LEAVE only, suppressing everything else.
    makeRotaSession({ session_id: 3, doctor_id: 1, week: 1, day: "Tuesday", period: "AM", is_on_leave: true }),
    // Tuesday PM: a note, no role/room - checks the note travels independently of cell text.
    makeRotaSession({ session_id: 4, doctor_id: 1, week: 1, day: "Tuesday", period: "PM", notes: "Check with reception" }),
    // Wednesday AM: WFH -> "WFH", no fill regardless of any role.
    makeRotaSession({ session_id: 5, doctor_id: 1, week: 1, day: "Wednesday", period: "AM", is_wfh: true }),
    // Wednesday PM: supervising, with a trainee in the same slot to give a non-zero count.
    makeRotaSession({ session_id: 6, doctor_id: 1, week: 1, day: "Wednesday", period: "PM", is_supervising: true }),
    makeRotaSession({ session_id: 7, doctor_id: 2, week: 1, day: "Wednesday", period: "PM" }),
    // Thursday and Friday: deliberately no sessions for doctor1 - Thursday
    // is closed (tests the full-column override), Friday is an ordinary
    // absent cell (tests the part-time-doctor case).
  ];

  const rota = makeRota({
    rota_id: 1,
    status: "committed",
    start_date: START_DATE,
    num_weeks: 1,
    sessions,
    closed_dates: [THURSDAY],
  });

  const closureNameByDate = new Map<string, string | null>([[THURSDAY, "Practice closure"]]);

  async function build() {
    const blob = await buildRotaWorkbook(rota, [doctor1, doctor2], [room], [clinicType], closureNameByDate);
    return reload(blob);
  }

  it("creates one sheet per week, named 'Week N'", async () => {
    const workbook = await build();
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual(["Week 1"]);
  });

  it("creates a sheet for each generation week when num_weeks > 1", async () => {
    const twoWeekRota = makeRota({ ...rota, num_weeks: 2, sessions: [] });
    const blob = await buildRotaWorkbook(twoWeekRota, [doctor1, doctor2], [room], [clinicType], closureNameByDate);
    const workbook = await reload(blob);
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual(["Week 1", "Week 2"]);
  });

  it("lands a fixture doctor on the expected AM/PM row pair, in pivotRota order", async () => {
    const workbook = await build();
    const sheet = workbook.getWorksheet("Week 1")!;
    // doctor1 (Partner) sorts before doctor2 (Trainee) - see pivot.ts.
    expect(sheet.getCell(2, DOCTOR_COL).value).toBe("AB");
    expect(sheet.getCell(2, SESSION_COL).value).toBe("AM");
    expect(sheet.getCell(3, SESSION_COL).value).toBe("PM");
    expect(sheet.getCell(4, DOCTOR_COL).value).toBe("CD");
    expect(sheet.getCell(4, SESSION_COL).value).toBe("AM");
    expect(sheet.getCell(5, SESSION_COL).value).toBe("PM");
  });

  it("renders a duty cell with the Duty label, duty fill, and black font", async () => {
    const workbook = await build();
    const sheet = workbook.getWorksheet("Week 1")!;
    const cell = sheet.getCell(2, MONDAY_COL);
    expect(textOf(cell.value)).toBe("Duty");
    expect(cell.fill).toMatchObject({ fgColor: { argb: argb(BACKGROUND_HEX.duty!) } });
    expect(richTextOf(cell.value)[0].font).toMatchObject({ color: { argb: argb(FONT_HEX.black) } });
  });

  it("renders a named clinic in a C room with the clinic name, room code, clinic fill, and red font", async () => {
    const workbook = await build();
    const sheet = workbook.getWorksheet("Week 1")!;
    const cell = sheet.getCell(3, MONDAY_COL);
    expect(textOf(cell.value)).toBe("Diabetic clinic\nC1");
    expect(cell.fill).toMatchObject({ fgColor: { argb: argb(BACKGROUND_HEX.clinic!) } });
    expect(richTextOf(cell.value)[0].font).toMatchObject({ color: { argb: argb(FONT_HEX.red) } });
  });

  it("renders a leave cell as LEAVE only, with leave fill", async () => {
    const workbook = await build();
    const sheet = workbook.getWorksheet("Week 1")!;
    const cell = sheet.getCell(2, TUESDAY_COL);
    expect(textOf(cell.value)).toBe("LEAVE");
    expect(cell.fill).toMatchObject({ fgColor: { argb: argb(BACKGROUND_HEX.leave!) } });
  });

  it("appends notes after LEAVE when a leave session also has notes", async () => {
    const leaveWithNotes = makeRotaSession({
      session_id: 8,
      doctor_id: 2,
      week: 1,
      day: "Friday",
      period: "AM",
      is_on_leave: true,
      notes: "Back Monday",
    });
    const rotaWithLeaveNote = makeRota({ ...rota, sessions: [...sessions, leaveWithNotes] });
    const blob = await buildRotaWorkbook(
      rotaWithLeaveNote,
      [doctor1, doctor2],
      [room],
      [clinicType],
      closureNameByDate,
    );
    const workbook = await reload(blob);
    const sheet = workbook.getWorksheet("Week 1")!;
    const cell = sheet.getCell(4, FRIDAY_COL);
    expect(textOf(cell.value)).toBe("LEAVE\nBack Monday");
  });

  it("renders the session's notes as a trailing line in the cell text, not a cell comment, and leaves it unbold", async () => {
    const workbook = await build();
    const sheet = workbook.getWorksheet("Week 1")!;
    const cell = sheet.getCell(3, TUESDAY_COL);
    expect(textOf(cell.value)).toBe("Check with reception");
    expect(cell.note).toBeUndefined();
    const runs = richTextOf(cell.value);
    expect(runs).toHaveLength(1);
    // bold:false is the xlsx default, so ExcelJS omits it from the
    // serialised file - reloading gives `undefined`, not `false`.
    expect(runs[0].font?.bold).toBeFalsy();
  });

  it("bolds every content line except a trailing note, in the same cell", async () => {
    const dutyWithNote = makeRotaSession({
      session_id: 9,
      doctor_id: 2,
      week: 1,
      day: "Friday",
      period: "AM",
      role: "duty_primary",
      notes: "Cover until 1pm",
    });
    const rotaWithNote = makeRota({ ...rota, sessions: [...sessions, dutyWithNote] });
    const blob = await buildRotaWorkbook(rotaWithNote, [doctor1, doctor2], [room], [clinicType], closureNameByDate);
    const workbook = await reload(blob);
    const sheet = workbook.getWorksheet("Week 1")!;
    const cell = sheet.getCell(4, FRIDAY_COL); // doctor2's AM row.
    const runs = richTextOf(cell.value);
    expect(runs.map((run) => run.text)).toEqual(["Duty\n", "Cover until 1pm"]);
    expect(runs[0].font?.bold).toBe(true);
    // bold:false is the xlsx default, so ExcelJS omits it from the
    // serialised file - reloading gives `undefined`, not `false`.
    expect(runs[1].font?.bold).toBeFalsy();
  });

  it("renders a WFH cell as WFH with no fill, regardless of any role", async () => {
    const workbook = await build();
    const sheet = workbook.getWorksheet("Week 1")!;
    const cell = sheet.getCell(2, WEDNESDAY_COL);
    expect(textOf(cell.value)).toBe("WFH");
    expect(cell.fill === undefined || (cell.fill as { pattern?: string }).pattern !== "solid").toBe(true);
  });

  it("renders a supervising cell with the supervised trainee count", async () => {
    const workbook = await build();
    const sheet = workbook.getWorksheet("Week 1")!;
    const cell = sheet.getCell(3, WEDNESDAY_COL);
    expect(textOf(cell.value)).toBe("Supervising x 1");
  });

  it("marks a closed-date column: header carries the closure name and full-column fill", async () => {
    const workbook = await build();
    const sheet = workbook.getWorksheet("Week 1")!;
    const header = sheet.getCell(1, THURSDAY_COL);
    expect(header.value).toBe(`Thursday ${formatDate(THURSDAY)}\nPractice closure`);
    expect(header.fill).toMatchObject({ fgColor: { argb: argb(CLOSED_COLUMN_HEX) } });

    for (const row of [2, 3, 4, 5]) {
      const cell = sheet.getCell(row, THURSDAY_COL);
      expect(cell.fill).toMatchObject({ fgColor: { argb: argb(CLOSED_COLUMN_HEX) } });
    }
  });

  it("falls back to 'closed' in the header when no closure name is on record for the date", async () => {
    const blob = await buildRotaWorkbook(rota, [doctor1, doctor2], [room], [clinicType], new Map());
    const workbook = await reload(blob);
    const sheet = workbook.getWorksheet("Week 1")!;
    expect(sheet.getCell(1, THURSDAY_COL).value).toBe(`Thursday ${formatDate(THURSDAY)}\nclosed`);
  });

  it("leaves a header for an ordinary open day unmarked", async () => {
    const workbook = await build();
    const sheet = workbook.getWorksheet("Week 1")!;
    const header = sheet.getCell(1, MONDAY_COL);
    expect(header.value).toBe(`Monday ${formatDate(MONDAY)}`);
    expect(header.fill === undefined || (header.fill as { pattern?: string }).pattern !== "solid").toBe(true);
  });

  it("leaves an absent cell (no template entry for that slot) empty with no fill", async () => {
    const workbook = await build();
    const sheet = workbook.getWorksheet("Week 1")!;
    const amCell = sheet.getCell(2, FRIDAY_COL);
    const pmCell = sheet.getCell(3, FRIDAY_COL);
    expect(amCell.value).toBeNull();
    expect(pmCell.value).toBeNull();
    expect(amCell.fill === undefined || (amCell.fill as { pattern?: string }).pattern !== "solid").toBe(true);
  });

  it("renders staff names bold at 14pt", async () => {
    const workbook = await build();
    const sheet = workbook.getWorksheet("Week 1")!;
    expect(sheet.getCell(2, DOCTOR_COL).font).toMatchObject({ bold: true, size: 14 });
    expect(sheet.getCell(4, DOCTOR_COL).font).toMatchObject({ bold: true, size: 14 });
  });

  it("centres header, doctor, session, and content cell text", async () => {
    const workbook = await build();
    const sheet = workbook.getWorksheet("Week 1")!;
    expect(sheet.getCell(1, DOCTOR_COL).alignment).toMatchObject({ horizontal: "center" });
    expect(sheet.getCell(1, SESSION_COL).alignment).toMatchObject({ horizontal: "center" });
    expect(sheet.getCell(1, MONDAY_COL).alignment).toMatchObject({ horizontal: "center" });
    expect(sheet.getCell(2, DOCTOR_COL).alignment).toMatchObject({ horizontal: "center" });
    expect(sheet.getCell(2, SESSION_COL).alignment).toMatchObject({ horizontal: "center" });
    expect(sheet.getCell(2, MONDAY_COL).alignment).toMatchObject({ horizontal: "center" });
  });

  it("draws a thick line above AM, thin between AM/PM, and thick below PM for each doctor block", async () => {
    const workbook = await build();
    const sheet = workbook.getWorksheet("Week 1")!;
    // doctor1 block: AM row 2, PM row 3.
    expect(sheet.getCell(2, MONDAY_COL).border).toMatchObject({
      top: { style: "thick" },
      bottom: { style: "thin" },
    });
    expect(sheet.getCell(3, MONDAY_COL).border).toMatchObject({
      top: { style: "thin" },
      bottom: { style: "thick" },
    });
    // doctor2 block: AM row 4, PM row 5.
    expect(sheet.getCell(4, MONDAY_COL).border).toMatchObject({
      top: { style: "thick" },
      bottom: { style: "thin" },
    });
    expect(sheet.getCell(5, MONDAY_COL).border).toMatchObject({
      top: { style: "thin" },
      bottom: { style: "thick" },
    });
  });

  it("applies a thick top and bottom border to the merged doctor-name cell", async () => {
    const workbook = await build();
    const sheet = workbook.getWorksheet("Week 1")!;
    expect(sheet.getCell(2, DOCTOR_COL).border).toMatchObject({
      top: { style: "thick" },
      bottom: { style: "thick" },
    });
  });

  it("keeps the thick/thin border scheme intact on an absent (no-session) cell", async () => {
    const workbook = await build();
    const sheet = workbook.getWorksheet("Week 1")!;
    expect(sheet.getCell(2, FRIDAY_COL).border).toMatchObject({
      top: { style: "thick" },
      bottom: { style: "thin" },
    });
  });
});

describe("buildRotaWorkbook room sheets", () => {
  const doctor1 = makeDoctor({ id: 1, code: "AB", doctor_type: "Partner" });
  const roomC1 = makeRoom({ id: 10, code: "C1", room_type: "C" });
  const roomD1 = makeRoom({ id: 11, code: "D1", room_type: "D" });
  const clinicType = makeClinicType({ id: 20, name: "Diabetic clinic", category: null });

  const sessions = [
    // Monday AM: named clinic in C1 -> occupied, clinic name + room code.
    makeRotaSession({
      session_id: 1,
      doctor_id: 1,
      week: 1,
      day: "Monday",
      period: "AM",
      role: "clinic",
      clinic_type_id: 20,
      clinic_type_name: "Diabetic clinic",
      room_id: 10,
      room_code: "C1",
    }),
    // Monday PM: on leave, still holding D1 -> occupied, LEAVE only.
    makeRotaSession({
      session_id: 2,
      doctor_id: 1,
      week: 1,
      day: "Monday",
      period: "PM",
      is_on_leave: true,
      room_id: 11,
      room_code: "D1",
    }),
    // Tuesday AM: supervising in D1 -> occupied, role label + Supervising.
    makeRotaSession({
      session_id: 3,
      doctor_id: 1,
      week: 1,
      day: "Tuesday",
      period: "AM",
      role: "duty_primary",
      is_supervising: true,
      room_id: 11,
      room_code: "D1",
    }),
    // Thursday closed - tests the closed override takes priority over
    // "Available" text. Wednesday and Friday deliberately have no
    // sessions in either room, for the plain "Available" case.
  ];

  const rota = makeRota({
    rota_id: 1,
    status: "committed",
    start_date: START_DATE,
    num_weeks: 1,
    sessions,
    closed_dates: [THURSDAY],
  });

  const closureNameByDate = new Map<string, string | null>([[THURSDAY, "Practice closure"]]);

  async function build() {
    const blob = await buildRotaWorkbook(rota, [doctor1], [roomC1, roomD1], [clinicType], closureNameByDate);
    return reload(blob);
  }

  it("interleaves a 'Room Week N' sheet immediately after each week's doctor sheet", async () => {
    const workbook = await build();
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual(["Week 1", "Room Week 1"]);
  });

  it("interleaves per week when num_weeks > 1", async () => {
    const twoWeekRota = makeRota({ ...rota, num_weeks: 2, sessions: [] });
    const blob = await buildRotaWorkbook(twoWeekRota, [doctor1], [roomC1, roomD1], [clinicType], closureNameByDate);
    const workbook = await reload(blob);
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual(["Week 1", "Room Week 1", "Week 2", "Room Week 2"]);
  });

  it("orders room rows D-type before C-type, per compareRoomDisplayOrder", async () => {
    const workbook = await build();
    const sheet = workbook.getWorksheet("Room Week 1")!;
    // D1 (D-type) sorts before C1 (C-type) - see pivotRoomRota.ts.
    expect(sheet.getCell(2, DOCTOR_COL).value).toBe("D1");
    expect(sheet.getCell(4, DOCTOR_COL).value).toBe("C1");
  });

  it("renders an occupied room with the doctor code, role label, and the muted grey fill", async () => {
    const workbook = await build();
    const sheet = workbook.getWorksheet("Room Week 1")!;
    // D1 is row 2 (AM)/3 (PM); Tuesday is the 4th day column.
    const cell = sheet.getCell(2, TUESDAY_COL);
    expect(cell.value).toBe("AB\nDuty\nSupervising");
    expect(cell.fill).toMatchObject({ fgColor: { argb: argb(ROOM_OCCUPIED_HEX) } });
  });

  it("renders LEAVE only (no role label) for an occupant on leave", async () => {
    const workbook = await build();
    const sheet = workbook.getWorksheet("Room Week 1")!;
    // D1 PM, Monday.
    const cell = sheet.getCell(3, MONDAY_COL);
    expect(cell.value).toBe("AB\nLEAVE");
  });

  it("renders a named clinic with the clinic name in the occupied C-room cell", async () => {
    const workbook = await build();
    const sheet = workbook.getWorksheet("Room Week 1")!;
    // C1 is row 4 (AM)/5 (PM), Monday.
    const cell = sheet.getCell(4, MONDAY_COL);
    expect(cell.value).toBe("AB\nDiabetic clinic");
  });

  it("renders an unoccupied room slot as 'Available' with no fill", async () => {
    const workbook = await build();
    const sheet = workbook.getWorksheet("Room Week 1")!;
    // D1 AM, Wednesday - no session in either fixture room that day.
    const cell = sheet.getCell(2, WEDNESDAY_COL);
    expect(cell.value).toBe("Available");
    expect(cell.fill === undefined || (cell.fill as { pattern?: string }).pattern !== "solid").toBe(true);
  });

  it("leaves a closed-date cell with no 'Available' text, just the closed fill", async () => {
    const workbook = await build();
    const sheet = workbook.getWorksheet("Room Week 1")!;
    const cell = sheet.getCell(2, THURSDAY_COL);
    expect(cell.value).toBeNull();
    expect(cell.fill).toMatchObject({ fgColor: { argb: argb(CLOSED_COLUMN_HEX) } });
  });

  it("carries the thick/thin AM+PM block border scheme onto room rows", async () => {
    const workbook = await build();
    const sheet = workbook.getWorksheet("Room Week 1")!;
    expect(sheet.getCell(2, MONDAY_COL).border).toMatchObject({
      top: { style: "thick" },
      bottom: { style: "thin" },
    });
    expect(sheet.getCell(3, MONDAY_COL).border).toMatchObject({
      top: { style: "thin" },
      bottom: { style: "thick" },
    });
  });
});