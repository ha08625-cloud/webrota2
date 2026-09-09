/**
 * exceljs layout primitives shared by every workbook export.
 *
 * These started out module-private at the top of exportRota.ts and moved
 * here unchanged when a second export (the Annual Leave Planner) needed
 * the same alignment and border vocabulary. Only the genuinely generic
 * pieces live here - column widths, font sizes and anything that encodes
 * one sheet's shape stay in the export that owns them.
 *
 * Plain literals, no exceljs type import needed - `as const` keeps the
 * `style` properties as the literal "thin"/"thick" rather than widening
 * to `string`, which is what a Border-shaped assignment needs
 * structurally. Do not drop the `as const`.
 */

export const CENTERED = { horizontal: "center", vertical: "middle" } as const;
export const CENTERED_WRAPPED = {
  horizontal: "center",
  vertical: "middle",
  wrapText: true,
} as const;

export const THIN_SIDE = { style: "thin" } as const;
export const THICK_SIDE = { style: "thick" } as const;

/**
 * Row-level border for the AM half of a staff member's block: thick line
 * above (the top of the block, shared visually with the previous block's
 * PM thick bottom / the header for the very first one), thin line below
 * (the AM/PM divider within the same block).
 */
export const AM_ROW_BORDER = {
  top: THICK_SIDE,
  left: THIN_SIDE,
  bottom: THIN_SIDE,
  right: THIN_SIDE,
} as const;

/**
 * Row-level border for the PM half of a staff member's block: thin line
 * above (shared with AM_ROW_BORDER's bottom), thick line below (the
 * bottom of this block).
 */
export const PM_ROW_BORDER = {
  top: THIN_SIDE,
  left: THIN_SIDE,
  bottom: THICK_SIDE,
  right: THIN_SIDE,
} as const;
