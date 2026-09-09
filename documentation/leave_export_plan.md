# Annual Leave Planner — Excel export (implementation plan)

Status: reviewed and expanded from the provisional plan. Ready to break
into per-task chats. Verified against the code on `main` at the time of
writing; every claim below that was in the provisional plan and turned
out to be wrong is corrected here and flagged **[corrected]**.

## Scope

An "Export to Excel" button on the Annual Planner (`LeavePlanningPage`)
producing one workbook per **leave year** — which is the calendar year,
1 Jan to 31 Dec (`backend/app/leave_entitlement.py`), so the 12 month
sheets below cover the leave year exactly with no April boundary to
handle:

- **Sheet 1 — Summary**: one row per doctor that appears on any month
  sheet, with entitlement, carry-over, adjustment, booked, used
  (chargeable) and remaining sessions, plus two data-integrity flags.
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
each sheet looks like the screen it mirrors. Padded columns are kept and
shaded, as on screen (`isInMonth` decides), rather than trimmed: dropping
them would break the Weekly cover row's 5-day chunking.

**`planningMonth.ts` is *mostly* the content authority — but not
entirely. [corrected]** The provisional plan claimed every piece of grid
logic already lives in the pure lib module and that no `exportContent.ts`
analogue is needed. The first half is right for the cell layer
(`weekdaysInMonth`, `isInMonth`, `toCellState`, `serverRows`,
`serverNotes`, `isSurgerySession`, `isWithinWindow`, `overlapsRange`,
`schoolHolidayDatesInRange`, `buildTemplateIndex`) and that is still the
reason this export is much cheaper than the rota one was. The second half
is wrong: the **footer** logic is component-local and unexported in
`LeavePlanningGrid.tsx` — `chunkIntoWeeks` (line ~171) and `weeklyTotal`
(line ~185). The exporter needs both to reproduce the Weekly cover row.
Task 1 moves them into `planningMonth.ts` so grid and exporter share one
implementation; it does not create a new content module.

**The exporter does not use `applyPendingToCoverage`. [corrected]** The
provisional plan said the totals row needs it. It does not: pending edits
are excluded from the export (below), so the export's totals row *is* the
server's baseline — `CoverageSlot[]` straight from
`GET /leave-planning/coverage`, `is_closed` rendered as "—" and
`headcount` otherwise, exactly what `applyPendingToCoverage` produces
when `pending` is empty. This removes the whole delta layer, the master
template, and the leave/extra/blocked key sets from the totals path.
(The template is still needed for cell *shading*, via `isSurgerySession`.)

**Coverage still needs 12 fetches, over the *padded* ranges. [corrected]**
`GET /leave-planning/coverage` is capped at 62 days
(`MAX_COVERAGE_RANGE_DAYS`, `backend/app/api/schemas/leave_planning.py`),
so a year cannot be fetched in one call. Fetch month by month, and use
`weekdaysInMonth(year, m)[0]` / `.at(-1)` as the bounds — **not** the
first and last of the calendar month. Two reasons: the padded lead-in and
lead-out columns need totals like any other column, and the page's own
`useCoverage(fromDate, toDate)` is keyed on exactly those padded strings,
so only an identical range hits the cache for the month already on
screen. Consequence worth knowing: adjacent months' ranges overlap by up
to four days, and January's range can start in the previous December
while December's can end in the next January. That is correct — those
cells are on the sheet.

Rejected: widening `MAX_COVERAGE_RANGE_DAYS` to 366. The cap exists to
stop the endpoint being used as an unbounded scan of the leave table.
Also rejected: batching into six ~62-day calls. It halves the request
count but matches no existing cache key and reintroduces a range-fits
calculation the padded months make fiddly.

**Colour is the one unavoidable duplication, and part of it has no
Tailwind hex to copy. [corrected]** `LeavePlanningGrid.tsx` holds cell
states as Tailwind classes (`CELL_CLASSES`, `NO_SURGERY_NORMAL_CLASS`,
the closed hatch, the school-holiday `bg-indigo-200`, `coverageClass`).
The provisional plan treated this as a straight class-to-hex transcription
like `exportStyles.ts` already does for `RotaGrid`. It is not, because
several of these classes are **themeable tokens with alpha**
(`bg-surface`, `bg-ink/5`, `bg-ink/[0.03]`, `text-ink/30`, `text-ink/40`,
`text-ink/70`) rather than fixed palette values. There is no
theme-independent hex for them. Per `architecture.md`'s "Exports never
follow the theme" rule, they are pinned to the **default** palette's
resolved values as literals, with a comment saying so — the same
decoupling `FONT_HEX.black` already documents. Add one leave block to
`exportStyles.ts` with the same "KEPT IN SYNC MANUALLY" warning that file
already carries; do not invent a second styles module and do not read
CSS variables at export time.

**Cell text must not rely on colour alone.** On screen a cell shows
`notes || period`, and the period is redundant in Excel (AM/PM is its own
column, as on the rota sheet). So: cell text is the note when there is
one, otherwise a one-letter state code — `L` leave, `E` extra session,
`B` blocked, blank for normal. Colour still carries the state, but a
printed or colour-blind reading of the sheet survives. Closed slots get
the closed fill and no text (matching the room sheet's closed-cell rule);
out-of-window cells get the "not employed" grey and no text. The closed
fill is flat `CLOSED_COLUMN_HEX`, not an exceljs pattern fill imitating
`.closed-hatch` — the rota export already set that precedent.

**Trainees are always included in the export** (user-confirmed), in a
block below the counted doctors, regardless of the page's "Show trainees"
toggle. The toggle is a screen-decluttering aid; a file is a record. The
Clinical cover rows still exclude them, exactly as `coverageDoctors`
does, so the block is preceded by a divider row reading
"Trainees — not counted in clinical cover" or the totals will read as
wrong.

**Locums get a Summary row with dashes** (user-confirmed). The month
sheets show Partner / Salaried / Locum (+ Trainee); the entitlement
endpoint returns only doctors with a tracked entitlement, and **AHPs and
locums have none** (`backend/app/leave_entitlement.py`). Left alone, the
Summary sheet would silently have fewer rows than the month sheets. So
the Summary is built from the *union of doctors appearing on any month
sheet*, and a doctor with no entitlement row gets "—" in the entitlement
columns rather than being dropped. Row order is
`compareDoctorDisplayOrder`, same as the grid.

**The Summary carries the two integrity flags, not just the headline
figures** (user-confirmed). Columns: doctor code, type, entitlement,
carry-over, adjustment, booked, used (chargeable), remaining, plus
`sessions_mismatch` and `exempt_by_reason.no_template_row`. Those two are
the reason a "used" figure can be quietly wrong, and the page warns about
them on screen; a workbook that outlives the session must not drop the
warning. The rest of `exempt_by_reason` (closed/weekend/no_surgery) and
the rule/override chain stay off the sheet. Numeric columns are written
as **numbers with a number format**, not through
`LeaveEntitlementSummary`'s local `formatSessions` — that helper is a
display formatter and would make every figure a text cell.

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
call. Bank holidays are only a warning banner on the page
(`bankHolidaysMissing`) and are not export input. Doctor rows are
recomputed per month via `overlapsRange`, so a leaver correctly
disappears from later sheets.

## Task 1: Shared layout primitives and colours

**A. State of the world.** Nothing is built yet. This task creates the
shared foundation the exporter sits on and changes no user-visible
behaviour; it is a refactor plus new constants.

**B. Files and deliverables.**

- `frontend/src/lib/exportLayout.ts` (new) — the layout primitives
  currently module-private at the top of `exportRota.ts`: `CENTERED`,
  `CENTERED_WRAPPED`, `THIN_SIDE`, `THICK_SIDE`, `AM_ROW_BORDER` and its
  PM counterpart. Keep the `as const` on the border sides — it is what
  makes the literals assignable to exceljs's `Border` shape.
- `frontend/src/lib/exportRota.ts` — import those instead of declaring
  them. Genuinely rota-specific constants (`DOCTOR_COL`, `SESSION_COL`,
  `DAY_COL_WIDTH`, `STAFF_NAME_FONT_SIZE`, …) stay put; do not drag the
  whole constant block across.
- `frontend/src/lib/exportRota.test.ts` (540 lines) — must pass
  unchanged. It is the proof the refactor is behaviour-neutral; if it
  needs an edit, the refactor went too far.
- `frontend/src/lib/exportStyles.ts` — add the leave block, below the
  existing rota block, under its own "KEPT IN SYNC MANUALLY with
  LeavePlanningGrid.tsx" header:
  - cell states from `CELL_CLASSES`: leave `bg-green-500`, extra session
    `bg-yellow-300`, blocked `bg-slate-500`, normal (no fill);
  - `NO_SURGERY_NORMAL_CLASS`'s `bg-gray-300`;
  - school holiday `bg-indigo-200`;
  - `coverageClass`'s three thresholds: `bg-red-200` (≤2),
    `bg-orange-200` (3), `bg-yellow-200` (4), no fill above;
  - out-of-window `bg-ink/5` and out-of-month `bg-ink/[0.03]` — these two
    plus the greyed font weights are the themeable ones. Resolve them
    against the **default** palette in `index.css` and pin the result,
    with a comment stating that they do not track `--color-ink` (mirror
    the wording already on `FONT_HEX.black`).
  - Reuse `CLOSED_COLUMN_HEX` for closed slots; reuse `argb()`.
- `frontend/src/lib/exportStyles.test.ts` — extend for the new constants.
- `frontend/src/lib/planningMonth.ts` — move `chunkIntoWeeks` and
  `weeklyTotal` here from `LeavePlanningGrid.tsx` and export them, with
  their existing docstrings. They are pure and depend only on
  `PLANNING_PERIODS` / `closedSlotKey`, both already in scope there.
- `frontend/src/components/LeavePlanningGrid.tsx` — import the two moved
  functions; delete the local copies. No other change.
- `frontend/src/lib/planningMonth.test.ts` — add direct unit tests for
  the two moved functions (they were only covered through the grid
  before).

**C. Instructions.** Do the move and the extraction mechanically, run
`npm run test -- src/lib/exportRota.test.ts src/lib/exportStyles.test.ts
src/lib/planningMonth.test.ts src/components/LeavePlanningGrid.test.tsx`,
and stop. Adding anything leave-export-specific here belongs in Task 2.

## Task 2: `exportLeavePlanning.ts`, the pure builder

**A. State of the world.** Task 1 is complete: shared border/alignment
primitives live in `exportLayout.ts`, the leave colour hexes are in
`exportStyles.ts`, and `chunkIntoWeeks` / `weeklyTotal` are exported from
`planningMonth.ts`. This task is the workbook builder, with no page
wiring — it takes plain data and returns a `Blob`.

**B. Files and deliverables.**

- `frontend/src/lib/exportLeavePlanning.ts` (new) — one exported
  `buildLeavePlanningWorkbook(input): Promise<Blob>`. Model the file on
  `exportRota.ts`: a header docstring explaining what it mirrors, a
  dynamic `import("exceljs")`, no React and no DOM.
- `frontend/src/lib/exportLeavePlanning.test.ts` (new) — Vitest,
  following `exportRota.test.ts`'s pattern of reading the produced
  workbook back through exceljs and asserting on cells.

**Input shape** (all plain data, all already on the page):

```
year: number
doctors: Doctor[]            // active, Partner/Salaried/Locum/Trainee
entitlements: LeaveEntitlement[]
leave / extraSessions / blocked: entries, whole-table
closures: Closure[]
schools: School[]
templateSessions: MasterRotaSession[]
coverageByMonth: Map<number, CoverageSlot[]>   // month 1-12
exportedAt: Date
```

**C. Instructions.**

Summary sheet:
1. Build the doctor union: for each month 1–12, `weekdaysInMonth` then
   `doctors.filter(d => overlapsRange(d, from, to))`; union, sorted by
   `compareDoctorDisplayOrder`. This is the Summary's row set and it is
   what keeps Summary and month sheets consistent.
2. One row per doctor; join `entitlements` on `doctor_id`; "—" where
   there is no row (locums). Numeric cells are numbers with a number
   format, not pre-formatted strings.
3. Header block: "Annual leave plan {year}", then "Exported
   {exportedAt} — saved data only".

Month sheets, one function called 12 times:
1. `dates = weekdaysInMonth(year, month)`; columns are those dates.
   Header shows weekday + day-of-month, as `columnLabel` does on screen.
   Shade out-of-month columns (`isInMonth`).
2. School-holiday rows first, one per school with any holiday in range
   (`schoolHolidayDatesInRange`, skip schools with an empty map — same
   filter as the page).
3. Doctor blocks: counted doctors first, then a divider row
   "Trainees — not counted in clinical cover", then trainees. Two rows
   per doctor (AM/PM), boxed with the Task 1 border scheme.
4. Cell resolution order, matching `PlanningCellHalf` exactly: closed
   (`isSlotClosed`) → out of window (`isWithinWindow`) → state from
   `toCellState(serverRows(...))` with notes from `serverNotes`. Text is
   the note, else `L`/`E`/`B`/blank. Fill is the state colour, except
   that a `normal` cell on a non-surgery slot (`isSurgerySession` false)
   takes the no-surgery grey.
5. Footer: a Clinical cover row (AM and PM values per date, from
   `coverageByMonth.get(month)`, `is_closed` → "—", thresholds shaded via
   the `coverageClass` hexes) and a Weekly cover row using
   `chunkIntoWeeks` + `weeklyTotal`, each week's value in a cell merged
   across its five columns.
6. Sheet names: month names, "January" … "December". Summary first.

Tests to write: the doctor union includes a mid-year leaver on early
sheets and not late ones; a locum has a Summary row with dashes; the
trainee divider is present and trainees sit below it; a closed slot is
blank with the closed fill; a no-surgery normal cell differs from a
surgery normal cell; a note wins over the state letter; the Weekly cover
merge spans five columns and matches the sum of its dailies; twelve month
sheets exist even for a month with no leave at all (predictable tab names
beat a variable workbook).

## Task 3: `fetchYearCoverage` and the page wiring

**A. State of the world.** Tasks 1–2 are complete: the builder exists and
is unit tested, but nothing calls it. This task fetches the year's
coverage and puts the button on the page.

**B. Files and deliverables.**

- `frontend/src/api/leavePlanning.ts` — add `fetchYearCoverage(
  queryClient, year): Promise<Map<number, CoverageSlot[]>>`. Twelve
  `queryClient.fetchQuery` calls, each with **exactly** the key and
  `queryFn` `useCoverage` uses, over the `weekdaysInMonth(year, m)`
  padded bounds, so the visible month is served from cache. This is the
  frontend's first use of `fetchQuery`; keep it to this one helper and
  document why in a docstring. Set a `staleTime` so the twelve results
  are not immediately refetched by the mounted `useCoverage`.
- `frontend/src/api/leavePlanning.test.tsx` — cover the key-identity
  claim (a pre-seeded cache entry for the visible month is not refetched)
  and that all twelve months come back.
- `frontend/src/routes/LeavePlanningPage.tsx` — "Export to Excel" button
  beside the existing controls, not gated on write access. Handler:
  `fetchYearCoverage` → `buildLeavePlanningWorkbook` → `downloadBlob(
  blob, \`leave-plan-${year}.xlsx\`)`. Disable while in flight, surface a
  failure through the page's existing error line rather than a throw, and
  render the "unsaved changes are not included" warning next to the
  button when `unsavedCount > 0`. Pass **all** doctors (trainees
  included) regardless of `showTrainees`.
- `frontend/src/routes/LeavePlanningPage.test.tsx` — mock
  `@/lib/downloadBlob` (see `EoiPage.test.tsx` for the pattern) and
  assert the button renders, the handler runs, `downloadBlob` is called
  once with the right filename, the warning appears only with unsaved
  edits, and the trainee rows are passed through with the toggle off.

**C. Instructions.** The builder stays pure — no `queryClient` inside it,
no fetching. Do not change `useCoverage`; if the cache-hit test fails,
the bug is in the key construction in `fetchYearCoverage`, not in the
hook.

## Task 4: Review and documentation

**A. State of the world.** Tasks 1–3 are complete and the export is live.
This step is review and documentation only.

**B/C. Instructions.**

- `documentation/architecture-clinical.md` — add the leave export
  alongside the rota exporters in the frontend module table
  (`exportLeavePlanning.ts`, `exportLayout.ts`), and a short section
  recording: sheet-per-month, saved-data-only, trainees and locums always
  present, and the twelve-fetch coverage path with the 62-day cap as its
  reason.
- Note in that section that `exportStyles.ts` now carries a **second**
  manual-sync surface (`LeavePlanningGrid.tsx`), and that part of it is
  pinned default-palette values with no Tailwind class to check against —
  the one bit of the file a reader cannot verify by eye.
- `documentation/architecture.md` — nothing to add; the theming section's
  "Exports never follow the theme" rule already covers the new hexes.
- Delete this plan file.
