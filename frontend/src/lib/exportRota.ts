import type { ClinicType, Day, Doctor, Period, Room, Rota, RotaSession } from "@/api/types";
import { formatDate } from "@/lib/date";
import { cellStyle } from "@/lib/cellStyle";
import { BACKGROUND_HEX, CLOSED_COLUMN_HEX, FONT_HEX, argb } from "@/lib/exportStyles";
import { DAYS, PERIODS, getCell, pivotRota, weekNumbers, type PivotedGrid } from "@/lib/pivot";
import { countSupervisableTrainees } from "@/lib/superviseeCount";
import { rotaDate } from "@/lib/weekDates";

/**
 * Excel export builder for a committed rota (M-export plan, Task 2). Pure:
 * no React, no DOM APIs, no top-level dependency on exceljs (see the
 * dynamic import below) - takes plain data and returns a Blob, so it can
 * be unit tested directly in Node/Vitest.
 *
 * Reproduces the on-screen RotaGrid: same pivotRota row order, same
 * cellStyle() colour rules (via exportStyles.ts's hex maps), same
 * CellContent text/ordering. One worksheet per generation week.
 */

const DOCTOR_COL = 1;
const SESSION_COL = 2;
const FIRST_DAY_COL = 3;
const HEADER_ROW = 1;
const FIRST_BODY_ROW = 2;

const DOCTOR_COL_WIDTH = 14;
const SESSION_COL_WIDTH = 8;
const DAY_COL_WIDTH = 22;

// Plain literal, no exceljs type import needed - `as const` keeps the
// `style` properties as the literal "thin" rather than widening to
// `string`, which is what a Border-shaped assignment needs structurally.
const THIN_BORDER = {
  top: { style: "thin" },
  left: { style: "thin" },
  bottom: { style: "thin" },
  right: { style: "thin" },
} as const;

function dayColumn(day: Day): number {
  return FIRST_DAY_COL + DAYS.indexOf(day);
}

function supervisedCountKey(week: number, day: Day, period: Period): string {
  return `${week}:${day}:${period}`;
}

/**
 * Mirrors RotaGrid.tsx's RoleLabel exactly: duty_primary -> "Duty",
 * duty_secondary -> "Duty (2nd)", clinic -> clinic name (or "Clinic"),
 * anything else (including null) -> nothing.
 */
function roleLabelText(role: RotaSession["role"], clinicName: string | null): string | null {
  if (role === "duty_primary") return "Duty";
  if (role === "duty_secondary") return "Duty (2nd)";
  if (role === "clinic") return clinicName ?? "Clinic";
  return null;
}

/**
 * Mirrors RotaGrid.tsx's CellContent line-for-line (Design Decision 4):
 * LEAVE suppresses everything else except notes; otherwise WFH, then
 * Supervising, then No surgery/Admin, then the role label (shown
 * regardless of WFH, same as the UI), then the room code (suppressed by
 * WFH, same as the UI - is_on_leave already returned above by that
 * point). Notes, when present, are always the trailing line - shown
 * regardless of leave/WFH state, same as the grid's third-row note.
 */
function cellLines(session: RotaSession, supervisedCount: number): string[] {
  if (session.is_on_leave) {
    const leaveLines = ["LEAVE"];
    if (session.notes !== null && session.notes.trim().length > 0) {
      leaveLines.push(session.notes);
    }
    return leaveLines;
  }

  const lines: string[] = [];

  if (session.is_wfh) {
    lines.push("WFH");
  }

  if (session.is_supervising) {
    lines.push(supervisedCount > 0 ? `Supervising x ${supervisedCount}` : "Supervising");
  }

  if (session.role === null && session.template_type === "no_surgery") {
    lines.push("No surgery");
  }
  if (session.role === null && session.template_type === "admin_time") {
    lines.push("Admin");
  }

  const roleLabel = roleLabelText(session.role, session.clinic_type_name);
  if (roleLabel !== null) {
    lines.push(roleLabel);
  }

  if (!session.is_wfh && session.room_code) {
    lines.push(session.room_code);
  }

  if (session.notes !== null && session.notes.trim().length > 0) {
    lines.push(session.notes);
  }

  return lines;
}

function dayHeaderText(
  day: Day,
  date: string,
  closedDatesSet: Set<string>,
  closureNameByDate: Map<string, string | null>,
): string {
  const base = `${day} ${formatDate(date)}`;
  if (!closedDatesSet.has(date)) {
    return base;
  }
  return `${base}\n${closureNameByDate.get(date) ?? "closed"}`;
}

function toIdMap<T extends { id: number }>(items: T[]): Map<number, T> {
  const map = new Map<number, T>();
  for (const item of items) {
    map.set(item.id, item);
  }
  return map;
}

/**
 * Replicates RotaGrid.tsx's supervisedCounts memo: one
 * countSupervisableTrainees call per (week, day, period), keyed for O(1)
 * lookup in the render loop below. Kept identical to the memo's own
 * iteration (weeks x DAYS x PERIODS) so a future change to that memo is
 * easy to spot as drift here too.
 */
function buildSupervisedCounts(
  sessions: RotaSession[],
  doctors: Doctor[],
  weeks: number[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const week of weeks) {
    for (const day of DAYS) {
      for (const period of PERIODS) {
        map.set(supervisedCountKey(week, day, period), countSupervisableTrainees(sessions, doctors, week, day, period));
      }
    }
  }
  return map;
}

/**
 * Builds the committed-rota Excel workbook and returns it as a Blob.
 *
 * `closureNameByDate` is the *live* closures list (cosmetic-name lookup
 * only, same as RotaGrid) - closed-ness itself always comes from
 * `rota.closed_dates`, the RotaClosure snapshot, never this map.
 */
export async function buildRotaWorkbook(
  rota: Rota,
  doctors: Doctor[],
  rooms: Room[],
  clinicTypes: ClinicType[],
  closureNameByDate: Map<string, string | null>,
): Promise<Blob> {
  // No `.default` - confirmed against this project's Vite/Vitest setup by
  // the Task 1 spike (src/lib/__spike_exceljs.test.ts): the dynamic
  // import's namespace object exposes `.Workbook` directly.
  const ExcelJS = await import("exceljs");

  const roomsById = toIdMap(rooms);
  const clinicTypesById = toIdMap(clinicTypes);
  const closedDatesSet = new Set(rota.closed_dates);

  const weeks = weekNumbers(rota.num_weeks);
  const grid: PivotedGrid = pivotRota(rota.sessions, doctors);
  const supervisedCounts = buildSupervisedCounts(rota.sessions, doctors, weeks);

  const workbook = new ExcelJS.Workbook();

  for (const week of weeks) {
    const sheet = workbook.addWorksheet(`Week ${week}`);

    sheet.getColumn(DOCTOR_COL).width = DOCTOR_COL_WIDTH;
    sheet.getColumn(SESSION_COL).width = SESSION_COL_WIDTH;
    for (const day of DAYS) {
      sheet.getColumn(dayColumn(day)).width = DAY_COL_WIDTH;
    }

    // Header row.
    const headerRow = sheet.getRow(HEADER_ROW);
    headerRow.getCell(DOCTOR_COL).value = "Doctor";
    headerRow.getCell(SESSION_COL).value = "Session";
    for (const day of DAYS) {
      const date = rotaDate(rota.start_date, week, day);
      const cell = headerRow.getCell(dayColumn(day));
      cell.value = dayHeaderText(day, date, closedDatesSet, closureNameByDate);
      cell.alignment = { wrapText: true, vertical: "top" };
      if (closedDatesSet.has(date)) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(CLOSED_COLUMN_HEX) } };
      }
    }
    for (let col = DOCTOR_COL; col <= dayColumn("Friday"); col++) {
      const cell = headerRow.getCell(col);
      cell.font = { bold: true };
      cell.border = THIN_BORDER;
    }

    // Doctor blocks: two rows (AM, PM) per grid row, in pivotRota order.
    grid.rows.forEach((row, index) => {
      const amRow = FIRST_BODY_ROW + index * 2;
      const pmRow = amRow + 1;

      const doctorCode = row.inactiveWithSessions ? `${row.doctor.code} (inactive)` : row.doctor.code;
      const doctorCell = sheet.getCell(amRow, DOCTOR_COL);
      doctorCell.value = doctorCode;
      doctorCell.alignment = { vertical: "middle" };
      doctorCell.border = THIN_BORDER;
      sheet.mergeCells(amRow, DOCTOR_COL, pmRow, DOCTOR_COL);

      const amSessionCell = sheet.getCell(amRow, SESSION_COL);
      amSessionCell.value = "AM";
      amSessionCell.border = THIN_BORDER;
      const pmSessionCell = sheet.getCell(pmRow, SESSION_COL);
      pmSessionCell.value = "PM";
      pmSessionCell.border = THIN_BORDER;

      for (const day of DAYS) {
        const date = rotaDate(rota.start_date, week, day);
        const isClosed = closedDatesSet.has(date);
        const col = dayColumn(day);

        for (const period of PERIODS) {
          const rowNum = period === "AM" ? amRow : pmRow;
          const cell = sheet.getCell(rowNum, col);
          const session = getCell(grid, row.doctor.id, week, day, period);

          if (session !== undefined) {
            const style = cellStyle(session, roomsById, clinicTypesById);
            const supervisedCount = supervisedCounts.get(supervisedCountKey(week, day, period)) ?? 0;

            cell.value = cellLines(session, supervisedCount).join("\n");
            cell.alignment = { wrapText: true, vertical: "top" };
            cell.font = { color: { argb: argb(FONT_HEX[style.fontColor]) } };

            const fillHex = BACKGROUND_HEX[style.background];
            if (fillHex !== null) {
              cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(fillHex) } };
            }

            cell.border = THIN_BORDER;
          }

          // Full-column-height closed override (Design Decision 7) -
          // applies regardless of session presence, and regardless of
          // whatever fill was just set above for a populated cell (in
          // practice closed dates have no sessions per the pivot
          // invariant, so this is normally greying an absent cell, but
          // the override ordering keeps the intent explicit either way).
          if (isClosed) {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: argb(CLOSED_COLUMN_HEX) } };
            cell.border = THIN_BORDER;
          }
        }
      }
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}