# Annual Leave Planner — Excel export (provisional plan)

Status: provisional. Written in a discussion chat; needs review and
expansion into an implementation plan before any code is written.

## Scope

Add an "Export to Excel" button to the Annual Planner
(`LeavePlanningPage`) producing one workbook per **leave year**:

- **Sheet 1 — Summary**: one row per doctor with entitlement, carry-over,
  adjustment, booked, used (chargeable) and remaining sessions.
- **Sheets 2–13 — one per month**, January to December, each a mirror of
  the on-screen planning grid: school-holiday rows, one doctor block
  (AM + PM rows) per doctor, Clinical cover and Weekly cover rows at the
  foot.

Out of scope: PDF export (the rota's PDF path is `exportRotaPdf.ts` +
`rotaPdfModel.ts`, ~750 lines with tests — a separate ticket if anyone
actually prints the planner); any backend change; any export of the
reception leave page.

## Design decisions

**Client-side, ungated, exceljs.** Same posture as the rota export
(`exportRota.ts`): a pure builder taking plain data and returning a
`Blob`, dynamic `import("exceljs")` so the library stays out of the main
bundle, `downloadBlob` in the page handler. Not gated on write access —
it is built from data the page has already fetched, so gating it would
protect nothing. Filename `leave-plan-{year}.xlsx`.

**One sheet per month, not one wide sheet.** A year of weekday columns is
~260 columns; nobody can read that. A month is ~23 columns, which is a
landscape page. Sheet-per-month also lets each sheet keep the grid's own
partial-week padding (`weekdaysInMonth` borrows adjacent-month dates), so
each sheet looks like the screen it mirrors.

**`planningMonth.ts` is already the content authority — do not build an
`exportContent.ts` analogue.** The rota export needed one because
`RotaGrid`'s `CellContent` was component-local. The planner's equivalent
logic (`weekdaysInMonth`, `toCellState`, `serverRows`, `isSurgerySession`,
`isWithinWindow`, `schoolHolidayDatesInRange`, `applyPendingToCoverage`)
already lives in a pure lib module that the grid and the exporter can both
import. That is the single biggest reason this is cheaper than the rota
export was, and it must not be undone by copying logic into the exporter.

**Colour is the one unavoidable duplication.** `LeavePlanningGrid.tsx`
holds cell states as Tailwind classes (`CELL_CLASSES`,
`NO_SURGERY_NORMAL_CLASS`, the closed hatch, the school-holiday indigo,
`coverageClass`). Excel needs hex. Add a leave block to `exportStyles.ts`
carrying the same explicit "KEPT IN SYNC MANUALLY" warning that file
already carries against `cellStyle.ts`. Do not invent a second styles
module.

**Cell text must not rely on colour alone.** On screen a cell shows
`notes || period`, and the period is redundant in Excel (AM/PM is its own
column, as on the rota sheet). So: cell text is the note when there is
one, otherwise a one-letter state code — `L` leave, `E` extra session,
`B` blocked, blank for normal. Colour still carries the state, but a
printed or colour-blind reading of the sheet survives. Closed slots get
the closed fill and no text (matching the room sheet's closed-cell rule);
out-of-window cells get the "not employed" grey and no text.

**Trainees are always included in the export**, in a block below the
counted doctors, regardless of the page's "Show trainees" toggle. The
toggle is a screen-decluttering aid; a file is a record. The Clinical
cover rows still exclude them, exactly as `coverageDoctors` does — this
needs a visible marker on the sheet (a divider row labelled "Trainees —
not counted in clinical cover") or the totals will read as wrong.
*Review chat should confirm this rather than "mirror the toggle"; both are
defensible.*

**Coverage totals need 12 fetches, and that is the one awkward part.**
The totals row is not computable client-side from scratch:
`applyPendingToCoverage` applies deltas to a server baseline from
`GET /leave-planning/coverage`, which is capped at 62 days
(`MAX_COVERAGE_RANGE_DAYS`). So the export handler must fetch coverage
month by month — 12 calls, the visible month already cached. This
introduces `queryClient.fetchQuery`, a pattern the frontend does not
currently use anywhere; isolate it in one helper
(`fetchYearCoverage` in `api/leavePlanning.ts`) so the exporter stays pure
and unit-testable.

Rejected: widening `MAX_COVERAGE_RANGE_DAYS` to 366. The cap exists to
stop the endpoint being used as an unbounded scan of the leave table;
12 cheap, cached calls are not worth relaxing a limit shaped by that
concern.

**Pending edits are never exported.** The workbook is built from saved
server rows only. The page already warns "Unsaved changes on this page are
not counted yet" next to the entitlement balance; the export button gets
the same treatment when `unsavedCount > 0`. The Summary sheet also carries
an "Exported {date/time} — saved data only" line, so a file that outlives
the session cannot be mistaken for the screen it came from. A workbook
that silently disagrees with the database is the failure mode worth
spending two lines to avoid.

**Every other input the page already has unfiltered.** `useLeave(null,
null)`, `useExtraSessions(null, null)`, `useBlockedEntries()`,
`useClosures(null)` and `useSchools()` are all whole-table reads, so they
cover the year with no extra work. `useLeaveEntitlements(year)` is one
call. Bank holidays are only a warning banner on the page and are not
export input. Doctor rows are recomputed per month via `overlapsRange`, so
a leaver correctly disappears from later sheets.

## Rough task shape

1. **Shared layout primitives.** `exportRota.ts` keeps its border/
   alignment/column-width constants module-private. Extract the reusable
   ones (thin/thick sides, the AM/PM block border scheme, centred
   alignments) to a shared module so the leave exporter does not
   copy-paste them; `exportRota.test.ts` (540 lines) covers the refactor.
   Add the leave colour hexes to `exportStyles.ts`.
2. **`exportLeavePlanning.ts`** — the pure builder: summary sheet, then a
   month-sheet function looped over 1–12. Unit tested directly in Vitest
   like `exportRota.test.ts`.
3. **`fetchYearCoverage`** in `api/leavePlanning.ts`, plus the export
   handler, button and unsaved-changes warning in `LeavePlanningPage`.
4. **Architecture documentation** — record the export in
   `architecture-clinical.md` alongside the rota exporters, note the new
   manual-sync surface in `exportStyles.ts`, then delete this plan file.

## Open questions for the review chat

- Trainee block: always included (above) vs mirror the on-screen toggle.
- Does the Summary sheet want the `sessions_mismatch` /
  `exempt_by_reason` detail that `LeaveEntitlementSummary` shows, or just
  the headline figures?
- Should months with no leave at all still get a sheet? (Assume yes —
  a 12-sheet workbook with predictable tab names beats a variable one.)
