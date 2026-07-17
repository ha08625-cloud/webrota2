import type { CellBackground, FontColor } from "@/lib/cellStyle";

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
  black: "1C2430", // text-ink -> tailwind_config.js ink: #1C2430 (not pure black)
  red: "B91C1C", // text-red-700
  blue: "1D4ED8", // text-blue-700
};

/** Closed-date column fill, full column height (a deliberate divergence
 * from the UI, which greys only the header). Matches the closed header's
 * bg-gray-200 in RotaGrid.tsx (line ~281). */
export const CLOSED_COLUMN_HEX = "E5E7EB";

/**
 * exceljs fills/fonts take 8-digit ARGB (`FFRRGGBB`). The maps above stay
 * as plain 6-digit hex so the Tailwind correspondence is readable at a
 * glance; convert at the point of use.
 */
export function argb(hex: string): string {
  return `FF${hex}`;
}
