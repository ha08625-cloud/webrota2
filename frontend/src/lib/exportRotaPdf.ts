import type { Content, TDocumentDefinitions, TableCell, TableLayout } from "pdfmake/interfaces";

import type { ClinicType, Doctor, Room, Rota } from "@/api/types";
import { CLOSED_COLUMN_HEX } from "@/lib/exportStyles";
import { DOCTOR_COL_WIDTH, buildRotaPdfModel, type PdfCell, type PdfPage, type RotaPdfDocument } from "@/lib/rotaPdfModel";

/**
 * PDF export builder for a committed rota (PDF export plan, Task 4).
 * Deliberately thin: every decision worth testing - row order, cell text,
 * colour, and the fitted font size - was already made by
 * rotaPdfModel.ts, which is exhaustively unit tested against plain
 * objects. This file only draws the model with pdfmake, and its own
 * suite asserts little more than "a PDF came out" (Design Decision 5).
 * That asymmetry is intentional, not an oversight: asserting against PDF
 * bytes is worth almost nothing, so the coverage lives one layer up.
 *
 * Same signature as `buildRotaWorkbook`, so the two are interchangeable
 * at the call site.
 *
 * ---
 *
 * **Task 1 spike findings, recorded here because they are surprising and
 * the compiler cannot enforce them.**
 *
 * *1. Both dynamic imports need `.default` - the opposite of the exceljs
 * export, so do not copy that file's import line.* The pdfmake browser
 * bundle is a webpack UMD build, and under Vite's CJS interop the
 * namespace object is polluted with the bundle's *internal* exports
 * (`Buffer`, `Deflate`, `Zlib`, `XmlDocument`, ... ~200 keys), including
 * a top-level `createPdf`. That top-level `createPdf` is a trap: it is
 * unbound, so calling it happens to work today but is not the documented
 * surface. `.default` is the real singleton pdfmake instance
 * (`createPdf`, `addFontContainer`, `setFonts`). `@types/pdfmake`
 * describes the *namespace*, which has no `default`, hence the cast in
 * `loadPdfMake` below.
 *
 * *2. Standard-14 fonts, so no glyph data ships.* pdfmake 0.3 exposes
 * `addFontContainer({ vfs, fonts })` on the browser build and ships
 * prebuilt containers under `pdfmake/build/standard-fonts/`. Helvetica's
 * carries the four AFM *metrics* files, not outlines, and declares the
 * `Helvetica` family used by `defaultStyle` below. `setFonts` (not
 * `addFonts`) matters: the browser build seeds `this.fonts = { Roboto }`
 * in its constructor, and leaving that in place means a missing or
 * mistyped `font:` silently falls back to Roboto and throws
 * `File 'Roboto-Regular.ttf' not found in virtual file system` at render
 * time. Replacing the map makes any such mistake fail loudly at the
 * point of the mistake. Correcting Design Decision 2's "no font data at
 * all": no glyphs, but ~288 kB of AFM metrics (54 kB gzipped), lazily
 * loaded alongside the ~973 kB pdfmake chunk on first export only.
 *
 * *3. pdfmake 0.3's output API is promise-based* (`getBlob()`,
 * `getBuffer()`). It is **not** the 0.2 callback style that most examples
 * online show - passing a callback makes the call hang forever with no
 * error.
 *
 * *4. jsdom's `Blob` has no `arrayBuffer()`/`text()`*, so a test that
 * wants to inspect bytes must use `getBuffer()`. Irrelevant in
 * production, where the Blob goes straight to `downloadBlob()`.
 */

/* ------------------------------------------------------------------ */
/* Layout constants                                                    */
/* ------------------------------------------------------------------ */

/** Must match rotaPdfModel.ts's MARGIN_X / MARGIN_Y, which the fitted
 * font size was computed against. */
const PAGE_MARGINS: [number, number, number, number] = [12, 28, 12, 28];

/** Cell padding, per side. The vertical pair sums to rotaPdfModel.ts's
 * ROW_PADDING, again so the fit estimate matches what gets drawn. */
const CELL_PADDING_X = 2;
const CELL_PADDING_Y = 2;

/** Matches rotaPdfModel.ts's LINE_HEIGHT_RATIO (pdfmake's default is 1). */
const LINE_HEIGHT = 1.15;

/**
 * The paper rota's border scheme, which the Excel export already matches
 * (medium above AM, thin between AM and PM, medium below PM - `2`/`1`/`2`
 * line styles in the sample file's BIFF records). "Medium" in BIFF is
 * roughly 1.5pt.
 */
const THICK_LINE = 1.5;
const THIN_LINE = 0.5;
const LINE_COLOR = "#000000";

/** The title sits above the table, so its height budget is the model's
 * TITLE_HEIGHT (20pt): the text itself plus this bottom margin. */
const TITLE_FONT_SIZE = 11;
const TITLE_MARGIN_BOTTOM = 4;

/* ------------------------------------------------------------------ */
/* pdfmake loading                                                     */
/* ------------------------------------------------------------------ */

type PdfMake = typeof import("pdfmake/build/pdfmake");

let fontsRegistered = false;

/**
 * Dynamically imports pdfmake and registers Helvetica, keeping both the
 * ~973 kB bundle and the ~288 kB metrics out of the main chunk - same
 * reason the Excel export defers exceljs.
 *
 * Font registration mutates pdfmake's module-level singleton, so it is
 * done once per page load rather than on every export.
 */
async function loadPdfMake(): Promise<PdfMake> {
  const namespace = await import("pdfmake/build/pdfmake");
  // See spike finding 1: the namespace is the UMD bundle's internals;
  // `.default` is the real instance. The typings describe the namespace,
  // which is why this needs a cast rather than just a property access.
  const pdfMake = (namespace as unknown as { default: PdfMake }).default;

  if (!fontsRegistered) {
    const helvetica = (await import("pdfmake/build/standard-fonts/Helvetica")).default;
    pdfMake.addFontContainer(helvetica);
    pdfMake.setFonts(helvetica.fonts);
    fontsRegistered = true;
  }

  return pdfMake;
}

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Table layout reproducing the doctor-block border scheme. `i` is a
 * horizontal *boundary* index, 0 at the top of the header row through
 * `rowCount` at the bottom of the table; body row `r` (0-based, AM when
 * even) sits below boundary `r + 1`.
 */
const TABLE_LAYOUT: TableLayout = {
  hLineWidth: (i, node) => {
    const lastBoundary = node.table.body.length;
    if (i === 0) return THIN_LINE; // top of the header row
    if (i === lastBoundary) return THICK_LINE; // below the final PM row
    // Above an AM row (block top) is thick; above a PM row (the within-
    // doctor divider) is thin.
    return (i - 1) % 2 === 0 ? THICK_LINE : THIN_LINE;
  },
  vLineWidth: () => THIN_LINE,
  hLineColor: () => LINE_COLOR,
  vLineColor: () => LINE_COLOR,
  paddingLeft: () => CELL_PADDING_X,
  paddingRight: () => CELL_PADDING_X,
  paddingTop: () => CELL_PADDING_Y,
  paddingBottom: () => CELL_PADDING_Y,
};

/**
 * A body cell's text runs: every line bold except a trailing note, the
 * same rule `buildRichText` applies in the Excel export. An empty cell
 * (no template entry for that doctor/slot) renders as blank text so the
 * grid still draws its borders around it.
 */
function cellText(cell: PdfCell): Content {
  if (cell.lines.length === 0) return "";

  return cell.lines.map((line, index) => {
    const isLastLine = index === cell.lines.length - 1;
    return {
      text: isLastLine ? line : `${line}\n`,
      bold: !(cell.isNote && isLastLine),
    };
  });
}

function bodyCell(cell: PdfCell): TableCell {
  return {
    text: cellText(cell),
    alignment: "center",
    color: `#${cell.fontHex}`,
    ...(cell.fillHex === null ? {} : { fillColor: `#${cell.fillHex}` }),
  };
}

function buildTable(page: PdfPage, bodyFontSize: number): Content {
  const header: TableCell[] = [
    { text: "" },
    ...page.dayHeaders.map((dayHeader) => ({
      text: dayHeader.text,
      bold: true,
      alignment: "center" as const,
      // Closed days are greyed in the header exactly as the Excel export
      // and the on-screen grid grey them; the closed *columns* are greyed
      // by the model, per cell.
      ...(dayHeader.closed ? { fillColor: `#${CLOSED_COLUMN_HEX}` } : {}),
    })),
  ];

  const body: TableCell[][] = page.rows.map((row) => {
    const first: TableCell =
      row.doctorLabel === null
        ? // The AM row's rowSpan covers this cell; pdfmake still needs a
          // placeholder object in the array for column alignment.
          {}
        : {
            text: row.doctorLabel,
            rowSpan: 2,
            bold: true,
            fontSize: bodyFontSize + 1,
            alignment: "center",
          };

    return [first, ...row.cells.map(bodyCell)];
  });

  return {
    table: {
      // The doctor column is fixed at the width the fit estimate assumed;
      // the five day columns share whatever is left, which guarantees the
      // table cannot overflow the page however the margins are tuned.
      widths: [DOCTOR_COL_WIDTH - CELL_PADDING_X * 2, "*", "*", "*", "*", "*"],
      // Repeat the day headers if a week does spill onto a second page
      // (Design Decision 3 - user-confirmed as acceptable).
      headerRows: 1,
      body: [header, ...body],
    },
    layout: TABLE_LAYOUT,
  };
}

function buildDocDefinition(model: RotaPdfDocument): TDocumentDefinitions {
  const content: Content[] = [];

  model.pages.forEach((page, index) => {
    content.push({
      text: page.title,
      bold: true,
      fontSize: TITLE_FONT_SIZE,
      alignment: "center",
      margin: [0, 0, 0, TITLE_MARGIN_BOTTOM],
      // One generation week per page.
      ...(index === 0 ? {} : { pageBreak: "before" as const }),
    });
    content.push(buildTable(page, model.bodyFontSize));
  });

  return {
    pageSize: "A4",
    pageOrientation: "portrait",
    pageMargins: PAGE_MARGINS,
    defaultStyle: {
      font: "Helvetica",
      fontSize: model.bodyFontSize,
      lineHeight: LINE_HEIGHT,
    },
    content,
  };
}

/**
 * Builds the committed-rota PDF and returns it as a Blob.
 *
 * `closureNameByDate` is the *live* closures list (cosmetic-name lookup
 * only, same as RotaGrid) - closed-ness itself always comes from
 * `rota.closed_slots`, the RotaClosure snapshot, never this map.
 */
export async function buildRotaPdf(
  rota: Rota,
  doctors: Doctor[],
  rooms: Room[],
  clinicTypes: ClinicType[],
  closureNameByDate: Map<string, string | null>,
): Promise<Blob> {
  const model = buildRotaPdfModel(rota, doctors, rooms, clinicTypes, closureNameByDate);
  const pdfMake = await loadPdfMake();

  return pdfMake.createPdf(buildDocDefinition(model)).getBlob();
}
