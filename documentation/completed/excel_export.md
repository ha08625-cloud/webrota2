# Implementation Plan: Excel Export for Committed Rotas

# Plan

Add a client-side Excel (.xlsx) export for committed rotas. The export
reproduces the on-screen rota grid — same pivot, same doctor ordering,
same Q13 colour rules — one worksheet per generation week, downloaded
from a button on `RotaDetailPage`. Entirely frontend: no new backend
endpoint, no backend changes at all.

# Scope

In scope:
- New frontend dependency `exceljs`, loaded via dynamic `import()` only
  when the user clicks Export.
- New pure builder module `frontend/src/lib/exportRota.ts` plus a colour
  hex-mapping table.
- Export button on `RotaDetailPage`, visible for committed rotas only
  (including archived ones).
- Vitest coverage for the builder and the button gating.

Out of scope:
- Draft rota export.
- Any backend endpoint or shareable export URL — the file exists only as
  a browser download.
- PDF or print-CSS output.
- Exporting the room-centric view (`RoomRotaGrid`).

# Design Decisions

1. **Frontend-generated (Option B).** The builder consumes the exact
   functions the grid renders with — `pivotRota`, `getCell`,
   `cellStyle`, `compareDoctorDisplayOrder` (via `pivotRota`),
   `countSupervisableTrainees`, `rotaDate` — so structural drift between
   screen and file is impossible. The only hand-maintained duplication
   is a small semantic-colour-to-hex table (see Decision 3).
2. **Library: `exceljs`, dynamically imported.** `exceljs` supports cell
   fills, font colours, column widths, and native cell comments. It is
   large (~1 MB minified) and has Node-runtime assumptions, so it must
   be loaded with `await import("exceljs")` inside the click handler,
   keeping it out of the initial bundle, and Task 1 must verify it
   actually builds and runs under this Vite setup before Tasks 2–4
   proceed. Do not use SheetJS `xlsx` (free build lacks styling) or its
   styling forks (poorly maintained).
3. **Colour source of truth.** `cellStyle()` remains the single Q13
   authority; it returns semantic `CellBackground` / `FontColor` values.
   The export adds one hex map per semantic value, structured exactly
   like the `BACKGROUND_CLASS` / `FONT_CLASS` Tailwind maps in
   `RotaGrid.tsx` (7 background entries, 3 font entries). This is a
   known, accepted duplication: a palette change needs two edits. Add a
   comment in both files pointing at the other.
4. **Cell text mirrors `CellContent` exactly.** Per cell, in this order,
   newline-separated within the cell (`alignment.wrapText = true`):
   - `LEAVE` if `is_on_leave` (and nothing else — leave suppresses all
     other content, matching `CellContent`).
   - `WFH` if `is_wfh` (suppresses room, not role).
   - `Supervising x N` if `is_supervising` (plain `Supervising` when the
     computed count is 0, mirroring the UI's deliberate choice).
   - `No surgery` / `Admin` when role is null and `template_type` is
     `no_surgery` / `admin_time`.
   - Role label: `Duty`, `Duty (2nd)`, or the clinic type name
     (`clinic_type_name ?? "Clinic"`).
   - Room code, when present and not WFH/leave.
   An absent cell (no session row) is an empty white cell — cell absence
   is data, same as the grid.
5. **Notes become Excel cell comments,** not cell text — mirroring the
   popover. `exceljs` cell `note` property. Task 1's spike must confirm
   notes survive the browser build and open correctly in Excel.
6. **Column headers carry real dates.** Header row per day column:
   `Monday 06/07` style, computed with `rotaDate(start_date, week, day)`
   and the existing `formatDate` helper from `lib/date.ts`. Closed dates
   append the closure name (from the live closures list, cosmetic only,
   same rule as `RotaGrid`) or the word `closed`.
7. **Closed-date columns are grey for the full column height** — a
   deliberate divergence from the UI, which greys only the header (body
   cells on closed dates are simply absent). On screen the surrounding
   chrome explains a blank column; on paper it reads as missing data.
   Closed-ness comes from `rota.closed_dates` (the `RotaClosure`
   snapshot on the payload), never the live closures table.
8. **One worksheet per generation week,** named `Week 1` … `Week N`,
   sheet count equal to `num_weeks`. Rows: two header rows are not
   needed — a single header row (Doctor, Session, then the five day
   columns), then doctor blocks of two rows (AM/PM) in `pivotRota` row
   order. Inactive doctors with sessions appear with an `(inactive)`
   suffix on the code, matching the grid.
9. **Availability: committed rotas only, archived included.** Button
   gating is `rota.status === "committed"` — `archived_at` does not
   affect it (archived is a flag on a committed rota, not a status).
   Drafts get no button.
10. **Filename:** `rota-{start_date}-to-{last_friday}.xlsx`, where
    `last_friday = addDays(start_date, num_weeks * 7 - 3)`, e.g.
    `rota-2026-07-06-to-2026-07-31.xlsx` for a 4-week rota.
11. **Button placement and data.** The button lives on `RotaDetailPage`
    next to Archive/Rollback. The builder needs doctors
    (`active_only=false`), rooms, clinic types, and the live closures
    list; `RotaDetailPage` calls the same hooks `RotaGrid` already uses
    (`useDoctors(false)`, `useRooms`, `useClinicTypes`, `useClosures`) —
    TanStack Query dedupes against `RotaGrid`'s fetches, so this costs
    nothing at runtime. The button is disabled while any lookup is
    still loading.
12. **The builder is pure and takes no dependency on exceljs at module
    top level.** `exportRota.ts` exports an async function that itself
    dynamically imports exceljs, receives plain data
    (`Rota`, `Doctor[]`, `Room[]`, `ClinicType[]`, closures), and
    returns a `Blob`. Tests call it directly in Node, where the dynamic
    import resolves normally.

# Task 1: Dependency spike and colour map

A: Nothing has been built yet. This task proves `exceljs` works in this
Vite + Vitest setup and creates the colour mapping module, so Tasks 2–4
can proceed without integration risk. If the spike fails, stop and
report back rather than working around it — the library choice would
need revisiting.

B: Files touched / deliverables:
- `frontend/package.json` / `package-lock.json` — add `exceljs` as a
  dependency (latest 4.x).
- New `frontend/src/lib/exportStyles.ts` — hex maps + shared style
  constants.
- Throwaway spike verification (a minimal test or scratch script,
  deleted or folded into Task 4's tests — do not commit scratch files).

C: Instructions:
1. `npm install exceljs` in `frontend/`. Confirm `npm run build`
   (Vite) succeeds with a component that does
   `const ExcelJS = await import("exceljs")` — check the produced chunk
   is split (exceljs must not appear in the main bundle; verify via the
   build output's chunk listing).
2. In a Vitest test, build a tiny workbook: one sheet, one cell with a
   solid fill, a font colour, a column width, and a cell `note`; write
   it with `workbook.xlsx.writeBuffer()` and assert the buffer is
   non-empty and re-readable via `workbook.xlsx.load()`. This proves
   fills, notes, and buffer round-tripping all work in this
   environment.
3. Create `exportStyles.ts`:
   - `BACKGROUND_HEX: Record<CellBackground, string | null>` — one
     entry per semantic value in `cellStyle.ts` (`leave`, `wfh`,
     `duty`, `duty_helper`, `clinic`, `no_surgery`, `default`). Pick
     hex values matching the Tailwind classes in `RotaGrid.tsx`'s
     `BACKGROUND_CLASS` map (read the actual class values there; e.g. a
     `bg-gray-200`-style class maps to its Tailwind v3.4 default hex).
     `default` (and `wfh`, which renders white in the UI) map to `null`
     meaning no fill.
   - `FONT_HEX: Record<FontColor, string>` — `black`, `red`, `blue`,
     again matched to `FONT_CLASS`.
   - `CLOSED_COLUMN_HEX` — the closed-column grey (match the header's
     `bg-gray-200`).
   - A comment in this file and a matching one added to `RotaGrid.tsx`
     stating the two maps must change together.
4. exceljs ARGB note: fills use 8-digit `FFRRGGBB` strings. Store plain
   6-digit hex in the maps and add a tiny `argb(hex)` helper in
   `exportStyles.ts` so the Tailwind correspondence stays readable.

# Task 2: Export builder module

A: Task 1 is complete: `exceljs` is installed and proven under Vite and
Vitest, and `exportStyles.ts` exists with the hex maps. This task builds
the workbook builder itself.

B: Files touched / deliverables:
- New `frontend/src/lib/exportRota.ts` — the builder.
- Reads (no changes): `pivot.ts` (`pivotRota`, `getCell`, `DAYS`,
  `PERIODS`, `weekNumbers`), `cellStyle.ts`, `superviseeCount.ts`
  (`countSupervisableTrainees`), `weekDates.ts` (`rotaDate`),
  `lib/date.ts` (`addDays`, `formatDate`), `exportStyles.ts`,
  `api/types.ts`.

C: Instructions:
1. Export an async function:
   `buildRotaWorkbook(rota: Rota, doctors: Doctor[], rooms: Room[], clinicTypes: ClinicType[], closureNameByDate: Map<string, string | null>): Promise<Blob>`.
   First line: `const ExcelJS = (await import("exceljs")).default;`
   (confirm the correct import shape from Task 1's spike — exceljs's
   ESM/CJS interop under Vite may need `.default` or not; use whatever
   the spike proved).
2. Build lookups once: `roomsById`, `clinicTypesById` (same `toIdMap`
   pattern as `RotaGrid`), `closedDatesSet` from `rota.closed_dates`,
   and the supervised-count map — replicate `RotaGrid`'s
   `supervisedCounts` memo logic exactly: for each session with
   `is_supervising`, count via `countSupervisableTrainees` over all
   sessions in the same (week, day, period). Read the memo in
   `RotaGrid.tsx` first and match it; do not re-derive from the Phase 9C
   docs.
3. `pivotRota(rota.sessions, doctors)` once; iterate
   `weekNumbers(rota.num_weeks)`, one worksheet per week named
   `Week {n}`.
4. Per sheet:
   - Columns: `Doctor` (width ~14), `Session` (width ~8), five day
     columns (width ~22).
   - Header row: `Doctor`, `Session`, then per day
     `{day} {formatDate(rotaDate(rota.start_date, week, day))}` plus, if
     the date is in `closedDatesSet`, a second line with the closure
     name from `closureNameByDate` or `closed`. Bold font; closed-day
     header cells get `CLOSED_COLUMN_HEX` fill.
   - Body: for each `grid.rows` entry, two rows (AM, PM). Doctor code in
     the first column of the AM row only (append ` (inactive)` when
     `inactiveWithSessions`); merge the two doctor-column cells
     vertically (`mergeCells`). Session column: `AM` / `PM`.
   - Per day cell: `getCell(grid, doctor.id, week, day, period)`. Text
     per Design Decision 4, joined with `\n`, `wrapText: true`,
     vertical alignment top. Fill from
     `BACKGROUND_HEX[cellStyle(session, roomsById, clinicTypesById).background]`
     (skip fill when `null`); font colour from `FONT_HEX[...fontColor]`.
     If the cell's date is closed, override the fill with
     `CLOSED_COLUMN_HEX` (closed dates have no sessions, so in practice
     this greys empty cells; the override ordering still makes the
     intent explicit).
   - Notes: when `session.notes` is non-null/non-empty, set the cell
     `note` to the notes text.
   - Thin borders on all populated cells so the grid prints legibly.
5. Return
   `new Blob([await workbook.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })`.
6. Keep the module free of React and DOM APIs (no `document`,
   no hooks) — the download trigger is Task 3's job. `Blob` is available
   in both browser and Node 24, so tests need no polyfill.

# Task 3: Export button on RotaDetailPage

A: Tasks 1–2 are complete: `buildRotaWorkbook` exists and returns a
Blob. This task wires the button, gating, filename, and download
trigger.

B: Files touched / deliverables:
- `frontend/src/routes/RotaDetailPage.tsx` — button, handler, hooks.
- Reads: `exportRota.ts`, `api/doctors.ts` / `api/rooms.ts` /
  `api/clinicTypes.ts` / `api/closures.ts` (existing hooks),
  `lib/date.ts`.

C: Instructions:
1. Call `useDoctors(false)`, `useRooms()`, `useClinicTypes()`,
   `useClosures()` in `RotaDetailPage` (cache-deduped against
   `RotaGrid`'s identical calls).
2. Render an `Export to Excel` button in the committed-rota action area
   (near Rollback/Archive — read the existing JSX around the
   `isCommitted` branch and match its styling). Render only when
   `rota.status === "committed"`; do not condition on `archived_at`.
   Disable while any of the four lookups is loading or while an export
   is in flight.
3. Handler:
   - Build `closureNameByDate` from the live closures list (same
     construction as `RotaGrid`'s memo).
   - `const blob = await buildRotaWorkbook(...)` — wrap in try/catch;
     on failure show the existing toast pattern with a plain
     "Export failed" message (follow how `RotaDetailPage` currently
     surfaces mutation errors).
   - Filename per Design Decision 10 using `addDays`.
   - Trigger download: create an object URL, a temporary anchor with
     `download` set, click it, then `URL.revokeObjectURL` — the
     standard pattern; keep it inline in the handler or as a tiny
     `downloadBlob(blob, filename)` helper in `exportRota.ts` guarded
     so tests never call it.
4. No loading spinner beyond the disabled state is required; workbook
   build is fast at this data size (tens of doctors, up to 4 weeks).

# Task 4: Tests

A: Tasks 1–3 are complete. This task adds the permanent test coverage;
fold in (or replace) Task 1's spike test.

B: Files touched / deliverables:
- New `frontend/src/lib/exportRota.test.ts`.
- New or extended `frontend/src/lib/exportStyles.test.ts` (may be
  trivial enough to fold into the above).
- `frontend/src/routes/RotaDetailPage.test.tsx` — extend for button
  gating.
- Reads: existing fixtures (`test/fixtures/rota.ts`,
  `test/fixtures/reference.ts`), `pivot.test.ts` and
  `cellStyle.test.ts` for style conventions.

C: Instructions:
1. Builder tests call `buildRotaWorkbook` directly, then reload the
   buffer with a fresh `Workbook` + `xlsx.load()` and assert against the
   reloaded workbook — this tests the serialised artefact, not exceljs's
   in-memory model, keeping the tests resilient to library upgrades.
   Assert:
   - Sheet count equals `num_weeks`; sheet names `Week 1..N`.
   - A known fixture doctor lands on the expected row with AM/PM rows
     and the expected cell text (role label, room code, LEAVE, WFH,
     Supervising variants — one focused assertion per content rule in
     Design Decision 4, reusing the fixture sessions that
     `cellStyle.test.ts` already exercises where possible).
   - Fill/font of a duty cell, a clinic cell, a leave cell, and a
     C-room cell match `BACKGROUND_HEX` / `FONT_HEX` — assert against
     the map entries, not hardcoded hex literals, so a palette change
     updates tests automatically.
   - A closed-date column: header contains the closure name (or
     `closed`), cells carry `CLOSED_COLUMN_HEX`.
   - A session with notes produces a cell note containing the text.
   - An absent cell (part-time doctor slot) is empty with no fill.
2. Do not attempt pixel/layout assertions (column widths, borders) —
   assert they are set where cheap, but layout fidelity is verified
   manually once against real Excel, not regression-tested.
3. `RotaDetailPage.test.tsx`: extend the existing MSW-backed tests —
   button present for a committed rota, present for an archived rota,
   absent for a draft. Do not test the actual download in jsdom
   (object-URL anchors don't work there); the builder tests cover the
   artefact.
4. Run the full frontend gate (`typecheck`, `vitest`, `build`) and
   confirm the exceljs chunk remains split out of the main bundle.
