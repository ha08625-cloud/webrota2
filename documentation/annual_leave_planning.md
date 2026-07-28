# Implementation Plan: Annual Leave Planning

## Plan

Add a month-at-a-time planning grid (doctors x weekday dates x AM/PM) for entering annual
leave and planned extra sessions together, with a live clinical-headcount total row per
`(date, period)`. Alongside it, give `Doctor` an optional employment window
(`start_date` / `end_date`) so joiners and leavers can be entered ahead of time, and make
the generation path honour that window.

## Scope

**In scope**

- `Doctor.start_date` / `Doctor.end_date` (nullable), plus migration, schemas, and the
  `DoctorsPage` form fields.
- Window enforcement at three points: Phase 2 grid build, the `POST /staging` copy loop,
  and `POST /duty` + Phase 0.
- New read-only `GET /leave-planning/coverage` returning per-`(date, period)` clinical
  headcount.
- New `POST /leave-planning/bulk` applying a batch of leave / extra-session / clear
  actions in one transaction.
- New `/leave-planning` frontend page: Partner and Salaried rows only, one month per view,
  batched edits with a single Save, live client-side total row.

**Out of scope**

- **Flattening the master template from 4 weeks to 1.** See Design Decision 1 — the
  coverage calculation assumes template week 1, but the schema keeps its four weeks.
  Record the flatten as a separate ticket.
- Changing how extra sessions are applied. They remain a staging time creation; this plan only adds a
  second place to enter them.
- Retroactively touching an already-generated draft or committed rota, beyond the existing
  `_release_draft_rooms` behaviour which is preserved as-is.
- Session-type-aware coverage (surgery-capable vs admin-only). The total is a single
  clinical headcount — see Design Decision 3.
- Trainee, Locum and AHP rows on the planning grid (user decision). Their leave is still
  entered on the existing `/leave` page, and their date windows still apply at generation.

---

## Design Decisions

### 1. Coverage reads template week 1 only

The provisional plan assumed the calculation could map a calendar date onto the 4-week
template cycle "the same way staging does". It cannot: `week_map.template_week(gen_week,
start_week)` needs a `start_week`, and the only source of one is `RotaConfig.template_start_week`
— a per-run value with no calendar anchor. `RotaPage.tsx:136` pins it to `1` on every
staging create ("intentionally not a form field").

So the coverage endpoint reads `MasterRotaSession` rows where `week == 1` and treats that
as the working pattern for every date.

**The rationale.** Partner and salaried doctors work the same sessions every week. Rooms may change but this is irrelevant for leave planning

### 2. Planning grid rows are Partner and Salaried only

`DoctorType` has five values (`Partner`, `Salaried`, `Trainee`, `Locum`, `AHP`). The grid
renders and totals only `Partner` and `Salaried` (user decision). The filter is applied
server-side in the coverage endpoint and client-side in the row build, so the total on
screen always equals the sum of the visible rows.

The `POST /leave-planning/bulk` endpoint is **not** type-filtered — it is a generic write
path, and refusing a Trainee there would be an arbitrary restriction on an endpoint that
has no reason to care.

### 3. Coverage counts clinical sessions only

A doctor counts toward `(date, period)` when their effective session for that slot is
`REQUIRES_ROOM` or `PRE_ASSIGNED`. `NO_SURGERY`, `ADMIN_TIME`, `WFH` and "no template row"
all count as zero.

This matches the extra-session override table, which converts exactly
`NO_SURGERY` / `ADMIN_TIME` / `WFH` / absent *into* `REQUIRES_ROOM` — i.e. the existing
model already treats those four as "not working" and the other two as "working". Defining
the headcount any other way would put the two halves of the grid in disagreement with each
other.

### 4. Extra sessions are planned intent, not guaranteed capacity

Leave and extra sessions are **not** symmetric, and the grid must not imply they are.

- Leave is read live by the engine on every run (`context.leave_set`).
- An extra session is applied **once**, in `POST /staging`'s copy loop
  (`extra_sessions.md` Decision 2). It does nothing to a staging that already exists
  (Decision 9), and the direct `POST /rota/generate` path ignores it entirely.
- The override is conditional. Per the override table, a slot already `REQUIRES_ROOM` or
  `PRE_ASSIGNED` is untouched — the doctor was already working, so the extra session is a
  no-op and adds nothing. Leave on the slot also skips the override.

Two consequences for this ticket:

1. The coverage calculation must apply the same override table, not a flat `+1`, or it
   will over-count every extra session planned on a slot the doctor already worked.
2. The cell and any legend say **"Extra planned"**, matching the wording `StagingGrid`
   already uses for the same reason, and the page carries one line of text stating that
   extra sessions apply when a staging is next created.

### 5. Closures suppress coverage

`PracticeClosure` is half-day granular (migration 016), and Phase 2 creates no slot on a
closed `(date, period)`. A closed slot therefore has a headcount of zero, not a template
headcount — the provisional plan omitted closures entirely and would have shown a full
practice on a bank holiday.

Closed cells render inert on the grid (no toggle, no drop target), reusing the
full-day-vs-half-day treatment `RotaGrid` and `StagingGrid` already have, and their total
column renders `—` rather than `0` so "closed" is not confused with "uncovered".

Closures are read live from `PracticeClosure`. There is no snapshot to prefer here — this
is forward planning, not the rendering of an existing rota.

### 6. A doctor is "working" on a date when active and inside their window

`active` stays exactly as it is — the soft-delete flag, unrelated concept, not replaced.
The window is an additional, independent gate:

```
working(doctor, date) := doctor.active
                         and (start_date is null or start_date <= date)
                         and (end_date   is null or end_date   >= date)
```

Null at either end means unbounded. Both nulls is the current behaviour for every existing
row, so migration 017 needs no backfill (the 006/008 pattern).

### 7. The window is enforced at three points, not one

The provisional plan put the check only in Phase 2. That is necessary but not sufficient,
because the frontend never calls `/rota/generate` — it goes through `/staging`.

- **Phase 2 (`_build_grid`)** — the authority. Skips slot creation for any
  `(doctor, date)` outside the window, using the same "cell absence is data" mechanism as
  a missing template row and a closed slot. Covers the direct-generate path and any
  staging row created before a window change.
- **`POST /staging` copy loop** — skips copying rows for an out-of-window
  `(doctor, date)`, and skips the extra-session new-row branch for the same. Without this
  the admin sees and edits cells in `StagingGrid` that then silently vanish at Complete,
  with nothing explaining why.
- **`POST /duty` and Phase 0** — `phase4.py:118` currently degrades a duty assignment with
  no session slot to a `duty_no_session_slot` warning. Duty on a doctor outside their
  window should be a hard Phase 0 error, mirroring `duty_on_leave` and
  `duty_on_closed_date`, with `POST /duty` rejecting it up front the same way it already
  rejects a closed slot.

### 8. Out-of-window entries are skipped, not fatal

The provisional plan had the entry endpoints 422 on an out-of-window date. That is right
for the single-entry endpoints and wrong for the bulk one: `/leave/bulk` reports `skipped`
with a reason rather than failing, and one stale cell 422-ing a 200-cell save is a bad
trade.

- `POST /leave` and `POST /extra-sessions` (single): 422, naming the doctor and their
  window.
- `POST /leave/bulk` and `POST /leave-planning/bulk`: the entry lands in `skipped` with
  reason `"outside_doctor_dates"`, alongside the existing `"weekend"` and `"duplicate"`
  reasons.

### 9. Batch semantics for `/leave-planning/bulk`

One transaction, applied in a fixed order so a batch that touches both sides of a slot is
deterministic: **clears first, then leave, then extra sessions.**

- **Leave wins**, consistent with `extra_sessions.md` Decision 6. An extra-session action
  on a slot that the same batch (or the existing data) puts on leave is skipped with
  reason `"leave_exists"`, and any pre-existing `ExtraSessionEntry` the batch's leave
  covers is *reported* in `superseded_extra_sessions` — never deleted, never a 409. This
  mirrors `create_leave_bulk` exactly.
- **Idempotent.** Setting leave where leave already exists is a `"duplicate"` skip, not a
  409. The grid sends the state it wants; a cell that already matches must not fail the
  save.
- **`"clear"` removes both** the `LeaveEntry` and the `ExtraSessionEntry` for the slot, if
  present. Both are keyed on the same `(doctor_id, date, period)` triple, so there is
  nothing to disambiguate.
- The whole batch is one transaction: any unexpected `IntegrityError` rolls the lot back
  and returns 409, matching `create_leave_bulk`'s concurrent-write handling.

### 10. `_release_draft_rooms` is preserved

`routers/leave.py:_release_draft_rooms` clears `room_id` on the active draft's matching
sessions whenever leave is added (M4.3 Task 3). The new bulk endpoint writes `LeaveEntry`
rows directly and **must** call it for every leave candidate, duplicates included — the
same deliberate over-call `create_leave_bulk` makes, so an all-duplicates request still
heals stale room state.

The asymmetry is preserved too: `"clear"` does **not** restore rooms, matching both the
existing bulk-delete and the WFH behaviour.

### 11. New router, not an extension of `/leave`

`/leave-planning` owns the two new endpoints. The existing `/leave` and `/extra-sessions`
routers are untouched apart from Decision 8's single-entry 422 — they remain the ad-hoc,
one-off path during the year, and `LeavePage`'s range form and block table keep working
exactly as they do now.

### 12. Month at a time, weekdays only

The grid is Mon–Fri (`phase2._DAYS`), so a month is ~22 date columns x AM/PM ≈ 44 cell
columns against ~10–12 Partner/Salaried rows. That renders fine, but the first column is
sticky and cell state lives in one page-level `Map` keyed `(doctor_id, date, period)` —
not per-cell React state.

---

# Task 1: Doctor date window — data model and API

## A. State of the world

Nothing has been built yet. This task adds the two columns, the migration, the schema
fields, and the single-entry validation described in Design Decision 8. No engine,
staging, or frontend code is touched — Task 2 does those.

## B. Files and deliverables

**New**
- `backend/alembic/versions/017_doctor_date_window.py`

**Edited**
- `backend/app/models/doctor.py` — `start_date`, `end_date`
- `backend/app/api/schemas/doctor.py` — the fields on `DoctorIn`, `DoctorPatch`, `DoctorOut`
- `backend/app/api/routers/doctors.py` — `start_date <= end_date` validation
- `backend/app/api/routers/leave.py` — window check on `POST /leave`, `"outside_doctor_dates"` skip on `POST /leave/bulk`
- `backend/app/api/routers/extra_sessions.py` — window check on `POST /extra-sessions`
- `backend/app/api/schemas/leave.py` — the new skip reason
- `backend/tests/test_api/test_doctors.py`, `test_leave_duty.py`, `test_extra_sessions.py`

## C. Instructions

**Model.** Two nullable columns on `Doctor`:

```python
start_date: Mapped[datetime.date | None] = mapped_column(Date, nullable=True)
end_date:   Mapped[datetime.date | None] = mapped_column(Date, nullable=True)
```

No check constraint on the ordering — the pair is validated at the API boundary, matching
how the room XOR is *also* enforced there, and a DB constraint would make an
end-date-only-then-start-date PATCH sequence awkward for no benefit.

**Migration.** Revision `017`, `down_revision = "016"`. Two `op.add_column` calls, no
`server_default`, no backfill — null means unbounded permanently, not temporarily,
following the 006 and 008 pattern exactly. No enum involved, so none of 011/014/015/016's
`_enum_column` helper applies. `downgrade()` drops both columns.

**Schemas.** `start_date: datetime.date | None = None` and `end_date: datetime.date | None = None`
on `DoctorIn`, `DoctorPatch` and `DoctorOut`. Do **not** put the ordering check in a
`model_validator` on `DoctorPatch` — a partial update may supply only one of the pair, so
the check needs the merged post-update values and therefore belongs in the router.

**Router validation.** In `doctors.py`, add a small module-level helper:

```python
def _validate_window(start: date | None, end: date | None) -> None:
    if start is not None and end is not None and start > end:
        raise HTTPException(422, detail="start_date must not be after end_date")
```

Call it in `create_doctor` with the payload values, and in the PATCH handler with the
*merged* values (payload field where set via `model_fields_set`, existing column
otherwise).

**Shared window predicate.** Add to `backend/app/api/routers/leave.py` — or better, a new
`backend/app/api/doctor_window.py` if you prefer it importable without a router cycle:

```python
def is_within_window(doctor: Doctor, day: date) -> bool:
    return (
        (doctor.start_date is None or doctor.start_date <= day)
        and (doctor.end_date is None or doctor.end_date >= day)
    )
```

Note this deliberately does **not** check `active` — callers combine the two as they need,
and Phase 2 already has its own active filter via `context.doctors`. Task 2 and Task 3 both
import this; do not reimplement it.

**Single-entry 422s.** In `create_leave` and `create_extra_session`, after the existing
404-unknown-doctor check, 422 when `not is_within_window(doctor, payload.date)`. Message
names the doctor code and the window, e.g.
`"Dr AB does not work on 2026-09-01 (starts 2026-10-05)"`. Note `create_leave` currently
does `db.get(Doctor, ...) is None` without binding the row — bind it so the code is
available for the message.

**Bulk skip reason.** `LeaveBulkSkippedOut.reason` is currently a free string; add
`"outside_doctor_dates"` as a third value it can carry. In `create_leave_bulk`, filter the
candidate list against the window *before* the existing-entry query, moving rejected pairs
into `skipped`. Order matters: an out-of-window weekend date should report `"weekend"`
(the existing check runs first and is the more specific fact).

**Tests.** Doctor create/patch round-trip with and without the dates; 422 on
`start_date > end_date` including the PATCH-merge case (existing `end_date`, PATCH sets a
later `start_date`); `POST /leave` 422 before the window and after it; the same for
`POST /extra-sessions`; `POST /leave/bulk` reporting `"outside_doctor_dates"` for the
out-of-window portion of a range while still inserting the in-window portion.

---

# Task 2: Engine, staging and duty enforcement

## A. State of the world

Task 1 is complete: `Doctor.start_date`/`end_date` exist, migration 017 has shipped, the
single-entry endpoints reject out-of-window dates, and `is_within_window` is available.
Nothing yet stops an out-of-window doctor being *generated*. This task closes that at the
three points of Design Decision 7. No frontend code is touched.

## B. Files and deliverables

**Edited**
- `backend/app/engine/phases/phase2.py` — window check in `_build_grid`
- `backend/app/engine/phases/phase0.py` — new `duty_outside_doctor_dates` check
- `backend/app/api/routers/staging.py` — window check in `create_staging`'s copy loop and its extra-session branch
- `backend/app/api/routers/duty.py` — reject an out-of-window duty on create
- `backend/tests/test_engine/test_phase2.py`, `test_phase0.py`
- `backend/tests/test_api/test_staging.py`, `test_leave_duty.py`

## C. Instructions

**Phase 2.** In `_build_grid`, immediately after `date_ = context.week_dates[(gen_week, day)]`
is resolved and alongside the existing `closed_slots` check, skip the slot when the doctor
is outside their window on `date_`. Put it next to the closure skip and comment it the same
way — cell absence is data, so no downstream phase needs a per-slot window check.

The predicate needs `Doctor` rows, which Phase 2 has via `context.doctors` (it is already
iterating them). Do **not** thread a new field onto `GenerationContext` for this; the
`Doctor` object in the loop carries both columns.

Note the ordering: resolve `date_` once, before both the closure check and the window
check. It is currently resolved just above the closure check, so this is a no-op move.

**Phase 0.** Add `_check_duty_within_doctor_dates(context)` following
`_check_duty_doctors_not_on_leave` (line 75) almost verbatim — iterate `context.duty_map`,
look the doctor up in `context.doctor_by_id`, and emit `severity="error"`,
`check="duty_outside_doctor_dates"` when the date falls outside the window. Register it in
the `run_phase0` issue list next to `_check_duty_on_closed_date` (line 27).

Use `context.doctor_by_id`, not `context.doctors` — an inactive doctor must still be
reachable here, the same reason `_check_template_doctors_active` uses it.

**Staging copy loop.** In `create_staging`, the copy loop already resolves
`session_date = week_dates[(gen_week, row.day)]` for the extra-session override. Add the
window check there: skip the row entirely when the doctor is out of window on
`session_date`. Apply the same check in the post-loop branch that creates new
`RotaStagingSession` rows for extra sessions with no template row — an extra session
planned outside a doctor's window must not conjure a staged row.

Build a `{doctor_id: Doctor}` map once before the loop rather than a `db.get` per row.

Update the router module docstring, which already records that the copy loop is no longer
a pure copy, to name the window skip as the second reason.

**Duty create.** `create_duty` already performs DB-backed rejections in the router (closed
slot, secondary-duty weekday) rather than in a pydantic validator, for exactly the reason
that applies here. Add a third: 422 when the named doctor is outside their window on
`payload.date`, plain-string detail naming the doctor and the window, matching the wording
of the existing two.

**Tests.** Phase 2: a doctor with `start_date` after the run's range gets no slots; one
with `start_date` mid-range gets slots only from that date on; one with `end_date`
mid-range gets slots only up to it; null/null is unchanged; the window check composes with
the closure skip rather than overriding it. Phase 0: `duty_outside_doctor_dates` is an
error and aborts the run; a duty inside the window is clean. Staging: an out-of-window
doctor's rows are not copied, and an out-of-window extra session creates no row. Duty API:
422 on an out-of-window date.

---

# Task 3: `/leave-planning` coverage and bulk endpoints

## A. State of the world

Tasks 1 and 2 are complete: the date window exists end to end and is enforced at
generation. This task adds the two new endpoints the planning grid needs. No frontend code
is touched.

## B. Files and deliverables

**New**
- `backend/app/api/schemas/leave_planning.py`
- `backend/app/api/routers/leave_planning.py`
- `backend/tests/test_api/test_leave_planning.py`

**Edited**
- `backend/app/api/schemas/__init__.py`, `backend/app/api/main.py` — register

## C. Instructions

### `GET /leave-planning/coverage?from_date=&to_date=`

Read-only. Returns one entry per `(date, period)` across the requested weekday range:

```python
class CoverageSlotOut(BaseModel):
    date: datetime.date
    period: Period
    headcount: int
    is_closed: bool
```

Cap the range at 62 days and 422 beyond it (the grid asks for one month; the cap exists so
this cannot be used as an unbounded scan). Weekends are omitted from the response
entirely, not returned as zero — the grid has no weekend columns.

**The calculation**, per `(date, period)`, over Partner and Salaried doctors only
(Design Decision 2):

1. Skip the doctor if not `active`, or outside their window on that date
   (`is_within_window` from Task 1).
2. Look up their **template week 1** row for `(doctor_id, 1, day_of_week, period)` —
   Design Decision 1. Load these once, up front, into a dict keyed
   `(doctor_id, Day, Period)`; do not query per cell.
3. Apply the extra-session override (Design Decision 4) to get the *effective* session
   type. Reuse the same `_OVERRIDABLE_TYPES` frozenset the staging router defines, imported
   rather than redeclared, so the two cannot drift:
   - leave exists for the slot → not working, stop (leave wins, no override).
   - no extra session → effective type is the template type, or absent.
   - extra session and template type in `_OVERRIDABLE_TYPES` (or no row at all) →
     effective type is `REQUIRES_ROOM`.
   - extra session and template type is anything else → effective type is the template
     type, unchanged.
4. Count the doctor when the effective type is `REQUIRES_ROOM` or `PRE_ASSIGNED`
   (Design Decision 3), and there is no leave for the slot.

Then apply closures (Design Decision 5): a `(date, period)` in `PracticeClosure` returns
`is_closed=True` and `headcount=0`. Read closures live for the range in one query.

`day_of_week` comes from `date.weekday()` mapped through `week_map.DAY_ORDER` inverted —
add a small module-local `_DAY_BY_WEEKDAY` rather than reaching for a new shared helper.

Resolve the active template with `context._load_active_template`'s rule, not a bare
`is_active` filter: `GET /master-rota/active` orders by `id` and takes the first match
because `is_active` is not schema-enforced unique, and this endpoint must not 500 where
that one renders. Return an empty `headcount` of 0 for every slot if there is no active
template at all, rather than 404 — the grid should still render its leave cells.

### `POST /leave-planning/bulk`

```python
class PlanningActionIn(BaseModel):
    doctor_id: int
    date: datetime.date
    period: Period
    action: Literal["leave", "extra_session", "clear"]

class PlanningBulkIn(BaseModel):
    actions: list[PlanningActionIn] = Field(max_length=2000)

class PlanningBulkOut(BaseModel):
    applied: int
    skipped: list[PlanningSkippedOut]              # date, period, doctor_id, action, reason
    superseded_extra_sessions: list[ExtraSessionOut]
```

Apply per Design Decision 9, in one transaction:

1. **Validate up front.** 404 any unknown `doctor_id` (one query for the whole batch, not
   per action). 422 a weekend date — mirroring `POST /extra-sessions`' weekday rule, which
   applies to leave here too because the grid has no weekend cells and a weekend action can
   only be a client bug.
2. **Partition** the actions by kind and apply in order: clears, then leave, then extra
   sessions.
3. **Clears** delete both the `LeaveEntry` and the `ExtraSessionEntry` for the triple. A
   clear of a slot with neither is not an error — it counts toward `applied` as a no-op, or
   is skipped `"nothing_to_clear"`; pick one and be consistent. Do not restore draft rooms
   (Design Decision 10).
4. **Leave** inserts, skipping `"duplicate"` where a row already exists and
   `"outside_doctor_dates"` where the doctor is out of window. Collect every leave
   candidate — duplicates included — and pass the whole set to `_release_draft_rooms`,
   imported from `routers/leave.py`. This is the deliberate over-call documented there;
   do not optimise it down to inserted rows only.
5. **Extra sessions** insert, skipping `"duplicate"`, `"outside_doctor_dates"`, and
   `"leave_exists"` where leave exists for the slot *after* step 4 has run — so a batch
   that adds leave and an extra session to the same cell resolves deterministically in
   leave's favour.
6. **Report supersedes.** Query `ExtraSessionEntry` for every slot the batch's leave
   covers and return the rows in `superseded_extra_sessions`. Never delete them, never
   fail (Design Decision 9, mirroring `create_leave_bulk`).
7. `db.commit()` once, catching `IntegrityError` → 409 with the same
   "created concurrently; please retry" wording `create_leave_bulk` uses.

**Tests.** Coverage: a plain template week-1 headcount; leave reduces it; an extra session
on a `No surgery` slot increases it; an extra session on a slot that is already
`Requires room` does **not** increase it (Design Decision 4 — this is the one most likely
to be got wrong, so test it explicitly); `Admin time` and `WFH` do not count; a closed
`(date, period)` returns `is_closed` with zero; a half-day closure affects only its own
period; an out-of-window doctor is excluded on the dates outside the window and included
inside it; Trainee/Locum/AHP are never counted; 422 beyond the range cap; no active
template returns zeros rather than 500.

Bulk: a mixed batch applies atomically; leave and extra session on the same cell resolves
to leave with the extra session skipped `"leave_exists"`; a duplicate is skipped, not a
409; clear removes both rows; an out-of-window action is skipped, not fatal, and the rest
of the batch still applies; `superseded_extra_sessions` is populated and the rows still
exist afterwards; `_release_draft_rooms` fires (assert a draft session's `room_id` is
cleared, including for a duplicate-leave action); an unknown `doctor_id` 404s the whole
batch with nothing written.

---

# Task 4: `/leave-planning` frontend grid page

## A. State of the world

Tasks 1–3 are complete: the date window is enforced end to end and both `/leave-planning`
endpoints exist and are tested. This task adds the page, its API hooks, and the route. The
`DoctorsPage` form fields are Task 5.

## B. Files and deliverables

**New**
- `frontend/src/api/leavePlanning.ts`
- `frontend/src/routes/LeavePlanningPage.tsx`
- `frontend/src/routes/LeavePlanningPage.test.tsx`
- `frontend/src/components/LeavePlanningGrid.tsx`
- `frontend/src/components/LeavePlanningGrid.test.tsx`
- `frontend/src/lib/planningMonth.ts` + test

**Edited**
- `frontend/src/api/types.ts` — `CoverageSlot`, `PlanningAction`, `PlanningBulkIn/Out`; `start_date`/`end_date` on `Doctor`
- `frontend/src/App.tsx` — nav entry and route
- `frontend/test/msw/handlers.ts` — `/leave-planning` handlers

## C. Instructions

**`planningMonth.ts`** — a pure module, unit-tested independently of React, holding:

- `weekdaysInMonth(year, month): string[]` — the Mon–Fri date strings, built with the
  manual Y/M/D construction `lib/date.ts` mandates, never `new Date(dateString)`.
- `applyPendingToCoverage(coverage, pending, doctors, sessions)` — the client-side
  recomputation of the total row. This is the part that must not live in the component:
  it re-applies Design Decision 3 and 4's rules locally so the total updates without a
  round trip, and it has to agree with the server's calculation exactly. Test it against
  the same case matrix the backend test uses.

**Page.** `LeavePlanningPage` owns:

- A month selector (previous / next / month name), defaulting to the current month.
- `useDoctors(true)` filtered to `Partner`/`Salaried` **and** window-overlap with the
  displayed month — a doctor who leaves mid-month must still show for the part of the month
  they worked, so filter on overlap, not on "in window today". Order via
  `groupDoctors.ts`'s canonical order, as every other grid does.
- `useCoverage(fromDate, toDate)`, `useLeave()` and `useExtraSessions()` for the month, and
  `useClosures()` for the closed-cell rendering.
- The pending-edit `Map` keyed `` `${doctor_id}|${date}|${period}` `` → `"leave" | "extra_session" | "clear"`.
- Save (fires `useApplyPlanningBulk`, invalidates `leaveKeys.all`, `extraSessionKeys.all`
  and the coverage key on success) and Discard, both disabled when the map is empty. A
  navigation guard is out of scope; an unsaved-count badge next to Save is enough.

Surface the response's `skipped` and `superseded_extra_sessions` in the save summary,
worded as information rather than error — the save succeeded. Reuse `LeavePage`'s
`formSummary` pattern and its `errorDetail` helper.

**Grid.** `LeavePlanningGrid` renders the matrix: sticky doctor column, one column pair per
weekday date, AM/PM as split cells (`LeaveRangePreview` already does an AM/PM split cell —
copy its structure rather than inventing one). Cell click cycles
normal → leave → extra planned → normal, writing to the pending map; nothing fires an API
call until Save.

Cell state is the merge of server state and any pending edit for that key, computed at
render, so a pending edit and its underlying row never disagree. A cell that is closed, or
whose doctor is out of window on that date, renders inert with no cycle behaviour — the two
get visibly distinct treatments (closed reuses `RotaGrid`'s `bg-gray-200` closed style;
out-of-window is the plain absent grey), because confusing them would mislead.

The bottom total row renders `applyPendingToCoverage(...)`, with `—` for a closed slot.

**Tests.** The grid renders doctors and dates; clicking cycles a cell through the three
states without firing a request; the total row updates live as cells are toggled; Save
posts exactly the pending actions and clears the map; the skip/supersede summary renders;
closed and out-of-window cells are inert; Trainee/AHP doctors do not appear.

---

# Task 5: Doctor date fields on `DoctorsPage`

## A. State of the world

Tasks 1–4 are complete: the backend accepts and enforces the window, and the planning grid
consumes it. The only remaining gap is that there is no way to *set* a doctor's dates from
the UI.

## B. Files and deliverables

**Edited**
- `frontend/src/components/DoctorFormDialog.tsx` — two date inputs
- `frontend/src/lib/validation.ts` (or wherever `doctorSchema` lives) — the fields plus the ordering refinement
- `frontend/src/routes/DoctorsPage.tsx` — show the window in the table
- `frontend/src/components/DoctorFormDialog.test.tsx`, `DoctorsPage.test.tsx`

## C. Instructions

Two optional date inputs on `DoctorFormDialog`, labelled "Start date" and "End date" with
help text stating that blank means no limit. Extend the Zod `doctorSchema` with both as
optional strings and a `.refine` enforcing `start <= end` when both are present, mapped
onto the `end_date` field so the message renders next to the input the user most likely
needs to change. `mapValidationErrors` already handles the server's 422 coming back on the
same field names.

Add a "Works" column to the `DoctorsPage` table rendering the window compactly — `—` for
null/null, `from <date>`, `until <date>`, or `<date> – <date>`. Use `formatDateWithDay`'s
sibling short format from `lib/date`, not raw ISO strings.

One thing to note in passing: `DoctorsPage` is active-only with no show-inactive toggle and
no reactivate path (architecture.md, Reference Data Pages). A doctor with a past `end_date`
is still `active=True` and so still listed — which is correct, since the window and the
soft-delete are independent (Design Decision 6), but it does mean a leaver stays on the
page indefinitely unless separately deactivated. That is acceptable and deliberate; do not
add an auto-deactivate.

**Tests.** The dialog round-trips both dates on create and edit; blank submits null rather
than an empty string; the ordering refinement blocks a save client-side; the table renders
each of the four window shapes.

---

## Follow-up ticket to raise separately

**Flatten the master template to a single week, or anchor its 4-week cycle to the
calendar.** `template_start_week` is pinned to `1` by `RotaPage.tsx:136`, so a run shorter
than four weeks only ever generates template week 1. The seeded template genuinely varies
across weeks (`CL`, `Frances`, `AN` all have week-specific Thursdays), so those variations
are currently never generated. Design Decision 1 above makes the planning grid consistent
with that behaviour rather than papering over it, but the underlying question — does the
practice run a 4-week cycle or not — is unresolved and worth its own ticket.
