import type {
  BlockedEntry,
  Closure,
  CoverageSlot,
  Doctor,
  ExtraSessionEntry,
  LeaveEntitlement,
  LeaveEntry,
  MasterRotaSession,
  MasterSessionType,
  School,
} from "@/api/types";
import { closedSlotKey, isDayFullyClosed, isSlotClosed, toClosedSlotSet } from "@/lib/closedSlots";
import { formatDateTime, parseLocalDate } from "@/lib/date";
import {
  AM_ROW_BORDER,
  CENTERED,
  CENTERED_WRAPPED,
  PM_ROW_BORDER,
  THICK_SIDE,
  THIN_SIDE,
} from "@/lib/exportLayout";
import {
  CLOSED_COLUMN_HEX,
  LEAVE_CELL_FONT_HEX,
  LEAVE_CELL_HEX,
  LEAVE_MUTED_FONT_HEX,
  NO_SURGERY_HEX,
  OUT_OF_MONTH_HEX,
  OUT_OF_WINDOW_HEX,
  SCHOOL_HOLIDAY_HEX,
  argb,
  coverageFillHex,
} from "@/lib/exportStyles";
import { compareDoctorDisplayOrder } from "@/lib/groupDoctors";
import {
  PLANNING_PERIODS,
  type PlanningCellState,
  buildTemplateIndex,
  chunkIntoWeeks,
  isInMonth,
  isSurgerySession,
  isWithinWindow,
  overlapsRange,
  planningCellKey,
  schoolHolidayDatesInRange,
  serverNotes,
  serverRows,
  templateKey,
  toCellKeySet,
  toCellState,
  toNotesMap,
  weekdayName,
  weekdaysInMonth,
  weeklyTotal,
} from "@/lib/planningMonth";

/**
 * Excel export builder for the Annual Leave Planner (leave-planner Excel
 * export plan, Task 2). Pure: no React, no DOM APIs, no top-level
 * dependency on exceljs (see the dynamic import below) - takes plain data
 * and returns a Blob, so it can be unit tested directly in Node/Vitest.
 *
 * One workbook per leave year (which is the calendar year - see
 * app/leave_entitlement.py), laid out as a Summary sheet followed by
 * twelve month sheets, January to December. Each month sheet mirrors
 * LeavePlanningGrid.tsx: the same `weekdaysInMonth` columns (padded
 * lead-in/lead-out days included and shaded, exactly as on screen), the
 * same school-holiday rows, the same AM/PM doctor blocks, and the same
 * Clinical cover / Weekly cover footer.
 *
 * Cell *state* logic is not reimplemented here - planningMonth.ts is the
 * authority for all of it (`toCellState`, `serverNotes`, `isWithinWindow`,
 * `isSurgerySession`, `chunkIntoWeeks`, `weeklyTotal`), which is what
 * keeps the sheet and the screen from drifting apart. This file owns only
 * the exceljs rendering, and colour, which exportStyles.ts holds as
 * hexes kept in sync by hand.
 *
 * Two deliberate divergences from the screen:
 *
 * - **Saved data only.** Pending (unsaved) edits are never exported, so
 *   the totals row is the server's own coverage baseline verbatim and
 *   `applyPendingToCoverage` is not used at all. The Summary sheet says
 *   so, in as many words, next to the export timestamp.
 * - **Text does not rely on colour.** On screen a cell shows
 *   `notes || period`; the period is redundant here (AM/PM is its own
 *   column, as on the rota sheet), so a cell shows its note if it has one
 *   and a one-letter state code otherwise. A printed or colour-blind
 *   reading of the sheet still carries the state.
 */

const LABEL_COL = 1;
const SESSION_COL = 2;
const FIRST_DATE_COL = 3;

const LABEL_COL_WIDTH = 20;
const SESSION_COL_WIDTH = 6;
const DATE_COL_WIDTH = 5;

const TITLE_FONT_SIZE = 14;

/** Month sheet tab names - fixed, not locale-derived: a workbook with
 * predictable tabs is worth more than a localised one, and every other
 * sheet name in this project ("Week 1") is English too. */
const MONTH_NAMES = [
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
];

/**
 * The one-letter code a cell shows when it has no note. "normal" is
 * blank: an unremarkable working session should read as empty space, the
 * way it does on screen.
 */
const STATE_LETTER: Record<PlanningCellState, string> = {
  normal: "",
  leave: "L",
  extra_session: "E",
  blocked: "B",
};

/** The doctor types the planner shows rows for. Mirrors the filter in
 * LeavePlanningPage.tsx - AHPs are not planned here. Trainees are always
 * included in the export regardless of the page's "Show trainees" toggle:
 * the toggle declutters a screen, a file is a record. */
const PLANNING_DOCTOR_TYPES = new Set<Doctor["doctor_type"]>([
  "Partner",
  "Salaried",
  "Locum",
  "Trainee",
]);

/** The merged label cell spans both AM and PM rows, so it gets a thick
 * top and bottom with no internal divider - same scheme as the rota
 * sheet's doctor-name cell. */
const BLOCK_LABEL_BORDER = {
  top: THICK_SIDE,
  left: THIN_SIDE,
  bottom: THICK_SIDE,
  right: THIN_SIDE,
} as const;

const THIN_BORDER = {
  top: THIN_SIDE,
  left: THIN_SIDE,
  bottom: THIN_SIDE,
  right: THIN_SIDE,
} as const;

type Cell = import("exceljs").Cell;
type Worksheet = import("exceljs").Worksheet;

function fill(cell: Cell, hex: string | null): void {
  if (hex === null) return;
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(hex) } };
}

function dateColumn(index: number): number {
  return FIRST_DATE_COL + index;
}

/** "Mon" over "3", as `columnLabel` renders it on screen - one wrapped
 * cell here rather than two stacked divs. */
function headerText(date: string): string {
  const weekday = parseLocalDate(date).toLocaleDateString("en-GB", { weekday: "short" });
  return `${weekday}\n${Number(date.slice(8))}`;
}

/** The server's coverage baseline as the map `weeklyTotal` consumes:
 * `closedSlotKey` -> headcount, null for a closed slot. No pending-edit
 * delta - see the module docstring. */
function coverageTotals(slots: CoverageSlot[]): Map<string, number | null> {
  const totals = new Map<string, number | null>();
  for (const slot of slots) {
    totals.set(closedSlotKey(slot.date, slot.period), slot.is_closed ? null : slot.headcount);
  }
  return totals;
}

export interface LeavePlanningExportInput {
  year: number;
  /** Active planner doctors (Partner/Salaried/Locum/Trainee); order does
   * not matter, every sheet sorts by `compareDoctorDisplayOrder`. */
  doctors: Doctor[];
  entitlements: LeaveEntitlement[];
  leave: LeaveEntry[];
  extraSessions: ExtraSessionEntry[];
  blocked: BlockedEntry[];
  closures: Closure[];
  schools: School[];
  templateSessions: MasterRotaSession[];
  /** Month (1-12) -> the server's coverage for that month's *padded*
   * date range, i.e. `weekdaysInMonth(year, month)` end to end. A missing
   * month renders every total as "-", the same as a range that was never
   * fetched. */
  coverageByMonth: Map<number, CoverageSlot[]>;
  exportedAt: Date;
}

/** Everything a month sheet needs that is the same for all twelve. */
interface SharedContext {
  year: number;
  doctors: Doctor[];
  leaveKeys: Set<string>;
  extraKeys: Set<string>;
  blockedKeys: Set<string>;
  leaveNotes: Map<string, string>;
  extraNotes: Map<string, string>;
  blockedNotes: Map<string, string>;
  closedSlots: Set<string>;
  schools: School[];
  templateTypes: Map<string, MasterSessionType>;
  coverageByMonth: Map<number, CoverageSlot[]>;
}

/** The doctors with a row on the given month's sheet, in grid order. */
function doctorsForMonth(doctors: Doctor[], dates: string[]): Doctor[] {
  const from = dates[0];
  const to = dates[dates.length - 1];
  return doctors
    .filter((doctor) => overlapsRange(doctor, from, to))
    .sort((a, b) =>
      compareDoctorDisplayOrder(
        { type: a.doctor_type, code: a.code },
        { type: b.doctor_type, code: b.code },
      ),
    );
}

/**
 * One doctor's AM+PM block. Cell resolution order matches
 * `PlanningCellHalf` exactly: closed, then out of window, then the merged
 * server state - so a closed slot on a leaver's row reads "closed", the
 * same as it does on screen.
 */
function writeDoctorBlock(
  sheet: Worksheet,
  context: SharedContext,
  doctor: Doctor,
  dates: string[],
  month: number,
  amRow: number,
): void {
  const pmRow = amRow + 1;

  const labelCell = sheet.getCell(amRow, LABEL_COL);
  labelCell.value = doctor.code;
  labelCell.alignment = CENTERED;
  labelCell.font = { bold: true };
  labelCell.border = BLOCK_LABEL_BORDER;
  sheet.mergeCells(amRow, LABEL_COL, pmRow, LABEL_COL);

  PLANNING_PERIODS.forEach((period, periodIndex) => {
    const rowNumber = amRow + periodIndex;
    const rowBorder = period === "AM" ? AM_ROW_BORDER : PM_ROW_BORDER;

    const sessionCell = sheet.getCell(rowNumber, SESSION_COL);
    sessionCell.value = period;
    sessionCell.alignment = CENTERED;
    sessionCell.border = rowBorder;

    dates.forEach((date, index) => {
      const cell = sheet.getCell(rowNumber, dateColumn(index));
      cell.border = rowBorder;
      cell.alignment = CENTERED;

      if (isSlotClosed(context.closedSlots, date, period)) {
        // Flat fill rather than an exceljs imitation of the screen's
        // `.closed-hatch`, and no text - the rota export's closed-cell
        // precedent, for the same reason: a closed slot has nothing to say.
        fill(cell, CLOSED_COLUMN_HEX);
        return;
      }
      if (!isWithinWindow(doctor, date)) {
        fill(cell, OUT_OF_WINDOW_HEX);
        return;
      }

      const key = planningCellKey(doctor.id, date, period);
      const state = toCellState(
        serverRows(context.leaveKeys, context.extraKeys, context.blockedKeys, key),
      );
      const notes = serverNotes(context.leaveNotes, context.extraNotes, context.blockedNotes, key);
      const text = notes || STATE_LETTER[state];
      if (text !== "") {
        cell.value = text;
        cell.font = { size: 9, color: { argb: argb(LEAVE_CELL_FONT_HEX[state]) } };
      }

      const day = weekdayName(date);
      const templateType =
        day === null ? undefined : context.templateTypes.get(templateKey(doctor.id, day, period));
      const stateHex =
        state === "normal"
          ? isSurgerySession(templateType)
            ? LEAVE_CELL_HEX.normal
            : NO_SURGERY_HEX
          : LEAVE_CELL_HEX[state];
      // An unfilled cell in a padded lead-in/lead-out column still gets
      // the out-of-month grey, mirroring the screen's dimmed columns; a
      // cell carrying a state keeps its state colour, which is the one
      // thing those columns must not lose.
      fill(cell, stateHex ?? (isInMonth(date, context.year, month) ? null : OUT_OF_MONTH_HEX));
    });
  });
}

/** The Clinical cover (AM+PM) and Weekly cover footer rows. */
function writeCoverageFooter(
  sheet: Worksheet,
  context: SharedContext,
  dates: string[],
  month: number,
  firstRow: number,
): void {
  const totals = coverageTotals(context.coverageByMonth.get(month) ?? []);
  const pmRow = firstRow + 1;

  const labelCell = sheet.getCell(firstRow, LABEL_COL);
  labelCell.value = "Clinical cover";
  labelCell.alignment = CENTERED;
  labelCell.font = { bold: true, color: { argb: argb(LEAVE_MUTED_FONT_HEX) } };
  labelCell.border = BLOCK_LABEL_BORDER;
  sheet.mergeCells(firstRow, LABEL_COL, pmRow, LABEL_COL);

  PLANNING_PERIODS.forEach((period, periodIndex) => {
    const rowNumber = firstRow + periodIndex;
    const rowBorder = period === "AM" ? AM_ROW_BORDER : PM_ROW_BORDER;

    const sessionCell = sheet.getCell(rowNumber, SESSION_COL);
    sessionCell.value = period;
    sessionCell.alignment = CENTERED;
    sessionCell.border = rowBorder;

    dates.forEach((date, index) => {
      const total = totals.get(closedSlotKey(date, period));
      const cell = sheet.getCell(rowNumber, dateColumn(index));
      cell.border = rowBorder;
      cell.alignment = CENTERED;
      // Closed (null) and outside the fetched range (undefined) both read
      // "-", as on screen: neither is an uncovered slot.
      cell.value = total === undefined || total === null ? "—" : total;
      fill(cell, coverageFillHex(total) ?? (isInMonth(date, context.year, month) ? null : OUT_OF_MONTH_HEX));
    });
  });

  const weeklyRow = pmRow + 1;
  const weeklyLabel = sheet.getCell(weeklyRow, LABEL_COL);
  weeklyLabel.value = "Weekly cover";
  weeklyLabel.alignment = CENTERED;
  weeklyLabel.font = { bold: true, color: { argb: argb(LEAVE_MUTED_FONT_HEX) } };
  weeklyLabel.border = THIN_BORDER;
  sheet.getCell(weeklyRow, SESSION_COL).border = THIN_BORDER;

  let index = 0;
  for (const weekDates of chunkIntoWeeks(dates)) {
    const total = weeklyTotal(weekDates, totals);
    const firstCol = dateColumn(index);
    const lastCol = dateColumn(index + weekDates.length - 1);
    const cell = sheet.getCell(weeklyRow, firstCol);
    cell.value = total === null ? "—" : total;
    cell.alignment = CENTERED;
    cell.font = { bold: true, color: { argb: argb(LEAVE_MUTED_FONT_HEX) } };
    for (let col = firstCol; col <= lastCol; col++) {
      sheet.getCell(weeklyRow, col).border = THIN_BORDER;
    }
    sheet.mergeCells(weeklyRow, firstCol, weeklyRow, lastCol);
    index += weekDates.length;
  }
}

/** One month sheet, top to bottom: header, school rows, counted doctors,
 * the trainee divider and its block, then the cover footer. */
function buildMonthSheet(sheet: Worksheet, context: SharedContext, month: number): void {
  const dates = weekdaysInMonth(context.year, month);

  sheet.getColumn(LABEL_COL).width = LABEL_COL_WIDTH;
  sheet.getColumn(SESSION_COL).width = SESSION_COL_WIDTH;
  dates.forEach((_, index) => {
    sheet.getColumn(dateColumn(index)).width = DATE_COL_WIDTH;
  });

  const headerRow = 1;
  const labelHeader = sheet.getCell(headerRow, LABEL_COL);
  labelHeader.value = "Doctor / School";
  labelHeader.alignment = CENTERED;
  labelHeader.font = { bold: true };
  labelHeader.border = THIN_BORDER;
  const sessionHeader = sheet.getCell(headerRow, SESSION_COL);
  sessionHeader.value = "Session";
  sessionHeader.alignment = CENTERED;
  sessionHeader.font = { bold: true };
  sessionHeader.border = THIN_BORDER;

  dates.forEach((date, index) => {
    const cell = sheet.getCell(headerRow, dateColumn(index));
    cell.value = headerText(date);
    cell.alignment = CENTERED_WRAPPED;
    cell.font = { bold: true };
    cell.border = THIN_BORDER;
    if (isDayFullyClosed(context.closedSlots, date)) {
      fill(cell, CLOSED_COLUMN_HEX);
    } else if (!isInMonth(date, context.year, month)) {
      fill(cell, OUT_OF_MONTH_HEX);
    }
  });

  let row = headerRow + 1;

  // School-holiday rows, same filter as the page: a school with no
  // holiday in view gets no row at all.
  for (const school of context.schools) {
    const holidayDates = schoolHolidayDatesInRange(dates, school.holidays);
    if (holidayDates.size === 0) continue;

    const labelCell = sheet.getCell(row, LABEL_COL);
    labelCell.value = school.name;
    labelCell.font = { bold: true, color: { argb: argb(LEAVE_MUTED_FONT_HEX) } };
    labelCell.border = THIN_BORDER;
    sheet.getCell(row, SESSION_COL).border = THIN_BORDER;

    dates.forEach((date, index) => {
      const cell = sheet.getCell(row, dateColumn(index));
      cell.border = THIN_BORDER;
      if (holidayDates.has(date)) {
        fill(cell, SCHOOL_HOLIDAY_HEX);
      } else if (!isInMonth(date, context.year, month)) {
        fill(cell, OUT_OF_MONTH_HEX);
      }
    });
    row += 1;
  }

  const monthDoctors = doctorsForMonth(context.doctors, dates);
  const counted = monthDoctors.filter((doctor) => doctor.doctor_type !== "Trainee");
  const trainees = monthDoctors.filter((doctor) => doctor.doctor_type === "Trainee");

  for (const doctor of counted) {
    writeDoctorBlock(sheet, context, doctor, dates, month, row);
    row += 2;
  }

  if (trainees.length > 0) {
    // Without this the Clinical cover rows below would read as wrong:
    // the coverage endpoint counts no trainee, so their leave never moves
    // a total.
    const dividerCell = sheet.getCell(row, LABEL_COL);
    dividerCell.value = "Trainees — not counted in clinical cover";
    dividerCell.font = { bold: true, italic: true, color: { argb: argb(LEAVE_MUTED_FONT_HEX) } };
    dividerCell.alignment = { horizontal: "left", vertical: "middle" };
    row += 1;

    for (const doctor of trainees) {
      writeDoctorBlock(sheet, context, doctor, dates, month, row);
      row += 2;
    }
  }

  writeCoverageFooter(sheet, context, dates, month, row);
}

/** A decimal-string entitlement figure as a number, or "-" where the
 * doctor's type has no tracked entitlement (AHP, Locum - see
 * LeaveEntitlement's docstring). Never pre-formatted into a string: a
 * figure written as text is a figure nobody can sum in Excel. */
function sessionValue(value: string | null | undefined): number | string {
  if (value === null || value === undefined) return "—";
  const asNumber = Number(value);
  return Number.isNaN(asNumber) ? value : asNumber;
}

const SUMMARY_COLUMNS = [
  "Doctor",
  "Type",
  "Entitlement",
  "Carry-over",
  "Adjustment",
  "Booked",
  "Used (chargeable)",
  "Remaining",
  "Sessions mismatch",
  "Slots with no template row",
];

const SESSIONS_NUM_FMT = "0.##";

/**
 * The Summary sheet: one row per doctor appearing on *any* month sheet,
 * which is what keeps it from silently listing fewer doctors than the
 * grid does. A doctor with no entitlement row (a locum) still gets a row,
 * with dashes in the entitlement columns.
 *
 * The last two columns are the data-integrity flags the page warns about
 * on screen. A workbook outlives the session it came from, so the warning
 * has to travel with the figures it qualifies.
 */
function buildSummarySheet(sheet: Worksheet, input: LeavePlanningExportInput, doctors: Doctor[]): void {
  const entitlementsByDoctor = new Map(input.entitlements.map((row) => [row.doctor_id, row]));

  sheet.getColumn(1).width = 14;
  sheet.getColumn(2).width = 12;
  for (let col = 3; col <= SUMMARY_COLUMNS.length; col++) {
    sheet.getColumn(col).width = 16;
  }

  const titleCell = sheet.getCell(1, 1);
  titleCell.value = `Annual leave plan ${input.year}`;
  titleCell.font = { bold: true, size: TITLE_FONT_SIZE };

  sheet.getCell(2, 1).value = `Exported ${formatDateTime(input.exportedAt.toISOString())} — saved data only`;

  const headerRow = 4;
  SUMMARY_COLUMNS.forEach((label, index) => {
    const cell = sheet.getCell(headerRow, index + 1);
    cell.value = label;
    cell.font = { bold: true };
    cell.alignment = CENTERED_WRAPPED;
    cell.border = THIN_BORDER;
  });

  doctors.forEach((doctor, index) => {
    const row = headerRow + 1 + index;
    const entitlement = entitlementsByDoctor.get(doctor.id);

    const values: (string | number)[] = [
      doctor.code,
      doctor.doctor_type,
      sessionValue(entitlement?.entitlement_sessions),
      sessionValue(entitlement?.carry_over_sessions),
      sessionValue(entitlement?.adjustment_sessions),
      entitlement === undefined ? "—" : entitlement.booked_sessions,
      entitlement === undefined ? "—" : entitlement.used_sessions,
      sessionValue(entitlement?.remaining_sessions),
      entitlement === undefined ? "—" : entitlement.sessions_mismatch ? "Yes" : "No",
      entitlement === undefined ? "—" : entitlement.exempt_by_reason.no_template_row,
    ];

    values.forEach((value, column) => {
      const cell = sheet.getCell(row, column + 1);
      cell.value = value;
      cell.border = THIN_BORDER;
      if (typeof value === "number") {
        cell.numFmt = SESSIONS_NUM_FMT;
        cell.alignment = CENTERED;
      } else if (column >= 2) {
        cell.alignment = CENTERED;
      }
    });
  });
}

/**
 * Builds the Annual Leave Planner workbook for one leave year and returns
 * it as a Blob. Saved data only - see the module docstring.
 */
export async function buildLeavePlanningWorkbook(input: LeavePlanningExportInput): Promise<Blob> {
  // No `.default` - the dynamic import's namespace object exposes
  // `.Workbook` directly under this project's Vite/Vitest setup, as
  // exportRota.ts already relies on.
  const ExcelJS = await import("exceljs");

  const doctors = input.doctors.filter((doctor) => PLANNING_DOCTOR_TYPES.has(doctor.doctor_type));

  const context: SharedContext = {
    year: input.year,
    doctors,
    leaveKeys: toCellKeySet(input.leave),
    extraKeys: toCellKeySet(input.extraSessions),
    blockedKeys: toCellKeySet(input.blocked),
    leaveNotes: toNotesMap(input.leave),
    extraNotes: toNotesMap(input.extraSessions),
    blockedNotes: toNotesMap(input.blocked),
    closedSlots: toClosedSlotSet(input.closures),
    schools: input.schools,
    templateTypes: buildTemplateIndex(input.templateSessions),
    coverageByMonth: input.coverageByMonth,
  };

  // The Summary's row set is the union of every month sheet's rows, not
  // the entitlement list: a doctor the grid shows must not be missing
  // from the summary of it, and a mid-year leaver must still appear.
  const unionById = new Map<number, Doctor>();
  for (let month = 1; month <= 12; month++) {
    for (const doctor of doctorsForMonth(doctors, weekdaysInMonth(input.year, month))) {
      unionById.set(doctor.id, doctor);
    }
  }
  const summaryDoctors = [...unionById.values()].sort((a, b) =>
    compareDoctorDisplayOrder(
      { type: a.doctor_type, code: a.code },
      { type: b.doctor_type, code: b.code },
    ),
  );

  const workbook = new ExcelJS.Workbook();
  buildSummarySheet(workbook.addWorksheet("Summary"), input, summaryDoctors);
  // Every month gets a sheet, including one with nothing planned in it:
  // predictable tab names beat a workbook whose shape varies with its
  // content.
  for (let month = 1; month <= 12; month++) {
    buildMonthSheet(workbook.addWorksheet(MONTH_NAMES[month - 1]), context, month);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}
