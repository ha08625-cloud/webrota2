# Implementation Plan — School Holidays

## Plan

Replace the `SchoolHolidaysPage` stub with a real feature: record schools and
their holiday date ranges as global planning data, list them on the School
Holidays tab, and shade them as informational rows on the Annual Planner.

Purely informational. Nothing in the generation engine, the coverage
endpoint, or any rota snapshot reads this data — it exists so whoever is
approving leave can see at a glance that a doctor's request lands in half
term. The system is not live, so no data migration is required.

## Scope

**In scope**

- New `School` and `SchoolHoliday` tables + Alembic migration `022`.
- `GET/POST/PATCH/DELETE` under `/api/v1/schools`, schools returned with
  their holidays nested.
- `SchoolHolidaysPage`: one row per school, holidays listed as formatted
  date ranges, add/edit/delete dialogs.
- `LeavePlanningGrid`: one extra informational row per school with a
  holiday overlapping the displayed month.
- Backend + frontend tests; `documentation/architecture-clinical.md` and
  `documentation/architecture.md` updated.

**Out of scope**

- No recurrence, term templates, or academic-year model. Terms differ
  between private, state and university calendars; every range is typed in
  by hand. (Confirmed.)
- No engine coupling of any kind. A school holiday never suppresses a slot,
  never changes a coverage total, never blocks a duty assignment, and is
  never snapshotted per-rota. This is the one hard line in the feature —
  `PracticeClosure` is the precedent for "global planning data", but
  closures are read by `context.load_context()` and school holidays must
  not be.
- No AM/PM granularity. Unlike closures and leave, a school holiday is
  whole days only.
- No leave-request warning ("this overlaps half term"). The planner
  shading is the whole of the v1 signal.

## Design Decisions

**1. `School` is its own table, not a free-text label on the holiday.**
The Annual Planner needs one stable row per school, and the page groups by
school. A string label would fragment those rows on every typo or rename.
`name` is unique (409 on collision) so two identical planner rows are
impossible.

**2. No `active` flag on `School`.** This departs from `Doctor`,
`ClinicType` and `ReceptionStaff`, which are all soft-deleted — but those
are soft-deleted because generated rotas hold FKs into them, so a hard
delete would orphan history. Nothing references `School`, and there is no
per-rota snapshot, so a hard delete cascading to that school's holidays is
clean and saves an `active` filter in three places. Delete is behind a
confirm that names the holiday count.

**3. Date ranges, not per-day rows.** A holiday is one contiguous block
(`start_date`, `end_date` inclusive), unlike `PracticeClosure`'s per-slot
rows. Closures are per-slot because the engine looks up
`(date, period)` membership; nothing looks these up, and a six-week summer
holiday as 42 rows would be pure noise in the UI. Overlap testing against
the planner's weekday columns is a client-side range comparison.

**4. Weekends are allowed, unlike closures.** `ClosureIn` rejects weekend
dates because a weekend is never in the grid. School holidays routinely
*start and end* on weekend-adjacent boundaries and span weekends
throughout, so no weekday validator. Validation is only:
`end_date >= start_date`, and a span cap of 366 days mirroring
`MAX_BULK_RANGE_DAYS` in the leave schemas (a typo'd year is the realistic
failure, not a genuine multi-year holiday).

**5. No uniqueness or overlap constraint on holidays.** Two overlapping or
identical ranges for one school are cosmetically odd but harmless — nothing
reads the data, so a duplicate cannot corrupt anything. Adding a 409 path
here buys a validation message and costs a constraint plus its test.

**6. Blank holiday name allowed.** `name: str | None`, same as
`PracticeClosure.name`. (Confirmed.)

**7. Holidays displayed as a list of formatted ranges, not chips.**
Per row, one line per holiday:

```
Monday 21/7/26 – Friday 31/8/26
Monday 12/12/26 – Friday 4/1/27
```

Format is full weekday name + `d/m/yy`, which no existing helper produces —
`formatDateWithDay` in `lib/date.ts` gives `"Mon, 2026-07-21"`. Add
`formatHolidayRange(start, end)` there rather than inlining it, since the
planner row tooltip uses the same string. Single-day holidays render as one
date, no dash. (Confirmed.)

**8. Past holidays hidden by default, with a "Show past" toggle.** Not in
the provisional plan, and needed *because* of Decision 7: manual entry over
several years turns an inline full list into an unbounded one. A holiday is
"past" when `end_date < today`. The toggle is per-page, not persisted.

**9. Planner rows self-manage by month.** A school gets a row iff at least
one of the displayed weekday columns falls inside one of its holidays. No
show/hide control. (Confirmed.)

**10. Unfiltered fetch, filtered client-side.** No `?start=&end=` query
param. `GET /schools` returns every school with every holiday nested, and
both the page and the planner filter locally — the same call
`useClosures()` makes for the same reason (a handful of rows per year).
One request also means the page never renders a school before its holidays
arrive.

**11. The grid stays dumb.** `LeavePlanningPage` computes
`schoolRows: { id, name, dates: Set<string> }[]` and passes it in, exactly
as it already precomputes `closedSlots` and `totals`.
`LeavePlanningGrid` renders what it is given and owns no fetching, matching
its existing docstring contract.

**12. School rows are full-cell, not AM/PM split, and not clickable.**
Doctor cells are two half-height buttons; a school cell is a single block
spanning the cell. Rendering them as inert AM/PM halves would imply a
half-day granularity that does not exist. New colour is a blue/indigo tint
— green (leave), yellow (extra), `gray-200` (closed) and `ink/5` (not
employed) are all taken — plus a legend entry.

**13. There is no reusable range picker to reuse.** The provisional plan
assumed `LeavePage`'s "Timetastic-style form" could be lifted. It cannot:
that form is two bare `<input type="date">` fields plus half-day edge
selects (`FirstDayOption`/`LastDayOption`) and a `LeaveRangePreview`
mini-calendar, all of it coupled to AM/PM expansion this feature does not
have. The holiday dialog is two date inputs and a text field — write it
directly, do not extract a shared component for it.

**14. The page renders no `<h1>`.** School Holidays is one of the five
`SESSION_MANAGEMENT_TABS`, rendered inside `SessionManagementLayout`; the
active tab is the heading. The stub already obeys this and the replacement
must too.

---

## Task 1: Data model and migration

**A.** Nothing has been built yet — this is the first task. Deliverable is
the two tables and the migration, with no API or UI.

**B. Files**

- `backend/app/models/school.py` (new)
- `backend/app/models/__init__.py` (re-export)
- `backend/alembic/versions/022_school_holidays.py` (new — `021_bank_holiday_key.py`
  is the current head; confirm with `alembic heads` before writing `down_revision`)

**C. Instructions**

`School`:

- `id` PK, `name: str` non-null with a unique constraint
  (`uq_school_name`).
- No `active` column (Design Decision 2).
- `holidays` relationship with `cascade="all, delete-orphan"`.

`SchoolHoliday`:

- `id` PK.
- `school_id` FK → `schools.id`, non-null, indexed, `ondelete="CASCADE"`.
- `start_date`, `end_date`: `Date`, non-null.
- `name: str | None`, nullable.
- No unique constraint (Design Decision 5).

Write a module docstring in the style of `closure.py`: state that this is
global planning data with **zero** engine coupling, and that it is
deliberately range-based rather than per-slot, so nobody later "fixes" it
into `PracticeClosure`'s shape.

Migration creates both tables with the unique constraint, index and FK
cascade; `downgrade()` drops them in FK order.

---

## Task 2: Schemas, router and backend tests

**A.** The data model and migration are done. This task adds the only write
path for the new tables.

**B. Files**

- `backend/app/api/schemas/school.py` (new)
- `backend/app/api/schemas/__init__.py` (re-export)
- `backend/app/api/routers/school_holidays.py` (new)
- `backend/app/api/main.py` (add to the router import tuple and the
  `include_router` loop)
- `backend/tests/test_api/test_school_holidays.py` (new — mirror
  `test_closures.py`'s fixtures and auth setup)

**C. Instructions**

Schemas:

- `SchoolHolidayIn`: `start_date`, `end_date`, `name: str | None = None`.
  A `model_validator(mode="after")` enforcing `end_date >= start_date` and
  `(end_date - start_date).days <= 366` (Design Decision 4). No weekday
  check — that is `ClosureIn`'s rule and it does not apply here; say so in a
  comment so the asymmetry is not read as an oversight.
- `SchoolHolidayOut(SchoolHolidayIn)`: `id`, `school_id`,
  `from_attributes`.
- `SchoolIn`: `name: str` (min_length 1 after strip).
- `SchoolOut`: `id`, `name`, `holidays: list[SchoolHolidayOut]`.

Router, `prefix="/schools"`, `tags=["schools"]`, every endpoint
`Depends(get_current_user)` and `Depends(get_db)` as in `closures.py`:

- `GET ""` → `list[SchoolOut]`, schools ordered by `name`, holidays eager
  loaded (`selectinload`) and ordered by `start_date`.
- `POST ""` → 201; `IntegrityError` on the unique name → 409 naming the
  school.
- `PATCH /{school_id}` → rename; 404 if absent, 409 on duplicate name.
- `DELETE /{school_id}` → 204, cascades to holidays; 404 if absent.
- `POST /{school_id}/holidays` → 201 `SchoolHolidayOut`; 404 if the school
  is absent.
- `PATCH /{school_id}/holidays/{holiday_id}` → full replace of dates/name;
  404 if either is absent or the holiday belongs to another school.
- `DELETE /{school_id}/holidays/{holiday_id}` → 204, same 404 rules.

Fully nested rather than a flat `/school-holidays` collection: the read side
is nested anyway (Decision 10), and a flat write path would need its own
`school_id` validation for no gain.

Tests: create/list/rename/delete a school; duplicate name → 409; delete
cascades the holidays; create/edit/delete a holiday; `end_date < start_date`
→ 422; span over 366 days → 422; a weekend-spanning range → 201 (this one
is a regression guard against someone copying `ClosureIn`'s validator in);
holiday under a missing school → 404; holiday id from another school → 404;
unauthenticated → 401.

---

## Task 3: Frontend API layer and the School Holidays page

**A.** Backend is complete: `GET/POST/PATCH/DELETE /api/v1/schools` and the
nested holiday endpoints all work and are tested. This task replaces the
`SchoolHolidaysPage` stub.

**B. Files**

- `frontend/src/api/types.ts` (add `School`, `SchoolHoliday`,
  `SchoolIn`, `SchoolHolidayIn`)
- `frontend/src/api/schools.ts` (new)
- `frontend/src/api/schools.test.tsx` (new)
- `frontend/src/lib/date.ts` (add `formatHolidayRange`)
- `frontend/src/lib/date.test.ts` (extend)
- `frontend/src/routes/SchoolHolidaysPage.tsx` (replace the stub)
- `frontend/src/routes/SchoolHolidaysPage.test.tsx` (new)

**C. Instructions**

`api/schools.ts`, following `closures.ts` exactly — a `schoolKeys` object,
`useSchools()` (unfiltered, docstring explaining why per Decision 10), and
`useCreateSchool`, `useRenameSchool`, `useDeleteSchool`,
`useCreateHoliday`, `useUpdateHoliday`, `useDeleteHoliday`, each
invalidating `schoolKeys.all` on success.

`formatHolidayRange(start, end)` in `lib/date.ts`: uses `parseLocalDate`
(never the bare `Date` constructor on `"YYYY-MM-DD"` — see the existing
comment on `formatDateWithDay`), en-GB pinned like the rest of the module,
full weekday name + `d/m/yy`, joined with an en dash. Returns the single
date alone when `start === end`.

The page, styled after `ClosuresPage`:

- No `<h1>` (Design Decision 14).
- A "Show past holidays" checkbox filtering on `end_date < today`
  (Decision 8). When a school's only holidays are past, the school row
  still shows — with an empty holiday list — since the school itself is not
  past.
- A table: **School** | **Holidays** | actions.
- Holidays cell: one `formatHolidayRange` line per holiday, ascending by
  `start_date`, each with the optional name beside it and its own edit and
  delete controls. Empty state is a muted "None recorded".
- "Add school": name-only inline form, same shape as `ClosuresPage`'s add
  form.
- Add/edit holiday: a dialog with two `<input type="date">` fields and an
  optional name (Decision 13). Mirror-validate `end_date >= start_date`
  client-side so the server's 422 is not the first line of defence, as
  `LeavePage` does for its range cap.
- Delete school: confirm naming the school and its holiday count.
- Surface API errors with the `extractAddErrorMessage`/`errorDetail`
  pattern already in `ClosuresPage`/`LeavePage`.

Tests: renders schools with formatted ranges; past holidays hidden until
the toggle; add school; add, edit and delete a holiday; delete school
confirm; client-side reversed-date validation; error message on a 409.

---

## Task 4: Annual Planner integration

**A.** The data model, API and School Holidays page are all complete. This
task adds the informational school rows to the Annual Planner grid.

**B. Files**

- `frontend/src/lib/planningMonth.ts` (add `schoolHolidayDates` or similar)
- `frontend/src/lib/planningMonth.test.ts` (extend)
- `frontend/src/components/LeavePlanningGrid.tsx`
- `frontend/src/components/LeavePlanningGrid.test.tsx`
- `frontend/src/routes/LeavePlanningPage.tsx`
- `frontend/src/routes/LeavePlanningPage.test.tsx`

**C. Instructions**

Helper in `lib/planningMonth.ts` (there is already an `overlapsRange` there
— check whether it can be reused before adding a near-duplicate): given the
month's `dates` and a school's holidays, return the subset of `dates`
falling inside any holiday, and derive the rows from that — a school with an
empty set gets no row (Decision 9). Note that `dates` is Mon–Fri only and
includes lead-in/lead-out days from adjacent months, so a holiday spanning
a weekend simply contributes the weekdays either side.

`LeavePlanningGrid`: new `schoolRows` prop per Decision 11, rendered in
their own `<tbody>` above the doctor rows. Each row is a sticky label cell
(school name, `whitespace-nowrap`, same classes as the doctor label cell)
plus one cell per date; holiday cells get the new tint, non-holiday cells
match the existing empty-cell treatment including `weekDividerClass` and
the out-of-month `bg-ink/[0.03]`. Single full-cell block, no AM/PM halves,
no button, `title` = school name + the `formatHolidayRange` of the holiday
covering that date. Add the legend entry. Nothing here touches
`totals`/`coverageClass` — closed slots keep their `gray-200` and their
`"—"` unchanged.

The corner header cell currently reads "Doctor" and now sits above a column
containing school names too. Change it to "Doctor / School" — the existing
test asserts on doctor codes rather than that header, but grep before
editing.

`LeavePlanningPage`: `useSchools()` alongside `useClosures()`, build
`schoolRows` in a `useMemo` keyed on the school data and `dates`, pass it
down. No change to save/pending logic — school rows are not editable.

Tests: a school with a holiday in view gets a row; a school with none does
not; shading matches the exact weekday columns for a range that spans
weekends and month boundaries; the school cell renders no button; coverage
totals and closed-slot rendering unchanged with school rows present.

---

## Task 5: Documentation

**A.** The feature is complete and tested end to end.

**B. Files**

- `documentation/architecture-clinical.md`
- `documentation/architecture.md`

**C. Instructions**

`architecture.md`: the School Holidays entry currently describes a stub —
replace that. The route count is unchanged (the route already existed); do
not touch the counts, and heed the existing note about not incrementing
them blind.

`architecture-clinical.md`: add School Holidays to the planning-data
section near closures, stating the design decisions worth knowing from the
code alone — range-based not per-slot, zero engine coupling, hard delete
with cascade, no AM/PM granularity, and the planner rows being purely
informational. Do not restate the endpoint list or the column types; those
are readable from the router and model.
