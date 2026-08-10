# Implementation Plan: PDF Export for Committed Rotas

# Plan

Add an "Export to PDF" button alongside the existing "Export to Excel" on
`RotaDetailPage`, under the same gating (committed rotas, including
archived). Output is A4 **portrait**, one generation week per page,
reproducing the on-screen grid — same pivot, same doctor ordering, same
Q13 colour rules — generated entirely client-side. No backend changes.

The target format is evidenced, not guessed. The practice's real printed
rota (`ROTA_WC_10.8.26.xls`, `TERM` sheet) was inspected at the BIFF
record level:

| Setting | Value in the live file |
|---|---|
| Paper | A4, **portrait** (`SETUP` grbit `0x0002`, `fLandscape` set = portrait) |
| Fit | fit to **1 page wide × 1 page tall**, stored scale 50% |
| Margins | 4mm left/right, 10mm top/bottom |
| Header / footer | none (both records empty) |
| Page breaks | none — one week, one page |

Content on that sheet measures 12.85in × 22.34in against a 7.96 × 10.90in
usable area. Height binds, giving an effective print scale of ~49% —
matching the stored 50%. **Body text set at 11pt therefore prints at
~5.4pt today, and doctor names at 14pt print at ~6.8pt.** That is the
status quo doctors already read from. Row heights in that file are
hand-tuned and generous (many two-line cells sitting in 50–66pt rows), so
a generated PDF that sizes rows to their actual content should land nearer
6.5–7pt — modestly better than today, not worse.

# Scope

**In scope**

- New frontend dependency `pdfmake`, dynamically imported, configured
  against the **PDF standard-14 fonts** (Helvetica) so no font VFS ships.
- Extraction of the library-agnostic cell-content logic currently inside
  `exportRota.ts` into a shared module both exports consume.
- New pure document-model builder + a thin pdfmake serialisation layer.
- "Export to PDF" button on `RotaDetailPage`, gated exactly like the
  Excel button.
- Vitest coverage for the document model and the button gating.

**Out of scope**

- Draft rota export (matches the Excel export's gating).
- Any backend endpoint, server-side rendering, or shareable URL. The
  LibreOffice pipeline in `backend/app/documents/pdf_convert.py` is for
  signature RTFs and is not involved.
- Changes to the Excel export's *output*. Task 1 refactors its internals
  but must not alter a single byte of the produced `.xlsx`.
- Changes to the on-screen grid.
- The room-occupancy pages — deferred to Task 6, which is explicitly
  optional and can be dropped without affecting Tasks 1–5.
- The paper sheet's `OTHERS` row (remote pharmacist, WFH staff) and its
  `No Schools/No Colleges/No DVLA` title suffix. See Design Decision 11.

# Design Decisions

**1. Client-side, mirroring the Excel export.** The builder consumes the
same functions the grid renders with — `pivotRota`, `getCell`,
`cellStyle`, `countSupervisableTrainees`, `rotaDate` — so structural drift
between screen, spreadsheet and PDF is impossible.

**2. Library: `pdfmake`, dynamically imported, standard-14 fonts only.**
Chosen over jsPDF+autoTable because it handles per-cell background fills,
`rowSpan`, and declarative table layout natively — a close fit for
`cellStyle.ts`'s colour output and for the merged doctor-name cell.
pdfmake normally ships a ~1.5MB base64 Roboto VFS; the real printout uses
Arial/Arial Black only, and Helvetica (a PDF standard-14 font, present in
every reader, metrically close to Arial) is an acceptable substitute. The
export therefore registers Helvetica/Helvetica-Bold and ships **no font
data at all**. Task 1 is a spike that must confirm this works under this
project's Vite/Vitest setup before any other work starts.

**3. A4 portrait, one week per page, auto-fitted font size.** Confirmed
against the real artefact (see Plan). pdfmake has no shrink-to-fit, so the
fit is achieved by *choosing* a body font size rather than scaling a fixed
one: a pure function walks a ladder of candidate sizes from largest to
smallest and returns the first whose estimated content height fits the
page. This is deterministic and unit-testable, unlike a post-hoc scale.
User has confirmed that spilling onto more than one page is acceptable, so
if even the smallest candidate does not fit, the week paginates with the
day-header row repeated — no illegible sub-5pt output.

**4. Shared content module, not a third copy.** `exportRota.ts` already
holds ~130 lines of pure, exceljs-independent content logic —
`roleLabelText`, `cellLines`, `roomCellLines`, `dayHeaderText`,
`buildSupervisedCounts`, `supervisedCountKey`, `toIdMap`. These were
already duplicated once out of `RotaGrid.tsx`'s `CellContent`, and
`exportStyles.ts` carries a "KEPT IN SYNC MANUALLY" warning as a result.
Copying them a third time into a PDF module guarantees drift on the next
content change. Task 2 extracts them to `exportContent.ts`; both exports
consume it.

**5. A document model between the data and pdfmake.** `exportRota.test.ts`
round-trips its Blob back through ExcelJS and asserts on real cell values,
fills and merges. **There is no equivalent for PDF** — the honest ceiling
on a direct test of a PDF Blob is "non-empty, starts with `%PDF`", which
is worth almost nothing. So `buildRotaPdf` first composes a plain
`RotaPdfDocument` object (pages → rows → cells carrying text lines, fill
hex, font colour, span) which is unit-tested exhaustively, and the
pdfmake call is a thin, deliberately thinly-tested shell. **PDF coverage
will be weaker than the Excel export's. Accept that explicitly rather
than pretending parity.**

**6. A week title row.** The real printout's identifying line is
`W/C - 10TH AUGUST 2026 - ...`, merged across the full width at 16pt bold.
The app emits nothing equivalent. The PDF adds a title row using the
existing `formatWeekLabel()` (`"w/c 13 Jul 2026"`, already `en-GB`-pinned
and tested), followed by any closure names active in that week, taken from
`rota.closed_slots` + the live `closureNameByDate` lookup already passed
to the Excel builder.

**7. No AM/PM session column.** The paper sheet has none: the first row of
each pair is AM, the second PM, implicit. Dropping `SESSION_COL` matches
the printout and reclaims ~4% of a very tight page width. The Excel export
keeps its session column unchanged.

**8. Day headers as `MON 10th`, not `Monday 10 Aug 2026`.** Matches the
printout and saves horizontal space at the smallest font sizes. This is
the one place the PDF deliberately does *not* reuse `dayHeaderText()`'s
output verbatim — it reuses the closure-suffix logic but with a compact
date format (see Task 2, deliverable 3).

**9. The PDF uses the app's colour palette, not the paper's.** The real
sheet fills only "No Surgery" cells (silver `C0C0C0`) and carries all
other signal in *font* colour — blue `0066CC` for Wolvercote, red
`FF0000` for Cuttestlowe, i.e. exactly the app's room-type font-colour
rule, which evidently originated there. `cellStyle`'s three role
backgrounds (duty red, clinic green, duty-helper blue) have **no paper
counterpart**. Reusing the full app palette via `exportStyles.ts` is still
the right call — consistency across screen, Excel and PDF beats fidelity
to a spreadsheet nobody maintains after go-live — but this is a visible
difference from the printout and is a decision, not an oversight.

**10. Room pages are optional and last.** The real workbook contains only
a master template (`HOLS`) and the week (`TERM`) — there is no
room-occupancy sheet anywhere in it. The Excel export's room sheets are an
app addition with no paper precedent. Task 6 adds room pages for parity
with the Excel export; if page count or effort is a concern, drop Task 6
and nothing else changes.

**11. `OTHERS` row and school-holiday title suffix stay out.** The
printout's title reads `No Schools/No Colleges/No DVLA` and its last row
lists non-doctor staff (remote pharmacist, WFH cover). The app has no
`OTHERS` concept and no DVLA concept, and `School`/`SchoolHoliday` data is
deliberately isolated — `school_holidays.md` states as a hard line that
nothing outside the planner reads it. Wiring it into an export would break
that. Flag to users that the PDF will look incomplete beside the old
printout in these two respects; do not paper over it in code.

**12. Filename.** `rota-{start_date}-to-{last_friday}.pdf`, reusing the
existing `exportFilename()` with the extension parameterised.

# Task 1: pdfmake spike (gate)

**A.** Nothing implemented yet. This task decides whether the whole
approach is viable. The Excel export's own Task 1 was the same kind of
gate, and its residue is the comment at `exportRota.ts:433` — *"No
`.default` — confirmed against this project's Vite/Vitest setup by the
Task 1 spike"*. Do the same here. **If this task fails, stop and report
back; do not proceed to Task 2.**

**B.** Files:
- `frontend/package.json` — add `pdfmake` and `@types/pdfmake`
- `frontend/src/lib/__spike_pdfmake.test.ts` — throwaway, deleted at the
  end of this task (the exceljs spike file was handled the same way)

Deliverables:
1. A one-line record of the working import shape (`.default` or not) for
   both `pdfmake/build/pdfmake` and the standard-fonts configuration, to
   be pasted into `exportRotaPdf.ts`'s docstring in Task 4.
2. Confirmation that a document declaring `defaultStyle: { font: "Helvetica" }`
   against `pdfMake.fonts = { Helvetica: { normal: "Helvetica", bold: "Helvetica-Bold", ... } }`
   produces a valid PDF **without** importing `vfs_fonts`.
3. Confirmation the same code path runs under jsdom in Vitest (the suite's
   environment per `vite_config.ts`), producing a Blob or Buffer that
   starts with `%PDF`.
4. A measured size for the lazy chunk (`npm run build`, report the
   pdfmake chunk in bytes).

**C.**
- Install, then write the spike test: build a trivial two-row table with a
  `fillColor`, a `rowSpan`, and bold + coloured text; assert the output
  starts with `%PDF`.
- pdfmake's browser entry is CJS-flavoured and its interop under Vite is
  the known risk. Try, in order: `await import("pdfmake/build/pdfmake")`,
  then `.default` off that namespace. Record which works.
- Standard-14 fonts are the *second* risk: pdfmake defaults to a VFS
  lookup and will throw `File 'Roboto-Regular.ttf' not found in virtual
  file system` if the font config is wrong. The fix is assigning
  `pdfMake.fonts` before `createPdf`. If standard fonts cannot be made to
  work, **stop and report** — falling back to the Roboto VFS is a ~1.5MB
  decision the user has not agreed to.
- Delete the spike file before committing; the knowledge moves into
  comments in Task 4.

# Task 2: Extract the shared content module

**A.** Task 1 has confirmed pdfmake works with standard fonts. No PDF code
exists yet. This task is a **pure refactor of the existing Excel export**
— it must not change the produced `.xlsx` in any way. The existing
540-line `exportRota.test.ts` is the proof of that, and it must pass
untouched.

**B.** Files:
- `frontend/src/lib/exportContent.ts` (new)
- `frontend/src/lib/exportContent.test.ts` (new)
- `frontend/src/lib/exportRota.ts` (refactor: delete the moved functions,
  import them instead)
- `frontend/src/lib/exportRota.test.ts` (**must pass with zero edits**)

Deliverables:
1. `exportContent.ts` exporting, moved verbatim from `exportRota.ts`:
   `roleLabelText`, `cellLines`, `roomCellLines`, `dayHeaderText`,
   `buildSupervisedCounts`, `supervisedCountKey`, `toIdMap`. Move the
   docstrings with them — they carry the `CellContent` mirroring rules and
   are the reason this logic is trustworthy.
2. `exportRota.ts` importing all seven and no longer defining them. Its
   module docstring gains a line pointing at `exportContent.ts` as the
   shared content authority.
3. `exportContent.test.ts` covering the moved functions directly (they
   were previously only tested through the workbook artefact): leave
   suppression, WFH suppressing room but not role, `Supervising x N` vs
   bare `Supervising`, `No surgery`/`Admin` only when role is null,
   trailing-note ordering.
4. A new `compactDayHeaderText(day, date, closedSlotSet, closureNameByDate)`
   alongside `dayHeaderText`, producing `MON 10th` (uppercase 3–5 char day
   abbreviation + ordinal day-of-month) with the same closure suffix
   behaviour as `dayHeaderText`. Only the PDF uses it. Test the ordinal
   suffixes (1st/2nd/3rd/11th/21st) explicitly.

**C.**
- Move first, test second. Run `npx vitest run src/lib/exportRota.test.ts`
  after the move and before writing anything new — a green run there is
  the whole safety net for this task.
- `buildRichText` stays in `exportRota.ts`: it returns exceljs-shaped
  rich-text runs and has no PDF equivalent.
- Do not "improve" any moved function. Behaviour changes here would show
  up as Excel export regressions attributed to the PDF feature.

# Task 3: The document model builder

**A.** Tasks 1–2 are done: pdfmake is proven to work with standard fonts,
and the shared content logic lives in `exportContent.ts`. This task builds
the pure, library-agnostic representation of the PDF — no pdfmake import
anywhere in it. This is where essentially all the test value of the
feature lives (Design Decision 5).

**B.** Files:
- `frontend/src/lib/rotaPdfModel.ts` (new)
- `frontend/src/lib/rotaPdfModel.test.ts` (new)

Deliverables:
1. Types:
   ```ts
   interface PdfCell { lines: string[]; fillHex: string | null; fontHex: string; isNote: boolean; }
   interface PdfRow { period: Period | null; doctorLabel: string | null; cells: PdfCell[]; }
   interface PdfPage { title: string; dayHeaders: { text: string; closed: boolean }[]; rows: PdfRow[]; }
   interface RotaPdfDocument { pages: PdfPage[]; bodyFontSize: number; }
   ```
2. `buildRotaPdfModel(rota, doctors, rooms, clinicTypes, closureNameByDate) → RotaPdfDocument`
   — one page per generation week, rows in `pivotRota` order, two rows per
   doctor (AM then PM), `doctorLabel` set on the AM row only (the PDF
   layer turns that into a `rowSpan: 2`), `(inactive)` suffix preserved
   from the Excel export.
3. `chooseBodyFontSize(page: PdfPage): number` — the fitting function.
   Walks `[9, 8, 7, 6, 5.5]` largest-first and returns the first size
   whose estimated height fits. Estimation:
   - Usable page: A4 portrait 595.28 × 841.89pt, margins 12pt L/R and
     28pt T/B → **571 × 786pt usable**.
   - Reserve ~20pt for the title row and ~2.2 × fontSize + 4pt for the day
     header row; the rest is body budget.
   - Day column width = `(571 - 60) / 5 = 102pt` (60pt for the doctor
     column). Characters per line ≈ `102 / (0.5 × fontSize)` — Helvetica's
     average advance is close to 0.5em for this kind of text.
   - Per-cell wrapped line count = sum over `lines` of
     `max(1, ceil(line.length / charsPerLine))`.
   - Row height = `maxLinesInRow × 1.15 × fontSize + 4`.
   - Fits if the summed row heights ≤ body budget.
   Return the smallest candidate if none fits (the page then paginates —
   Design Decision 3).
4. Colour resolution: `cellStyle()` → `BACKGROUND_HEX` / `FONT_HEX`, kept
   as 6-digit hex (pdfmake takes `#RRGGBB`; `argb()` is exceljs-only and
   must not be used here). Closed slots override the fill with
   `CLOSED_COLUMN_HEX`, same precedence as `exportRota.ts`.

**C.**
- Reuse `exportContent.ts` for every string. This module decides
  *structure and geometry*, never content.
- Title: `formatWeekLabel(rotaDate(rota.start_date, week, "Monday"))`, plus
  `" — "` and a comma-joined list of distinct closure names for that week
  (from `closureNameByDate`, skipping nulls). No closures → title is the
  week label alone.
- Test the fitting function directly and hard — it is the one piece of
  novel logic here. Cover: a small practice getting 9pt; a 21-doctor
  practice with two-line cells (the real-world case from the sample file)
  landing at 6–7pt; a pathological page with five-line cells falling
  through to the smallest candidate. Assert the *returned size*, not
  pixel-perfect heights.
- Test the model against the same fixtures `exportRota.test.ts` uses
  (`makeRota`, `makeRotaSession`, `makeDoctor`, `makeRoom`,
  `makeClinicType` from `@/test/fixtures/`), so a shared-logic regression
  fails in both suites.
- No `import("pdfmake")` in this file. A reviewer should be able to run
  this suite with pdfmake uninstalled.

# Task 4: pdfmake serialisation

**A.** Tasks 1–3 are done: the document model is built and tested, and the
pdfmake import shape is known from the Task 1 spike. This task turns a
`RotaPdfDocument` into a Blob. It is deliberately thin and deliberately
lightly tested (Design Decision 5).

**B.** Files:
- `frontend/src/lib/exportRotaPdf.ts` (new)
- `frontend/src/lib/exportRotaPdf.test.ts` (new, minimal)

Deliverables:
1. `buildRotaPdf(rota, doctors, rooms, clinicTypes, closureNameByDate) → Promise<Blob>`
   — same signature as `buildRotaWorkbook`, so the two are
   interchangeable at the call site.
2. Module docstring recording the Task 1 spike findings verbatim (import
   shape, standard-fonts config), in the style of `exportRota.ts:433`.
3. Page setup: A4, `pageOrientation: "portrait"`, margins `[12, 28, 12, 28]`,
   `defaultStyle: { font: "Helvetica", fontSize: <from the model> }`.
4. Table layout reproducing the paper's border scheme, which the Excel
   export already matches (verified against the sample file: medium top /
   thin middle / medium bottom per doctor block, `2`/`1`/`2` line styles
   in BIFF). Doctor name cell: `rowSpan: 2`, bold, one point larger than
   body. Notes: the trailing line renders unbold, matching
   `buildRichText`'s rule.
5. One page per week via `pageBreak: "before"` on each page after the
   first.

**C.**
- Dynamic `await import(...)` inside the function, never at module top
  level — same reason as exceljs.
- pdfmake's `createPdf(...).getBlob(cb)` is callback-based; wrap it in a
  Promise and reject on error so `handleExport`'s `catch` still fires.
- Tests here assert only: the Blob is non-empty, its first bytes are
  `%PDF`, and page count matches `num_weeks` if that is cheaply
  extractable. **Do not** invest in PDF text extraction — that coverage
  belongs to Task 3's model tests. Say so in a comment so a later reader
  does not mistake the thin suite for an oversight.

# Task 5: UI wiring

**A.** Tasks 1–4 are done: `buildRotaPdf` produces a correct PDF. Nothing
in the UI calls it yet. This task adds the button.

**B.** Files:
- `frontend/src/routes/RotaDetailPage.tsx`
- `frontend/src/routes/RotaDetailPage.test.tsx`

Deliverables:
1. "Export to PDF" button beside "Export to Excel", same styling, same
   gating (`isCommitted`, `exportLookupsLoading`).
2. `exporting` state changed from `boolean` to `"excel" | "pdf" | null` —
   as a boolean it would grey out both buttons and mislabel them when
   either is clicked.
3. `exportFilename(startDate, numWeeks, extension)` — extension
   parameterised, `.xlsx` and `.pdf` call sites both updated.
4. Gating tests mirroring the three existing Excel ones at
   `RotaDetailPage.test.tsx:789-830`: shows for committed, shows for
   archived, hidden for draft.

**C.**
- Factor the shared prologue of `handleExport` (the `closureNameByDate`
  build and the null guard) rather than copying it; the two handlers
  should differ only in builder and extension.
- While in this file: it defines a local `downloadBlob` at line 75 that is
  byte-identical to `@/lib/downloadBlob`, whose own docstring notes the
  duplication. Delete the local one and import the shared one.
- Do not attempt to test the download itself. The existing comment at
  `RotaDetailPage.test.tsx:791` explains why (object-URL anchors do not
  work in jsdom) and that reasoning is unchanged.

# Task 6: Room pages (optional)

**A.** Tasks 1–5 are done and the PDF export is shipped and working for
doctor grids. This task adds room-occupancy pages for parity with the
Excel export's `Room Week N` sheets. **It is optional** — see Design
Decision 10. Do not start it without confirming the user still wants it.

**B.** Files:
- `frontend/src/lib/rotaPdfModel.ts` + its test
- `frontend/src/lib/exportRotaPdf.ts`

Deliverables:
1. `buildRotaPdfModel` gains a `includeRoomPages: boolean` option,
   emitting a room page after each week's doctor page (matching the Excel
   export's user-confirmed Week 1, Room Week 1, Week 2, … ordering).
2. Room rows from `pivotRoomRota` in its existing order, cell content from
   `roomCellLines` (already shared as of Task 2), fills from
   `ROOM_OCCUPIED_HEX` / `CLOSED_COLUMN_HEX`.

**C.**
- Room pages have one row per room rather than per doctor, so they are
  usually shorter than doctor pages — run `chooseBodyFontSize` per page,
  not once per document, so a room page is not shrunk to a doctor page's
  size.
- Closed cells render blank, not "Available", matching both the on-screen
  room view and `buildRoomWeekSheet`'s existing behaviour.

# Verification

- Tasks 2, 3 and 5 carry the real automated coverage. CI runs the full
  suite on every commit; per `CLAUDE.md`, run only the changed-file suites
  during implementation chats.
- Manual check once Task 5 lands: export a multi-week committed rota with
  a realistic doctor count, a closed day, a part-time doctor with absent
  slots, a leave entry and a cell with a note. Confirm one page per week,
  legible text, and that colours survive a mono print.
- No backend tests: nothing server-side changes.
