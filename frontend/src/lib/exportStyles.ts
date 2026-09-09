import type { CellBackground, FontColor } from "@/lib/cellStyle";
import type { PlanningCellState } from "@/lib/planningMonth";

/**
 * Excel colour source of truth for rota export. Mirrors RotaGrid.tsx's
 * BACKGROUND_CLASS / FONT_CLASS Tailwind maps, hex-for-class, against
 * Tailwind v3.4 defaults (this project's tailwind_config.js does not
 * override gray/red/blue/green) and the custom `ink` colour in
 * tailwind_config.js. cellStyle.ts remains the single Q13 authority for
 * *which* semantic value a cell gets; this file only supplies the hex
 * for each value.
 *
 * KEPT IN SYNC MANUALLY with RotaGrid.tsx's BACKGROUND_CLASS/FONT_CLASS.
 * A Q13 palette change needs an edit here AND there - see the matching
 * comment on BACKGROUND_CLASS in RotaGrid.tsx.
 */

/** null means no fill (white / unstyled cell). */
export const BACKGROUND_HEX: Record<CellBackground, string | null> = {
  leave: "E5E7EB", // bg-gray-200
  wfh: null, // bg-white - WFH badge carries the signal, not the background
  duty: "FEE2E2", // bg-red-100
  duty_helper: "DBEAFE", // bg-blue-100
  clinic: "DCFCE7", // bg-green-100
  no_surgery: "E5E7EB", // bg-gray-200
  default: null, // bg-white
};

export const FONT_HEX: Record<FontColor, string> = {
  black: "1C2430", // the default theme's ink (not pure black). Deliberately a
  // literal: exports never follow the user's theme, so this does NOT track
  // the --color-ink variable in index.css.
  red: "B91C1C", // text-red-700
  blue: "1D4ED8", // text-blue-700
};

/** Closed-date column fill, full column height (a deliberate divergence
 * from the UI, which greys only the header). Matches the closed header's
 * bg-gray-200 in RotaGrid.tsx (line ~281). */
export const CLOSED_COLUMN_HEX = "E5E7EB";

/**
 * Room-sheet occupied-cell fill (M-export room-sheet plan). Deliberately
 * one shade lighter than CLOSED_COLUMN_HEX (bg-gray-100 vs bg-gray-200)
 * rather than reusing the on-screen room view's red-100: user-confirmed
 * decision to keep the export muted, and the two greys must stay visibly
 * distinct from each other since both can appear in the same sheet
 * (an occupied room on an otherwise-open day vs a fully closed day).
 * Available cells get no fill (white), matching BACKGROUND_HEX's `null`
 * convention above.
 */
export const ROOM_OCCUPIED_HEX = "F3F4F6";

/* ------------------------------------------------------------------ *
 * Annual Leave Planner export
 *
 * KEPT IN SYNC MANUALLY with LeavePlanningGrid.tsx's CELL_CLASSES,
 * NO_SURGERY_NORMAL_CLASS, coverageClass and the school-holiday /
 * out-of-month cell classes. A palette change to the planner needs an
 * edit here AND there.
 *
 * Most of these are fixed Tailwind palette values transcribed
 * hex-for-class, as the rota block above does. The exceptions are the
 * `ink`-derived greys: on screen those are themeable tokens with alpha
 * (bg-ink/5, bg-ink/[0.03], text-ink/30, text-ink/70) over a white
 * surface, so there is no theme-independent hex to copy. They are pinned
 * to the DEFAULT palette's resolved value (--color-ink: 28 36 48,
 * --color-surface: 255 255 255 in index.css) composited over white, and
 * deliberately do NOT track --color-ink: exports never follow the user's
 * theme (same decoupling as FONT_HEX.black above).
 * ------------------------------------------------------------------ */

/** Cell fills for the four planning cell states. null means no fill,
 * matching BACKGROUND_HEX's convention: a "normal" cell is bg-surface,
 * i.e. white on the default palette. */
export const LEAVE_CELL_HEX: Record<PlanningCellState, string | null> = {
  normal: null, // bg-surface
  leave: "22C55E", // bg-green-500
  extra_session: "FDE047", // bg-yellow-300
  blocked: "64748B", // bg-slate-500
};

/** Font colour per cell state. `normal` is the pinned text-ink/30 (see
 * the header note); the export writes no text in a normal cell, so it
 * only matters if one ever carries a note. */
export const LEAVE_CELL_FONT_HEX: Record<PlanningCellState, string> = {
  normal: "BBBDC1", // text-ink/30, pinned to the default palette over white
  leave: "FFFFFF", // text-white
  extra_session: "713F12", // text-yellow-900
  blocked: "FFFFFF", // text-white
};

/** A "normal" cell that is not a surgery session in the doctor's
 * template (isSurgerySession false) - grey rather than white. */
export const NO_SURGERY_HEX = "D1D5DB"; // bg-gray-300

/** School-holiday row marker. */
export const SCHOOL_HOLIDAY_HEX = "C7D2FE"; // bg-indigo-200

/** The doctor is not employed on that date - nothing to plan, but the
 * practice is open. bg-ink/5, pinned (see the header note). */
export const OUT_OF_WINDOW_HEX = "F4F4F5";

/** A padded lead-in / lead-out column borrowed from the adjacent month
 * (isInMonth false). bg-ink/[0.03], pinned (see the header note). */
export const OUT_OF_MONTH_HEX = "F8F8F9";

/** Muted text for row labels and totals - text-ink/70, pinned (see the
 * header note). */
export const LEAVE_MUTED_FONT_HEX = "60666E";

/**
 * Clinical cover fill for a total, mirroring coverageClass in
 * LeavePlanningGrid.tsx. null means no fill: cover of 5+ needs no flag,
 * and so do null (closed) and undefined (outside the fetched range),
 * which the grid leaves neutral because there is nothing to flag.
 */
export function coverageFillHex(total: number | null | undefined): string | null {
  if (total === null || total === undefined) return null;
  if (total <= 2) return "FECACA"; // bg-red-200
  if (total === 3) return "FED7AA"; // bg-orange-200
  if (total === 4) return "FEF08A"; // bg-yellow-200
  return null;
}

/**
 * exceljs fills/fonts take 8-digit ARGB (`FFRRGGBB`). The maps above stay
 * as plain 6-digit hex so the Tailwind correspondence is readable at a
 * glance; convert at the point of use.
 */
export function argb(hex: string): string {
  return `FF${hex}`;
}