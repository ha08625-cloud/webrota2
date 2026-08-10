import type { ClinicType, Doctor, Period, Room, Rota } from "@/api/types";
import { cellStyle } from "@/lib/cellStyle";
import { isDayFullyClosed, isSlotClosed, toClosedSlotSet } from "@/lib/closedSlots";
import { formatWeekLabel } from "@/lib/date";
import {
  buildSupervisedCounts,
  cellLines,
  compactDayHeaderText,
  supervisedCountKey,
  toIdMap,
} from "@/lib/exportContent";
import { BACKGROUND_HEX, CLOSED_COLUMN_HEX, FONT_HEX } from "@/lib/exportStyles";
import { DAYS, PERIODS, getCell, pivotRota, weekNumbers, type PivotedGrid } from "@/lib/pivot";
import { rotaDate } from "@/lib/weekDates";

/**
 * The pure, library-agnostic document model for the committed-rota PDF
 * export (PDF export plan, Task 3). **Nothing here may import pdfmake** -
 * this suite must run with pdfmake uninstalled. The pdfmake serialisation
 * layer (Task 4) consumes `RotaPdfDocument` and adds nothing to it but
 * drawing.
 *
 * The split exists because a PDF Blob is close to untestable: the honest
 * ceiling on asserting against one is "non-empty, starts with %PDF"
 * (Design Decision 5). So every decision worth testing - which rows exist
 * and in what order, what each cell says, what colour it is, and what font
 * size the page has to shrink to in order to fit - is made here, against
 * plain objects, and the pdfmake call downstream stays a thin shell.
 *
 * Content comes wholesale from exportContent.ts, shared with the Excel
 * export (Design Decision 4); colour comes from cellStyle() via
 * exportStyles.ts's hex maps, exactly as the Excel export and the
 * on-screen grid do. **This module decides structure and geometry, never
 * content or palette.**
 *
 * Two deliberate divergences from the Excel export, both matching the
 * practice's real printed rota: there is no AM/PM session column (the
 * first row of a doctor's pair is AM, the second PM, implicit - Design
 * Decision 7), and day headers are compact ("MON 10th" - Design
 * Decision 8).
 */

export interface PdfCell {
  /** Cell text, one entry per displayed line, from `cellLines`. Empty for
   * an absent cell (no template entry for that doctor/slot). */
  lines: string[];
  /** 6-digit hex, no `#`, or null for no fill. The pdfmake layer prefixes
   * the `#`; `argb()` is exceljs-only and must not be used here. */
  fillHex: string | null;
  /** 6-digit hex, no `#`. */
  fontHex: string;
  /** True when the final entry of `lines` is a session note, which the
   * PDF layer renders unbold - mirroring the Excel export's rich-text
   * split (ticket: "all fonts bold except notes"). `cellLines` only ever
   * pushes a non-empty note, and always last, so this flag alone
   * identifies the run. */
  isNote: boolean;
}

export interface PdfRow {
  period: Period | null;
  /**
   * The doctor's code, set on the AM row only - the PM row carries null.
   * The PDF layer turns the AM row's label into a `rowSpan: 2` cell
   * covering both, the same merge the Excel export does.
   */
  doctorLabel: string | null;
  /** One per weekday, in DAYS order. */
  cells: PdfCell[];
}

export interface PdfPage {
  title: string;
  dayHeaders: { text: string; closed: boolean }[];
  rows: PdfRow[];
}

export interface RotaPdfDocument {
  pages: PdfPage[];
  /**
   * One body font size for the whole document, not one per page: a rota
   * whose weeks differ slightly in content would otherwise print at
   * different sizes page to page, which reads as a rendering fault. The
   * document therefore takes the *smallest* size any of its pages needs.
   */
  bodyFontSize: number;
}

/* ------------------------------------------------------------------ */
/* Page geometry (A4 portrait, Design Decision 3)                      */
/* ------------------------------------------------------------------ */

/** A4 portrait in PDF points. */
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 12;
const MARGIN_Y = 28;

export const USABLE_WIDTH = PAGE_WIDTH - MARGIN_X * 2; // 571.28pt
export const USABLE_HEIGHT = PAGE_HEIGHT - MARGIN_Y * 2; // 785.89pt

/** The doctor-code column; the five day columns share what is left. */
export const DOCTOR_COL_WIDTH = 60;
export const DAY_COL_WIDTH = (USABLE_WIDTH - DOCTOR_COL_WIDTH) / DAYS.length; // ~102.3pt

/** Vertical space reserved for the merged week-title row. */
const TITLE_HEIGHT = 20;

/** Line height as a multiple of font size, and per-row cell padding. */
const LINE_HEIGHT_RATIO = 1.15;
const ROW_PADDING = 4;

/**
 * Helvetica's average character advance as a fraction of the em, for text
 * of this kind (short mixed-case codes and labels). Only ever used to
 * *estimate* wrapping for the fit search below - pdfmake does the real
 * measuring at render time.
 */
const AVERAGE_CHAR_WIDTH_EM = 0.5;

/**
 * Candidate body font sizes, largest first. pdfmake has no shrink-to-fit,
 * so the fit is achieved by choosing a size rather than scaling a fixed
 * one (Design Decision 3). The floor is 5.5pt because the status quo -
 * the practice's current spreadsheet printout - lands at roughly 5.4pt
 * after its fit-to-page scaling, so nothing below that is a regression
 * worth chasing; a page that still doesn't fit at 5.5 paginates instead.
 */
export const FONT_SIZE_CANDIDATES = [9, 8, 7, 6, 5.5];

/* ------------------------------------------------------------------ */
/* Fitting                                                             */
/* ------------------------------------------------------------------ */

/** Estimated wrapped line count for one cell at the given font size. */
function estimatedLineCount(cell: PdfCell, charsPerLine: number): number {
  let count = 0;
  for (const line of cell.lines) {
    count += Math.max(1, Math.ceil(line.length / charsPerLine));
  }
  return count;
}

function estimatedPageHeight(page: PdfPage, fontSize: number): number {
  const charsPerLine = DAY_COL_WIDTH / (AVERAGE_CHAR_WIDTH_EM * fontSize);
  let total = 0;
  for (const row of page.rows) {
    // An all-absent row (e.g. a part-time doctor's non-working half-day
    // across the board) still occupies one line's worth of height.
    let maxLines = 1;
    for (const cell of row.cells) {
      maxLines = Math.max(maxLines, estimatedLineCount(cell, charsPerLine));
    }
    total += maxLines * LINE_HEIGHT_RATIO * fontSize + ROW_PADDING;
  }
  return total;
}

/**
 * The largest candidate size at which this page's estimated content
 * height fits one A4 portrait page, or the smallest candidate if none
 * does (the page then paginates with the day-header row repeated, which
 * the user has confirmed is acceptable - Design Decision 3).
 *
 * The estimate is deliberately crude and deterministic. It is not trying
 * to predict pdfmake's layout to the point; it is trying to pick a size
 * that is very likely to fit and is the same on every machine and in
 * every test run.
 */
export function chooseBodyFontSize(page: PdfPage): number {
  for (const fontSize of FONT_SIZE_CANDIDATES) {
    // The day-header row wraps to two lines whenever a day is closed, so
    // it is budgeted at two lines' worth throughout rather than measured.
    const headerHeight = 2.2 * fontSize + ROW_PADDING;
    const bodyBudget = USABLE_HEIGHT - TITLE_HEIGHT - headerHeight;
    if (estimatedPageHeight(page, fontSize) <= bodyBudget) {
      return fontSize;
    }
  }
  return FONT_SIZE_CANDIDATES[FONT_SIZE_CANDIDATES.length - 1];
}

/* ------------------------------------------------------------------ */
/* Model building                                                      */
/* ------------------------------------------------------------------ */

/**
 * The week's title: the week-commencing label, plus the names of any
 * closures falling in that week. Closed-ness always comes from
 * `rota.closed_slots` (the snapshot taken at commit); `closureNameByDate`
 * is the *live* list and is consulted for the cosmetic name only, exactly
 * as RotaGrid and the Excel export do. A closed date with no name in the
 * live list contributes nothing to the title - the greyed column and the
 * day header's own "closed" suffix already carry that.
 */
function buildTitle(
  rota: Rota,
  week: number,
  closedSlotSet: Set<string>,
  closureNameByDate: Map<string, string | null>,
): string {
  const label = formatWeekLabel(rotaDate(rota.start_date, week, "Monday"));

  const names: string[] = [];
  for (const day of DAYS) {
    const date = rotaDate(rota.start_date, week, day);
    const isClosed = PERIODS.some((period) => isSlotClosed(closedSlotSet, date, period));
    if (!isClosed) continue;
    const name = closureNameByDate.get(date);
    if (name === undefined || name === null) continue;
    if (!names.includes(name)) names.push(name);
  }

  return names.length > 0 ? `${label} — ${names.join(", ")}` : label;
}

/**
 * Builds the whole document model: one page per generation week, rows in
 * `pivotRota` order (the same order the grid and the Excel export use),
 * two rows per doctor.
 *
 * `closureNameByDate` is the live closures lookup - see `buildTitle`.
 */
export function buildRotaPdfModel(
  rota: Rota,
  doctors: Doctor[],
  rooms: Room[],
  clinicTypes: ClinicType[],
  closureNameByDate: Map<string, string | null>,
): RotaPdfDocument {
  const roomsById = toIdMap(rooms);
  const clinicTypesById = toIdMap(clinicTypes);
  const closedSlotSet = toClosedSlotSet(rota.closed_slots);

  const weeks = weekNumbers(rota.num_weeks);
  const grid: PivotedGrid = pivotRota(rota.sessions, doctors);
  const supervisedCounts = buildSupervisedCounts(rota.sessions, doctors, weeks);

  const pages: PdfPage[] = weeks.map((week) => {
    const dayHeaders = DAYS.map((day) => {
      const date = rotaDate(rota.start_date, week, day);
      return {
        text: compactDayHeaderText(day, date, closedSlotSet, closureNameByDate),
        closed: isDayFullyClosed(closedSlotSet, date),
      };
    });

    const rows: PdfRow[] = [];
    for (const gridRow of grid.rows) {
      const doctorLabel = gridRow.inactiveWithSessions
        ? `${gridRow.doctor.code} (inactive)`
        : gridRow.doctor.code;

      for (const period of PERIODS) {
        const cells = DAYS.map((day) => {
          const date = rotaDate(rota.start_date, week, day);
          const session = getCell(grid, gridRow.doctor.id, week, day, period);
          const style = cellStyle(session, roomsById, clinicTypesById);

          const supervisedCount = supervisedCounts.get(supervisedCountKey(week, day, period)) ?? 0;
          const lines = session !== undefined ? cellLines(session, supervisedCount) : [];
          const isNote =
            session !== undefined && session.notes !== null && session.notes.trim().length > 0;

          // Closed-slot fill overrides the style's own background, same
          // precedence as the Excel export: a closed column is greyed
          // full height regardless of what (if anything) sits in it.
          const fillHex = isSlotClosed(closedSlotSet, date, period)
            ? CLOSED_COLUMN_HEX
            : BACKGROUND_HEX[style.background];

          return { lines, fillHex, fontHex: FONT_HEX[style.fontColor], isNote };
        });

        rows.push({
          period,
          // AM carries the label; the PM row is covered by the AM cell's
          // rowSpan downstream.
          doctorLabel: period === "AM" ? doctorLabel : null,
          cells,
        });
      }
    }

    return {
      title: buildTitle(rota, week, closedSlotSet, closureNameByDate),
      dayHeaders,
      rows,
    };
  });

  const bodyFontSize = pages.length > 0 ? Math.min(...pages.map(chooseBodyFontSize)) : FONT_SIZE_CANDIDATES[0];

  return { pages, bodyFontSize };
}
