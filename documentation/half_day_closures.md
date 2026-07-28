# Implementation Plan — Half-day practice closures

## Plan

Extend practice closures from full-day-only to per-period (AM/PM) granularity,
so a city-wide training afternoon can close PM while AM stays open. Covers the
data model, engine, API response layer, and frontend. The system is not live,
so no data migration or backward compatibility is required.

## Scope

**In scope**

- `PracticeClosure` / `RotaClosure` gain a non-nullable `period` column.
- `GenerationContext.closed_dates` becomes `closed_slots`, keyed `(date, Period)`.
- Phases 0, 2, 5 and 12 check the period they are actually evaluating.
- `POST /closures` takes a period; `RotaOut` / `StagingOut` expose closed slots
  rather than closed dates; `POST /duty` rejects only the period that is closed.
- Frontend: closures admin page, duty board, three grids, and the Excel export.

**Out of scope**

- No restriction on which weekday may be half-closed. The feature exists for
  Thursday-afternoon training, but nothing in the model or the UI enforces that
  — the secondary-duty rule below makes a general half-day closure safe, so an
  arbitrary weekday restriction would buy nothing and would need explaining to
  users forever.
- No bulk bank-holiday import (unchanged from M5).
- No change to how a closed slot renders in the *master template* editor — that
  layer has no calendar dates.

## Design Decisions

**1. No "full day" special case in the data model.** `PracticeClosure` and
`RotaClosure` each get a non-nullable `period` column; a full-day closure is two
rows for the same date, exactly mirroring `leave_entries`' half-day granularity
(`uq_leave_slot` on `(doctor_id, date, period)`). Unique constraints move from
`(date)` to `(date, period)` and from `(rota_id, date)` to
`(rota_id, date, period)`.

**2. "Full day" is UI sugar only.** The closures page offers AM / PM / Full day
on create; Full day issues two POSTs. There is **no** `/closures/full-day`
endpoint and no `period: "FULL"` request value — `ClosureOut` inherits from
`ClosureIn`, so a `FULL` sentinel would leak into the response type and force
the two classes apart, reintroducing exactly the special case Decision 1 exists
to remove. Deleting a full-day entry from the list issues two DELETEs.

**3. Engine representation.** `GenerationContext.closed_dates: frozenset[date]`
becomes `closed_slots: frozenset[tuple[date, Period]]`. Every phase that
currently tests `date_ in closed_dates` tests `(date_, period) in closed_slots`,
keyed to the period it is already iterating.

**4. Secondary duty attaches to the week's first *fully open* weekday.**
`build_first_open_weekday` returns the first weekday (Mon..Fri) with **no
closure on either period**.

This is the load-bearing decision and it replaces the provisional plan's
"a day is closed only when both periods are closed". That inverted rule is
unsafe: secondary duty is required on **both** AM and PM of the first open
weekday (`phase12._expected_duty_counts` is called outside the period loop;
`dutyWeekSlots.weekDutySlots` flatMaps the first-open column over `["AM","PM"]`).
If the first open weekday had one period closed, Phase 12 would expect a
secondary duty in a closed slot that Phase 0 and `POST /duty` both refuse to
accept — an unfixable `duty_coverage_secondary` warning and a duty-board cell
that cannot legally be filled.

Requiring the day to be *fully* open makes both AM and PM structurally
available, so the secondary-duty expectation, the `POST /duty` secondary check,
and the duty board's `(1st)`/`(2nd)` column split all stay exactly as they are
today. Nothing per-period is needed for secondary duty anywhere.

Worked example — Easter Monday closed, Thursday PM training: Monday is fully
closed, so the first fully-open weekday is Tuesday; secondary duty is expected
Tue AM + Tue PM. Thursday keeps its AM primary and has no PM anything.

Degradation is already handled: with no fully-open weekday,
`build_first_open_weekday` returns `None`, and every consumer already treats
`None` as "no secondary expected" (`None` never equals a `Day`). That requires
five closures in one week, so it is theoretical, but it fails safe.

**5. Primary duty and duty-entry validation are period-specific.** Primary duty
never relocates; it is simply not expected on a closed slot, and is expected as
normal on the open half of a partly closed day. Phase 0's `duty_on_closed_date`
and `POST /duty`'s create-time rejection both key on the assignment's *own*
period, so a Thursday-AM primary remains assignable when Thursday PM is closed.

**6. `RotaClosure` keeps the self-contained-snapshot principle**, with the added
period column. `grid_utils.rebuild_rota_grid()`'s override of
`closed_dates`/`first_open_weekday_by_week` becomes an override of
`closed_slots`, with `first_open_weekday_by_week` re-derived from it as
`load_context()` does.

**7. Rendering (assumption — flag if you disagree).** A **fully** closed day
keeps today's treatment: greyed day header showing the closure name or "closed".
A **partly** closed day gets an ungreyed header carrying a qualified label
(`Training (PM)`), and the closed period's cells are greyed in `RotaGrid`,
`RoomRotaGrid`, `StagingGrid` and the Excel export. This adds per-cell closed
styling to `RotaGrid`, which has none today — without it a closed PM is
indistinguishable from a PM nobody happened to be scheduled in.

**8. Naming.** `closed_slots` is used throughout even though "slot" elsewhere in
the engine means `(week, day, period)` (`SessionSlot`, `sessions_for_slot`). The
collision is tolerated for consistency with the API field name; the docstring on
`GenerationContext` should say so explicitly.

---

## Task 1: Data model and `/closures` API

**A. State of the world.** `practice_closures` is date-only, unique on `date`
(declared inline as `unique=True` on the column, though migration 004 names the
constraint `uq_practice_closures_date`). `rota_closures` is unique on
`(rota_id, date)`. Nothing has been done yet — this is the first task.

**B. Files and deliverables.**

| File | Deliverable |
| --- | --- |
| `backend/app/models/closure.py` | `period` column on both models; unique constraints moved |
| `backend/alembic/versions/016_closure_period.py` | New migration |
| `backend/app/api/schemas/closure.py` | `period` on `ClosureIn`; new `ClosedSlotOut` |
| `backend/app/api/schemas/__init__.py` | Export `ClosedSlotOut` |
| `backend/app/api/routers/closures.py` | `period` on create; `(date, period)` duplicate message |
| `backend/tests/test_api/test_closures.py` | Half-day cases |
| `backend/tests/test_models.py` | Constraint coverage |

**C. Instructions.**

1. **`models/closure.py`** — import `Period, enum_col` from `.enums`. On
   `PracticeClosure`, drop `unique=True` from `date`, add
   `period: Mapped[Period] = mapped_column(enum_col(Period), nullable=False)`,
   and add
   `__table_args__ = (UniqueConstraint("date", "period", name="uq_practice_closure_slot"),)`
   — matching `LeaveEntry`'s `uq_leave_slot` naming. On `RotaClosure`, add the
   same period column and change the constraint to
   `UniqueConstraint("rota_id", "date", "period", name="uq_rota_closure_slot")`.
   Update the module docstring: it currently says "which closed *dates* fell
   inside a rota's range".

2. **Migration 016** — `revision = "016"`, `down_revision = "015"`. Copy the
   `_enum_column` helper **verbatim from 015** (which copied 014, which copied
   011): on Postgres it references the existing named `period` enum type with
   `create_type=False`; elsewhere it renders a plain `sa.Enum`. Note that
   migration 004 is *not* the right reference here despite being the closures
   migration — its docstring explicitly says "No enums involved, so none of
   001/002's enum-type-reuse handling applies".

   Adding a non-nullable column to a populated table needs either a
   `server_default` or empty tables. A full-day closure must become *two* rows,
   so there is no in-place backfill that preserves meaning. The system is not
   live, so `upgrade()` should `op.execute("DELETE FROM rota_closures")` and
   `op.execute("DELETE FROM practice_closures")` first, then add the column
   non-nullable with no server default. Say this in the migration docstring so
   it reads as a deliberate choice, not an oversight.

   Both constraint changes must go through `op.batch_alter_table` — dev runs
   SQLite (`database.py:12` defaults to `sqlite:///./rota.db`), which cannot
   drop or alter a constraint in place. This is the first migration in the
   project to drop a constraint, so there is no local precedent to copy.

   `downgrade()` mirrors it: delete rows, drop the period column, restore the
   original constraints. Two half rows cannot collapse back into one, so the
   row deletion is required in both directions.

3. **`schemas/closure.py`** — `ClosureIn` gains `period: Period` (import it the
   same way `schemas/duty.py` does). The weekday validator is unchanged.
   `ClosureOut(ClosureIn)` inherits the field; no other change. Add:

   ```python
   class ClosedSlotOut(BaseModel):
       date: datetime.date
       period: Period
   ```

   This is the shared shape for `RotaOut` and `StagingOut` in Task 3. Export it
   from `schemas/__init__.py`.

4. **`routers/closures.py`** — pass `period=payload.period` in `create_closure`;
   change the 409 detail to name the period as well as the date. Add
   `PracticeClosure.period` to the `list_closures` ordering after `date`, so
   AM sorts before PM deterministically. Update the module docstring's
   description of the duplicate rule.

5. **Tests** — a closure on `(date, AM)` does not block `(date, PM)` (201, not
   409); the same `(date, period)` twice is 409; a weekend date is still 422;
   `GET /closures` returns `period` and orders AM before PM within a date.

---

## Task 2: Engine changes

**A. State of the world.** Task 1 is complete: both closure tables carry a
non-nullable `period`, and `/closures` reads and writes it. The engine still
works in whole dates — `GenerationContext.closed_dates: frozenset[date]`.

**B. Files and deliverables.**

| File | Deliverable |
| --- | --- |
| `backend/app/engine/datatypes.py` | `closed_slots` field + docstring |
| `backend/app/engine/context.py` | Build `closed_slots` from `PracticeClosure` |
| `backend/app/engine/week_map.py` | Fully-open rule in `build_first_open_weekday` |
| `backend/app/engine/phases/phase0.py` | Period-specific `duty_on_closed_date` |
| `backend/app/engine/phases/phase2.py` | Per-period slot skip |
| `backend/app/engine/phases/phase5.py` | Per-period clinic skip |
| `backend/app/engine/phases/phase12.py` | Per-period primary expectation + clinic coverage |
| `backend/app/engine/generate.py` | One `RotaClosure` row per `(date, period)` |
| `backend/app/engine/grid_utils.py` | Snapshot override in `closed_slots` terms |
| `backend/tests/test_engine/{test_closures,factories,test_grid_utils,test_generate,test_phase5}.py` | Half-day coverage |

**C. Instructions.**

1. **`datatypes.py:353`** — replace `closed_dates: frozenset[date]` with
   `closed_slots: frozenset[tuple[date, Period]]`. Rewrite the comment block
   above it (lines ~344–354): it currently says "dates the practice is closed"
   and "Phase 2 builds no slots on a closed date". Add the Decision 8 note about
   "slot" here meaning `(date, period)`, not `(week, day, period)`.

2. **`context.py:90–98`** — the query is unchanged (it already filters by date
   range); build
   `closed_slots = frozenset((c.date, c.period) for c in closure_rows)` and pass
   it straight to `build_first_open_weekday(week_dates, closed_slots)`. Do **not**
   derive a separate day-level set here — the fully-open rule lives inside
   `build_first_open_weekday` and must exist in exactly one place (`grid_utils`
   calls the same function).

3. **`week_map.build_first_open_weekday`** — parameter becomes
   `closed_slots: frozenset[tuple[date, Period]]`; the test at line 74 becomes

   ```python
   if d is not None and (d, Period.AM) not in closed_slots and (d, Period.PM) not in closed_slots:
   ```

   Rewrite the docstring to state the fully-open rule and *why* (Decision 4):
   secondary duty needs both periods of its day, so a partly closed day cannot
   host it. Keep the existing note that this degrades to the plain Monday rule
   when nothing is closed.

4. **`phase0.py:191`** — `if (date_, period) not in context.closed_slots:
   continue`. `period` is already unpacked from the `duty_map` key on line 188.
   Update the message to read as period-specific and adjust the docstring, which
   currently says "a closed date has no sessions".

5. **`phase2.py:62`** — `if (date_, period) in context.closed_slots: continue`.
   `period` is already in scope from the enclosing loop. The "cell absence is
   data" comment stays true and now applies per period; extend it to say so.

6. **`phase5.py:46`** — `if (date_, period) in context.closed_slots:`. `period`
   is already bound from `schedule.period` on line 42. The `skip_closed_date`
   log entry already carries `period`, so its message needs no change.

7. **`phase12.py`** — two changes.

   `_expected_duty_counts` currently takes `(context, gen_week, day)` and is
   called on line 100, **outside** the `for period in _PERIODS` loop. Add
   `period` to the signature, move the call inside the period loop, and make
   primary period-aware:

   ```python
   expected_primary = 0 if (date_, period) in context.closed_slots else 1
   expected_secondary = 1 if day == context.first_open_weekday_by_week.get(gen_week) else 0
   ```

   `expected_secondary` is **unchanged** — Decision 4 guarantees the first open
   weekday has both periods available. Update the docstring's M5 paragraph to
   say so explicitly, since "why isn't this per-period too?" is the obvious
   question a future reader will ask.

   Clinic coverage at line 134 becomes
   `if date_ is not None and (date_, schedule.period) in context.closed_slots:`.

8. **`generate.py`** — rename the `closed_dates` parameter on `_write_to_db`
   (line 84) and its call site (line 73) to `closed_slots`; the write loop at
   lines 130–131 becomes one row per pair:

   ```python
   for closed_date, closed_period in sorted(closed_slots, key=lambda s: (s[0], s[1].value)):
       db.add(RotaClosure(rota_id=rota.id, date=closed_date, period=closed_period))
   ```

9. **`grid_utils.py:69–84`** — the snapshot becomes
   `frozenset((r.date, r.period) for r in rows)` (the query must now select the
   `RotaClosure` rows themselves, which it already does), assigned to
   `closed_slots=` in the `dataclasses.replace()` call, with
   `first_open_weekday_by_week` re-derived from it via the same
   `build_first_open_weekday`. Update the module docstring at lines 31–37.

10. **Tests** — the key new cases: a PM-only closure leaves AM slots, AM clinics
    and AM primary duty intact while producing no PM slot and no PM clinic
    warning; a PM-only closure on the week's first weekday pushes secondary duty
    to the next fully open weekday; a duty assignment on the open half of a
    partly closed day raises no Phase 0 error, while one on the closed half does;
    a rota generated over a half closure snapshots exactly one `RotaClosure` row
    for that date, and `rebuild_rota_grid` reproduces the same grid.

---

## Task 3: API response layer

**A. State of the world.** Tasks 1 and 2 are complete: the tables, the engine
and `/closures` are all period-granular. Three other endpoints still report
closures as bare dates, so nothing downstream can see a half closure yet.

**B. Files and deliverables.**

| File | Deliverable |
| --- | --- |
| `backend/app/api/schemas/rota.py` | `RotaOut.closed_slots` |
| `backend/app/api/routers/rota.py` | `_closed_slots_out` from the snapshot |
| `backend/app/api/schemas/staging.py` | `StagingOut.closed_slots` |
| `backend/app/api/routers/staging.py` | `_closed_slots_out` from live closures |
| `backend/app/api/routers/duty.py` | Period-specific rejection; fully-open rule |
| `backend/app/api/schemas/duty.py` | Docstring only |
| `backend/tests/test_api/{test_rota,test_staging,test_leave_duty}.py` | Coverage |

**C. Instructions.**

1. **`schemas/rota.py:95`** — replace `closed_dates: list[datetime.date]` with
   `closed_slots: list[ClosedSlotOut]` (from Task 1). Update the docstring at
   lines 75–76.

2. **`routers/rota.py:187`** — `_closed_dates_out` becomes `_closed_slots_out`,
   selecting `RotaClosure.date, RotaClosure.period`, sorted by
   `(date, period.value)`, returning `ClosedSlotOut` instances. Update the call
   site at line 407.

3. **`schemas/staging.py:71` and `routers/staging.py:171`** — the same change,
   still reading **live** `PracticeClosure` (staging has no snapshot, Design
   Decision 10 of the staging plan — that reasoning is unaffected).

4. **`routers/duty.py`** — three changes.

   `_closed_dates_in_week` (line 49) becomes `_closed_slots_in_week`, selecting
   `PracticeClosure.date, PracticeClosure.period` and returning
   `set[tuple[date, Period]]`.

   `_first_open_weekday` (line 59) applies the fully-open rule, mirroring
   `week_map.build_first_open_weekday` — a candidate qualifies only if neither
   `(candidate, AM)` nor `(candidate, PM)` is in the set. Keep the comment
   pointing at the engine function it mirrors.

   `create_duty` (line 124) rejects on `(payload.date, payload.period)` rather
   than `payload.date`, with a message naming the period. The secondary check
   below it is otherwise unchanged.

   The `first_open is None` branch (lines 135–138) is currently commented
   "defensive, not reachable in practice, since every candidate date in that
   week is itself closed". Under the fully-open rule it *is* reachable in
   principle — a fully closed Monday plus half closures Tue–Fri gives
   `first_open is None` while `payload.date` itself is open — so the comment
   needs correcting and the `"must be assigned on no day"` message needs to read
   sensibly. Also update the module docstring's third bullet, which asserts the
   fully-closed-week case is always caught by the closed-date check above.

5. **`schemas/duty.py:18`** — docstring reference to "first open weekday" should
   note the fully-open rule. No code change.

6. **Tests** — `RotaOut`/`StagingOut` carry one entry for a half closure and two
   for a full day; `POST /duty` accepts a primary on the open half of a partly
   closed day and rejects one on the closed half; secondary duty is expected on
   the first *fully* open weekday, not merely the first not-wholly-closed one.

---

## Task 4: Frontend — types, closures page, duty board

**A. State of the world.** The backend is complete and period-granular
end to end. The frontend still models closures as dates: `Closure` has no
period, `Rota`/`Staging` expose `closed_dates: string[]`, and
`dutyWeekSlots.ts` treats a closed weekday as one inert column.

**B. Files and deliverables.**

| File | Deliverable |
| --- | --- |
| `frontend/src/api/types.ts` | `period` on `Closure`/`ClosureIn`; `ClosedSlot`; `closed_slots` on `Rota`/`Staging` |
| `frontend/src/lib/closedSlots.ts` (new) | Shared key/set helpers |
| `frontend/src/routes/ClosuresPage.tsx` (+ test) | AM/PM/Full day create; collapsed list |
| `frontend/src/lib/dutyWeekSlots.ts` (+ test) | Fully-open rule; per-period required slots |
| `frontend/src/lib/dutyWeekComplete.ts` (+ test) | Verify only — should need no change |
| `frontend/src/components/DutyGrid.tsx` (+ test) | Per-period closed cells |
| `frontend/src/test/msw/handlers.ts`, `src/test/fixtures/*.ts` | Fixture shape |

**C. Instructions.**

1. **`types.ts`** — `Closure` and `ClosureIn` gain `period: Period`. Add
   `export interface ClosedSlot { date: string; period: Period }`. Replace
   `Rota.closed_dates` (line 536) and `Staging.closed_dates` (line 690) with
   `closed_slots: ClosedSlot[]`, updating both docstrings.

2. **New `lib/closedSlots.ts`** — five call sites need the same lookup, so put
   it in one place rather than copying a `Set` idiom five times:

   ```ts
   export function closedSlotKey(date: string, period: Period): string
   export function toClosedSlotSet(slots: ClosedSlot[]): Set<string>
   export function isSlotClosed(set: Set<string>, date: string, period: Period): boolean
   export function isDayFullyClosed(set: Set<string>, date: string): boolean
   export function isDayPartlyClosed(set: Set<string>, date: string): boolean
   ```

   `Closure[]` (from `useClosures`) and `ClosedSlot[]` (from `Rota`/`Staging`)
   are structurally compatible for this purpose — accept the narrower
   `{date, period}` shape so both feed the same helpers.

3. **`ClosuresPage.tsx`** — add a period select to the add form: AM / PM /
   Full day, defaulting to **Full day** (the bank-holiday case, and what
   preserves today's behaviour for an unchanged workflow). Full day fires two
   sequential `createClosure` calls (AM then PM); if the second fails after the
   first succeeded, surface the error and leave the AM row in place rather than
   attempting a rollback — the list will show the half closure, which the user
   can complete or delete.

   The list collapses two rows with the same date **and** the same name into a
   single "Full day" row whose delete removes both ids. Rows sharing a date but
   differing in name stay as two rows — collapsing those would silently discard
   one of the labels.

4. **`dutyWeekSlots.ts`** — `firstOpenWeekday(weekStartDate, closedSet)` applies
   the fully-open rule (neither AM nor PM closed). Keep the comment identifying
   it as the deliberate TS mirror of `week_map.build_first_open_weekday`, and
   extend the case matrix it points at to cover a partly closed first weekday.

   In `buildColumns`, rename `Column.closed` to `Column.fullyClosed` and keep
   its current meaning: a wholly closed weekday is one inert column with
   `dutyType: null`. A *partly* closed weekday is an ordinary primary column —
   it can never be the first fully-open weekday, so the `(1st)`/`(2nd)` split
   needs no per-period awareness (Decision 4).

   `weekDutySlots` gains the closed set and filters the flatMap per period:
   a partly closed day contributes its open period's primary slot only. This is
   what stops the duty board demanding an assignment in a closed Thursday PM.

5. **`dutyWeekComplete.ts`** — derives entirely from `weekDutySlots`, so it
   should need no change beyond threading whatever the new signature requires.
   Confirm rather than assume.

6. **`DutyGrid.tsx`** — the header at lines 288/292 follows `col.fullyClosed`;
   for a partly closed day it shows the qualified label per Decision 7. The cell
   branch at line 299 is **already inside** the `PERIODS.map` loop (line 295), so
   it becomes
   `if (col.fullyClosed || isSlotClosed(closedSet, col.date, period))` — a flat
   condition change, not a restructure. Check the `buildColumns(...).map(c => c.date)`
   flatMap at line 77 still produces what the counter query needs.

---

## Task 5: Frontend — grids and Excel export

**A. State of the world.** Everything above is complete; the closures page and
duty board are period-aware. The three rota grids and the Excel export still
read closure data at day granularity, so a half closure renders as a whole
closed day in all four.

**B. Files and deliverables.**

| File | Deliverable |
| --- | --- |
| `frontend/src/components/RotaGrid.tsx` (+ test) | Qualified header; new per-cell closed styling |
| `frontend/src/components/RoomRotaGrid.tsx` (+ test) | Qualified header; per-period `closed` prop |
| `frontend/src/components/StagingGrid.tsx` (+ test) | Qualified header; per-cell closed styling |
| `frontend/src/routes/StagingPage.tsx` | Prop rename |
| `frontend/src/lib/exportRota.ts` (+ test) | `isClosed` moved inside both period loops |

**C. Instructions.**

1. **`RotaGrid.tsx`** — `closedDatesSet` (line 110) becomes a
   `toClosedSlotSet(rota.closed_slots)`. The day header (line 274) greys only on
   `isDayFullyClosed`; on `isDayPartlyClosed` it stays ungreyed and shows
   `${closureName ?? "closed"} (${period})`. Keep sourcing the display name from
   the live closures list — that cosmetic-only decision is unchanged.

   Body cells have **no** closed styling today. Add a `closed?: boolean` prop to
   `ReadOnlyGridCell` and `EditableGridCell` and pass
   `isSlotClosed(set, date, period)`, mirroring `RoomCell`'s early-return
   pattern. Do not smuggle it through the existing `dividerClassName` prop.

2. **`RoomRotaGrid.tsx`** — same header treatment (line 83). Line 129 already
   passes a per-cell `closed` prop but computes it day-level; change it to
   `isSlotClosed(set, date, period)`. `RoomCell`'s closed branch and its
   ordering comment ("closed date first, must precede the occupancy lookup")
   stay as they are.

3. **`StagingGrid.tsx`** — the `closedDates: string[]` prop becomes
   `closedSlots: ClosedSlot[]`; update the call site in `StagingPage.tsx:98`.
   Header treatment as above. Body cells gain the same per-cell greying as
   `RotaGrid` for consistency — the staging grid is the pre-generation preview
   of exactly that grid.

4. **`exportRota.ts`** — the real bug: `const isClosed = closedDatesSet.has(date)`
   is hoisted **above** the `for (const period of PERIODS)` loop in both the room
   sheet (line ~353) and the doctor sheet (line ~473), and gates whether the cell
   receives content. Move both inside the period loop and key on
   `(date, period)`. `dayHeaderText` (line 235) takes the same qualified-label
   treatment as the on-screen headers. `closedDatesSet` at line 408 becomes the
   slot set.

5. **Tests** — for each of the three grids and the export: a PM-only closure
   leaves AM cells populated and greys only PM; a full-day closure renders
   exactly as it does today (this is the regression guard that matters most,
   since full-day is the common case).

---

## Task 6: Architecture documentation

**A. State of the world.** The feature is complete and tested.
`documentation/architecture.md` still describes closures as date-only in roughly
a dozen places.

**B. Files and deliverables.** `documentation/architecture.md` only.

**C. Instructions.** Update, in document order:

- **Line 23** (`DecisionLog`) — Phase 5 logs each closed *slot* it skips.
- **Line 29** (Phase 0) — `duty_on_closed_date` keys on `(date, period)`.
- **Line 30** (Phase 2) — no slot on a closed `(date, period)`.
- **Line 32** (Phase 5) — closed-slot skip.
- **Line 36** (Phase 12) — primary is 0 on a closed *slot*; secondary is expected
  on the first *fully open* weekday. State Decision 4's reasoning in one clause,
  since this is the line a future reader will check.
- **Line 46** (recurring notes) — "the date is closed" → the slot is closed.
- **Line 60** (persistence) — one `RotaClosure` row per closed slot.
- **Line 71** (snapshot) — `closed_slots` override.
- **Line 93** (generation inputs) — duty rejection is period-specific.
- **Line 95** (practice closures) — unique `(date, period)` / `(rota_id, date, period)`;
  a full-day closure is two rows; add the motivating context (city-wide training
  afternoons) so the design reads as deliberate.
- **Line 123** (migrations) — amend the 004 entry to note 016 supersedes its
  "no enum involved" property, and add a 016 entry covering the batch-mode
  constraint change and the deliberate row deletion.
- **Line 184** (`/duty`) and **line 185** (`/closures`) — period in the request;
  duplicate check on `(date, period)`.
- **Line 198** (`GET /rota/{id}`) — `closed_slots`, not `closed_dates`.
- **Line 239** (staging) — `closed_slots`, live.
- **Lines 276–277** (DutyPage, ClosuresPage) — fully-open rule; AM/PM/Full day
  create with the full-day fan-out.
- **Line 353** (staging grid headers) — qualified header for partial closures.

---

## Notes for the implementer

- The branch is only coherent at the end. Task 1 makes `period` required on
  `ClosureOut` and Task 3 renames two response fields, both of which the
  frontend reads — the app is broken between Tasks 1 and 5. Do not deploy
  mid-sequence.
- Tasks 1→2→3 are strictly ordered. Tasks 4 and 5 both depend on Task 3 but are
  independent of each other. Task 6 is last.
- Design Decision 7 (rendering) was assumed rather than confirmed. If the
  preference is header-label-only, Task 5 loses the per-cell work in `RotaGrid`
  and `StagingGrid` and shrinks considerably; nothing else changes.
