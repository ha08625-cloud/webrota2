# Implementation Plan — Leave block consolidation (Assign Leave screen)

## Plan

`LeavePage`'s table renders one row per `LeaveEntry` — half-day granularity, so
a two-week absence is ~20 near-identical rows, and the unfiltered view
interleaves doctors by date. Collapse consecutive entries for one doctor into a
single block row spanning the absence, delete a whole block in one call, and
group the unfiltered view by doctor. Frontend only; no API, schema or engine
change.

## Scope

**In scope**

- New pure helper `collapseLeaveEntries.ts` + tests — the inverse of
  `expandLeaveRange.ts`.
- `LeavePage.tsx` table: block rows, half-day annotations, per-block delete via
  `POST /leave/bulk-delete`, doctor-grouped ordering in the unfiltered view.
- `LeavePage.test.tsx` updates for the two tests that assert the old flat rows.
- Rename `expandLeaveRange_test.ts` → `expandLeaveRange.test.ts` (see Decision 7).
- Architecture doc refresh.

**Out of scope**

- No backend change. `/leave/bulk-delete` already does exactly what a block
  delete needs (`routers/leave.py:241-271`).
- No change to the range form above the table, its preview, or its confirm
  wording. `describeRangeForConfirm` is refactored to share a helper with the
  new block confirm, but its output stays byte-identical.
- No new "edit block" affordance. Shortening or splitting a block is done with
  the existing Remove-leave form.
- No pagination or date-window filter on the table. Consolidation is expected to
  cut the row count enough on its own; revisit if it doesn't.

## Design Decisions

**1. Grouping unit: one doctor's consecutive weekday entries.** A block is a
maximal run of consecutive weekdays, each carrying at least one entry for that
doctor. AM+PM on the same date is one full day.

**2. Weekend gaps do not break a run, but weekend *entries* do.** Bulk add is
weekday-only (`routers/leave.py:160-167`), so Fri→Mon with nothing on Sat/Sun is
one continuous absence and must render as one row. Weekday-only is an API rule,
not a schema one — stray weekend rows are representable (architecture.md, line
93 — "Generation inputs"). Such a row therefore *ends* the run and becomes its
own single-day block. This is not fussiness: it is what makes Decision 4's
range-delete exact, because it guarantees no block's span contains an entry that
isn't part of that block.

**3. Merge across a period change only at the run's edges.** A leading
single-day `PM` and a trailing single-day `AM` are absorbed into the adjacent
full-day part and rendered as one row with `(PM only)` / `(AM only)` annotations
on the respective end dates — exactly the shape `expandLeaveRange` emits, so
collapse is its true inverse and the round-trip is testable. Anything else — an
interior half day, a multi-day half-day run — starts a new block. Interior half
days are anomalous data (they can't be produced by the form); showing them as a
separate row surfaces them rather than hiding them behind an annotation with
nowhere sensible to go.

**4. Block delete is one `bulk-delete` call using the block's own `period`.**
Not one call per absorbed sub-segment: `_expand_periods` turns `BOTH` into
`period IN (AM, PM)` and deletes every matching row in the range
(`routers/leave.py:261-271`), so a single `BOTH` call over the span removes the
half-day edges too. Combined with Decisions 1 and 2 this is exact — every
weekday in the span has an entry, and no weekend entry can be inside the span —
so the call deletes the block's entries and nothing else. This exactness is
asserted as a property in the helper's tests, because it is what makes a
range-based delete safe to attach to a row the user is looking at.

**5. Per-entry delete leaves the table.** Every row is now a block, deleted by
range. Removing a single session (say just Wednesday PM) is still possible
through the Remove-leave form above the table — single day, `AM only`/`PM only`.
`useDeleteLeave` keeps its export and tests but loses its only caller, matching
the existing precedent of `useCreateLeave` (already unused by any component
since the three-form page was replaced).

**6. Unfiltered view sorts by doctor display order, then date, in a flat
table.** Ordering comes from `compareDoctorDisplayOrder` (`lib/groupDoctors.ts`)
— the same convention as both selects on the page and every grid — not the API's
`ORDER BY date, doctor_id`, whose `doctor_id` is creation order. Kept as a
repeated Doctor column rather than `colspan` subheading rows: one row shape,
nothing to do for screen readers, and the filter select is already the "one
doctor at a time" affordance.

**7. `expandLeaveRange_test.ts` has never run.** `vite.config.ts` sets no
`test.include`, so vitest's default `**/*.{test,spec}.?(c|m)[jt]s?(x)` applies
and an underscore filename doesn't match it. It is the only `_test.ts` file in
the frontend. Renaming it is in scope here because Task 1 would otherwise copy
the convention into a new file and silently not run either.

## Task 1: `collapseLeaveEntries` helper

**A. State of the world.** Nothing has been done yet — this is the first task.
`lib/expandLeaveRange.ts` turns a range + edge options into 1–3 disjoint
`LeaveSegment`s; nothing goes the other way. `LeavePage.tsx` renders
`entries.map(...)` directly.

**B. Files and deliverables.**

| File | Deliverable |
| --- | --- |
| `frontend/src/lib/collapseLeaveEntries.ts` | New: `LeaveBlock` type + `collapseLeaveEntries` |
| `frontend/src/lib/collapseLeaveEntries.test.ts` | New: unit + property tests |
| `frontend/src/lib/expandLeaveRange_test.ts` | Renamed to `expandLeaveRange.test.ts`; must pass |

**C. Instructions.**

1. **Rename first.** `git mv frontend/src/lib/expandLeaveRange_test.ts
   frontend/src/lib/expandLeaveRange.test.ts` and run `npm run test` in
   `frontend/`. These 142 lines have never executed in CI, so treat a failure as
   a real finding: fix it (or, if `expandLeaveRange` is right and the test is
   wrong, fix the test) and say so in the commit message. Do not fold that fix
   into the new feature silently.

2. **The type.** In `collapseLeaveEntries.ts`:

   ```ts
   export interface LeaveBlock {
     doctor_id: number;
     start_date: string;
     end_date: string;
     /** BOTH for a full-day block (including one with half-day edges); AM or PM for a uniform half-day block. */
     period: PeriodOrBoth;
     /** start_date is a PM-only half day. Only ever true when period is BOTH. */
     half_start: boolean;
     /** end_date is an AM-only half day. Only ever true when period is BOTH. */
     half_end: boolean;
   }
   ```

   `PeriodOrBoth` comes from `@/api/types`. Document the invariants in the
   module docstring, in the register `expandLeaveRange.ts` uses: `start_date <=
   end_date`; half flags imply `period === "BOTH"`; and the delete-exactness
   invariant from Decision 4, with the weekend reasoning, since that is the
   non-obvious one a future reader will want justified.

3. **Local date helpers.** `parseLocalDate` and `addDays` come from `./date`.
   Add two module-private helpers — `isWeekday(d)` (`getDay()` between 1 and 5)
   and `nextWeekday(d)` (`addDays` forward until a weekday). Do not promote
   these to `date.ts`; `ExtraSessionsPage.tsx:25` already keeps its own local
   `isWeekend` and there is no third caller to justify a shared one yet.

4. **`collapseLeaveEntries(entries: LeaveEntry[]): LeaveBlock[]`**, in five
   steps:

   a. Group by `doctor_id`.

   b. Per doctor, merge same-date entries into day records
      `{ date, period: "AM" | "PM" | "BOTH" }` and sort ascending by `date`.
      Sort defensively rather than trusting the API's order; `"YYYY-MM-DD"`
      compares chronologically, so `localeCompare` is enough. `uq_leave_slot`
      makes duplicate `(date, period)` rows impossible, but build via a Set so a
      duplicate can't produce a bogus record either way.

   c. Split the day records into **date runs**: start a new run whenever
      `!isWeekday(prev.date) || !isWeekday(cur.date) || nextWeekday(prev.date) !== cur.date`.
      One rule covers everything in Decision 2 — Fri→Mon chains, Fri→Sat does
      not, Sat→Mon does not.

   d. Run-length-encode each date run into maximal uniform-period sub-runs
      `{ start_date, end_date, period }`. Adjacent sub-runs therefore always
      differ in period.

   e. Fold sub-runs into blocks:

   ```ts
   const isSingle = (r) => r.start_date === r.end_date;

   while (i < runs.length) {
     const run = runs[i];

     // Leading PM half day
     if (run.period === "PM" && isSingle(run) && i + 1 < runs.length) {
       const next = runs[i + 1];
       if (next.period === "BOTH") {
         // ...start a BOTH block spanning run..next, half_start: true; i += 2;
         // then try to absorb a trailing single-day AM run; push; continue;
       }
       if (next.period === "AM" && isSingle(next)) {
         // "off Wed lunchtime, back Thu lunchtime": one BOTH block,
         // half_start and half_end both true, no interior. i += 2; continue;
       }
     }

     // Full-day run, optionally closed by a trailing single-day AM half day
     if (run.period === "BOTH") { /* ... i += 1; absorb trailing AM; continue; */ }

     // Anything else stands alone: uniform AM or PM block, no half flags
   }
   ```

   The trailing-AM absorb is shared by both `BOTH` paths — factor it out rather
   than writing it twice. Note the second branch above: `[PM single][AM single]`
   with no full-day interior between them is a legitimate single absence that
   `expandLeaveRange` explicitly supports (its docstring, lines 36-38), so it
   must collapse to one row even though there is no `BOTH` run to absorb into.

   f. Concatenate the per-doctor lists, doctors in ascending `doctor_id`.
      Display ordering is the caller's job (Task 2, Decision 6) — this file must
      not import `Doctor` or `groupDoctors`.

5. **Tests** (`collapseLeaveEntries.test.ts`, vitest, style per the renamed
   `expandLeaveRange.test.ts`). Cases:

   - empty input → `[]`;
   - one full day (AM+PM on one date) → one single-date `BOTH` block, no halves;
   - one AM-only day → one block, `period: "AM"`, no halves;
   - Mon–Fri full → one block;
   - Thu–Tue full across a weekend → one block, `start_date` Thu, `end_date` Tue;
   - Mon–Fri full with Wednesday absent → two blocks;
   - Mon PM + Tue–Thu full + Fri AM → one block Mon–Fri, both half flags;
   - Wed PM + Thu AM, nothing else → one block Wed–Thu, `BOTH`, both half flags;
   - interior half day (Mon–Tue full, Wed AM, Thu–Fri full) → **two** blocks:
     Mon–Wed with `half_end`, then Thu–Fri;
   - multi-day half-day run (Mon AM, Tue AM, Wed full) → two blocks: Mon–Tue
     `AM`, then Wed `BOTH` — a multi-day half-day run is never absorbed;
   - a Saturday entry between a Friday and a Monday entry → three blocks;
   - a weekend day with AM+PM alone → one single-date `BOTH` block;
   - two doctors with interleaved dates → blocks grouped per doctor, ascending
     `doctor_id`, chronological within a doctor;
   - input shuffled out of date order → identical result.

   Two properties, both worth asserting directly rather than by example:

   - **Round trip.** For each of the four `(firstDay, lastDay)` combinations
     over a multi-week range with weekday start and end dates: run
     `expandLeaveRange`, expand the segments to individual entries *filtered to
     weekdays* (that filter is what the server does — `routers/leave.py:160`),
     collapse them, and assert exactly one block with the matching span and half
     flags. Weekday endpoints are required: a range starting on a Saturday
     creates no entry for that Saturday, so no inverse exists.
   - **Delete exactness (Decision 4).** Over a mixed fixture, for every block
     produced: the set of input entries for that doctor with
     `start_date <= date <= end_date` and period in the block's expanded periods
     is exactly the set of entries the block was built from. This is the
     invariant the range delete relies on — if it ever fails, a Delete click
     removes rows the user could not see.

---

## Task 2: `LeavePage` block rendering and block delete

**A. State of the world.** Task 1 is complete: `collapseLeaveEntries(entries)`
returns `LeaveBlock[]`, grouped per doctor and chronological within a doctor,
and its delete-exactness property is under test. `LeavePage.tsx` still renders
`entries.map(...)` (lines 468-493) with a per-entry `handleDeleteRow` (lines
264-266) calling `useDeleteLeave`.

**B. Files and deliverables.**

| File | Deliverable |
| --- | --- |
| `frontend/src/routes/LeavePage.tsx` | Block table, block delete, `describeSpan` refactor |
| `frontend/src/routes/LeavePage.test.tsx` | Replace the two flat-row tests; add block-delete and ordering coverage |

**C. Instructions.**

1. **Share the span wording.** Add a module-level pure function beside
   `segmentLabel`:

   ```ts
   function describeSpan(span: {
     start_date: string; end_date: string; period: PeriodOrBoth;
     half_start: boolean; half_end: boolean;
   }): string
   ```

   - single date → `on 2026-08-03`, plus ` (AM only)` / ` (PM only)` when the
     period is `AM` / `PM`;
   - multi-day `BOTH` → `from 2026-07-13 (PM only) to 2026-07-17 (AM only)`,
     each suffix present only when the corresponding half flag is set;
   - multi-day `AM` / `PM` → `from X to Y (AM only)` — unreachable from the form,
     reachable from a block.

   Rewrite `describeRangeForConfirm` (lines 135-144) to build that shape from
   form state and delegate. Bare dates, no weekday names — the output must stay
   **byte-identical**; the existing remove-mode test asserts the exact confirm
   string, so leave that assertion untouched and treat it as the check that the
   refactor was clean.

2. **Ordering.** Sort the collapsed blocks for display:

   ```ts
   const blocks = collapseLeaveEntries(entries ?? []).sort((a, b) => { ... });
   ```

   Compare with `compareDoctorDisplayOrder` on `{ type: doctor_type, code }`
   looked up in the existing `doctorsById`, falling back to `doctor_id` order
   when either doctor is missing from the map (it shouldn't be — the filter
   query loads inactive doctors too — but the table must not depend on that);
   tie-break on `start_date`. Plain computation in the component body, no
   `useMemo` — the file computes `doctorsById` and both doctor groups the same
   way.

3. **Table.** Keep the four columns. Per block:

   - **Date** — single-day blocks keep today's `formatDateWithDay(start_date)`;
     multi-day blocks render
     `` `${formatDateWithDay(start)}${half_start ? " (PM only)" : ""} to ${formatDateWithDay(end)}${half_end ? " (AM only)" : ""}` ``.
     Note the table shows weekday names where the confirm dialog does not —
     that asymmetry already exists and is deliberate.
   - **Doctor** — unchanged lookup, now repeated down each doctor's blocks.
   - **Period** — `"Full day"` for `BOTH`, otherwise the raw `AM` / `PM`.
   - **Delete** — unchanged styling, new handler.

   Key on `` `${doctor_id}-${start_date}-${end_date}-${period}` ``; two blocks
   for one doctor can never share a start date.

4. **Delete.** Replace `handleDeleteRow` with:

   ```ts
   async function handleDeleteBlock(block: LeaveBlock) { ... }
   ```

   Confirm with
   `` `Remove all leave for ${doctorCode} ${describeSpan(block)}? This cannot be undone from here.` ``
   — the same sentence the form uses, via the same helper. On confirm, **one**
   `bulkDeleteLeave.mutateAsync({ doctor_id, start_date, end_date, period })`
   using the block's own `period` (Decision 4). No `Promise.allSettled`, no
   per-segment reporting: there is one call, so a rejection is just an error.

   Report failures in a new `tableError` state rendered immediately above the
   table, not in `formError` — the form's message slot carries add/remove
   summaries and shouldn't mix a table failure into them. Clear `tableError` at
   the start of each delete.

   Remove the `useDeleteLeave` import and the `deleteLeave` binding; leave
   `api/leave.ts` untouched (Decision 5).

5. **Tests.** Two existing tests assert the behaviour being removed and must be
   rewritten:

   - `"renders a row per leave entry"` (line 62) → a Mon–Fri full-day fixture
     (10 entries) renders exactly one row, with the combined date text; add a
     second case for a `PM`-edged block asserting the `(PM only)` annotation.
   - `"delete removes an entry from the table"` (line 509) → stub
     `window.confirm` true, register an msw `POST /api/v1/leave/bulk-delete`
     handler capturing the body, click Delete, and assert a single request with
     `{ doctor_id, start_date, end_date, period: "BOTH" }` spanning the block,
     plus the table emptying once the refetch returns `[]`. Follow the capture
     pattern already at line 430.

   Add: a declined confirm fires no request; and an unfiltered fixture with two
   doctors whose entries interleave by date renders each doctor's blocks
   together, in `compareDoctorDisplayOrder` order (e.g. a Partner `ZZ` before a
   Salaried `AA`, so the assertion can't accidentally pass on alphabetical or
   `doctor_id` order).

---

## Task 3: Architecture documentation

**A. State of the world.** Tasks 1 and 2 are complete. `architecture.md` still
describes the leave table as it was.

**B. Files and deliverables.**

| File | Deliverable |
| --- | --- |
| `documentation/architecture.md` | LeavePage and pure-helper entries updated |

**C. Instructions.**

1. **Line 277 (LeavePage)** — "plus the filterable table with per-row delete" is
   now wrong twice over. Replace with the block table: consolidated rows via
   `collapseLeaveEntries`, half-day edge annotations, per-block delete as a
   single `bulk-delete` over the block's span, doctor-display-order grouping in
   the unfiltered view. Keep it to the design decisions, not the mechanics — the
   component is readable.

2. **Line 285 (`expandLeaveRange.ts`)** — add `collapseLeaveEntries.ts` as its
   documented inverse in the same paragraph, since the two only make sense
   together. Record the two things not derivable from a quick read: that a
   weekend *entry* breaks a run while a weekend *gap* does not, and why
   (delete-exactness, Decision 4); and that merging across a period change
   happens only at a run's edges, so an interior half day yields a second row.

3. Nothing under "Backend" or "Data model" changes — this feature added no
   endpoint and no column.
