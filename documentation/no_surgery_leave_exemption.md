# Implementation Plan — No-surgery leave exemption

## Plan

`LeaveEntry` is a bare `(doctor_id, date, period)` marker with no notion of "chargeable" vs
"free". Booking a week of leave writes a row for every AM/PM slot in the range, including
slots the doctor was never working — `NO_SURGERY` on their template, no template row at
all, or a practice closure. Before leave tracking can go live, the app needs to be able to
say how many of those booked sessions actually count.

This ticket adds that computation and a read-only endpoint exposing it. Entry-time
behaviour, the data model, and the frontend are all untouched.

## Scope

**In scope**

- Extracting the week-1 template lookup out of `routers/leave_planning.py` into a shared
  module, and repointing the coverage endpoint at it (pure refactor, no behaviour change).
- A pure chargeability function over that map plus the closure set, returning *why* a slot
  is exempt rather than a bare boolean.
- `GET /leave/chargeable-count?doctor_id=&from_date=&to_date=`, returning the totals and an
  exemption breakdown. Backend only.
- Tests for both, and a short entry in `documentation/architecture-clinical.md` under
  "Leave planning".

**Out of scope**

- **Entitlement/allowance modelling.** Deferred to its own ticket. See Design Decision 7
  for the two questions that ticket inherits.
- **Any frontend surface.** No `LeavePage` total, no leave register. Follow-up ticket.
- **`LeaveEntry` creation.** `POST /leave`, `/leave/bulk` and `/leave-planning/bulk` keep
  writing one row per slot in the range, no-surgery slots included (Design Decision 4).
  No schema change, no migration.
- **`BlockedEntry`.** Blocked is deliberately not leave (`routers/leave_planning.py`
  module docstring) and never enters this count. Stated here so nobody adds it later on
  the grounds that it "looks like an absence".
- **Anchoring the 4-week template cycle to the calendar.** Unchanged by this ticket, which
  reuses the existing week-1 simplification. Still the open follow-up recorded at the foot
  of `annual_leave_planning.md`.

---

## Design Decisions

### 1. The exemption rule

A leave slot is **exempt** (not chargeable) when any of the following holds, checked in
this order:

1. `(date, period)` is in `PracticeClosure` → `closed`.
2. The date is a Saturday or Sunday → `weekend`.
3. The doctor has no template week-1 row for `(weekday, period)` → `no_template_row`.
4. That row's `session_type` is `NO_SURGERY` → `no_surgery`.

Otherwise it is chargeable. `REQUIRES_ROOM`, `PRE_ASSIGNED`, `ADMIN_TIME` and `WFH` are all
chargeable — the doctor was due to be at work, whatever they were doing.

The order matters because more than one reason can apply at once (a weekend has no template
row; a closure can land on a `NO_SURGERY` slot). Making the reasons mutually exclusive by a
fixed precedence is what lets the four counts sum to `exempt` and be displayed as a
breakdown. The order runs most-external-fact-first: "Easter Monday" explains an exemption to
an admin better than "no template row" does.

Closures are half-day granular (`PracticeClosure` is keyed `(date, period)`, migration 016),
so a half-day closure exempts only its own period.

### 2. Coverage and charging are different predicates, sharing only the template lookup

This corrects the provisional plan, which proposed one shared `is_chargeable_leave_slot`
imported by both this feature and `GET /leave-planning/coverage` "so the two definitions of
working can't drift apart".

They are not the same definition and must not become one. Coverage counts a doctor only when
their effective session type is `REQUIRES_ROOM` or `PRE_ASSIGNED` (`_COUNTED_TYPES`,
`routers/leave_planning.py`); `ADMIN_TIME` and `WFH` count as zero there. Under Decision 1
those same two are chargeable. Sharing a predicate would make the planning grid count admin
sessions as clinical cover.

The two questions are genuinely different:

- **Coverage** asks *is there a clinician available to see patients in this slot.*
- **Charging** asks *was this doctor due to be at work in this slot.*

What is shared is the **week-1 template map** — one query, one dict, one set of rules about
resolving the active template. That moves to `app/template_week.py` and both callers import
it. Decision 2 in `annual_leave_planning.md` (week 1 stands in for every calendar week) is
inherited unchanged, along with its known inaccuracy: a doctor whose `NO_SURGERY` slots vary
across the 4-week cycle is charged on their week-1 pattern. Accepted, and it self-corrects
when the cycle is anchored, because the count is computed at read time (Decision 4).

### 3. The predicate is pure and takes pre-loaded state

`is_chargeable_leave_slot(doctor_id, day, period)` — the provisional signature — implies a
DB query per slot. A year of leave is ~50 slots for one doctor and thousands across the
practice for the register view this is meant to enable.

So the template map and the closure set are loaded once per request and passed in, exactly
as `get_coverage` already does. The unit under test is a pure function over three
dictionaries and a `LeaveEntry` list.

### 4. Chargeability is computed at read time, never stored

No column on `LeaveEntry`, no computation at write time. The rule depends on the master
template and on `PracticeClosure`, both of which are live, editable tables; baking the
answer into the row at booking time would leave stale rows asserting a pattern the practice
no longer works.

**The honest cost**, which the provisional plan framed only as an advantage: read-time means
a historical total *changes* when the template changes. Edit a partner's Thursday from
`NO_SURGERY` to a clinic and last year's used-leave figure silently goes up. That is
harmless while nothing depends on the number, and unacceptable the moment a balance is shown
to a doctor. It is the right call *now* — there is no entitlement model to snapshot against
— and it is recorded in Decision 7 as something the entitlement ticket must resolve, not as
a solved problem.

### 5. Entry-time behaviour is unchanged

Booking a block still writes a `LeaveEntry` for every slot in the range. Blocking or
filtering no-surgery slots at entry time would make whole-week bookings cumbersome and
would destroy the record of what was requested. The row records intent; the count
interprets it.

### 6. What the rule deliberately does *not* consider

- **The doctor's employment window.** `is_within_window` gates *creation*
  (`annual_leave_planning.md` Decision 8), not counting. A window can be edited after
  entries exist; an entry that was booked stays booked and stays counted. Written down
  because the temptation to add it is obvious and it would be wrong.
- **`doctor.active`.** Same reasoning — a soft-deleted doctor's historical leave is still
  historical leave.
- **`BlockedEntry` and `ExtraSessionEntry`.** Neither is leave. An extra session on a slot
  the doctor also booked leave for is already reported as superseded by the write
  endpoints; it does not make the leave more or less chargeable.

### 7. Two questions this hands to the entitlement ticket

Recorded here so they are not rediscovered later:

1. **Read-time vs. snapshot.** Decision 4's cost. Likely answers: freeze the total at
   leave-year close, or start storing chargeability on the row once an entitlement exists to
   check it against.
2. **`sessions_per_week` is a second source of truth.** `Doctor.sessions_per_week`
   (`Numeric(4,1)`) already exists and is used for duty weighting. Once this rule ships, the
   template *also* implies a weekly working-session count — the number of non-`NO_SURGERY`
   week-1 rows — and the two need not agree. For charging, the **template is authoritative**;
   `sessions_per_week` stays a duty-weighting input. If entitlement is later expressed as
   "N weeks × their working sessions", it must use the same denominator this rule uses, or a
   doctor will be charged in one unit and credited in another. Counting `ADMIN_TIME` as
   chargeable is coherent only under that condition.

### 8. Surface: one read-only endpoint on `/leave`

`GET /leave/chargeable-count`, on the existing leave router rather than a new one —
`/leave` is the ad-hoc, per-doctor path and this is a per-doctor question.
`/leave-planning` owns the planning grid and has no business with it.

`doctor_id` is required. The multi-doctor register view is a follow-up whose response shape
is unknowable until its UI is designed; the summarising function is written to take an
arbitrary set of leave rows, so serving all doctors later needs no change to it.

The range cap is **400 days**, not the coverage endpoint's `MAX_COVERAGE_RANGE_DAYS = 62`.
The natural call here is a whole leave year; reusing 62 would mean the first real caller
hits the cap.

---

# Task 1: Extract the week-1 template lookup

## A. State of the world

Nothing has been built. This task is a pure refactor with no behaviour change: it moves an
existing private helper out of a router so a second caller (Task 2) can use it. The existing
`tests/test_api/test_leave_planning.py` is the proof of correctness and must pass unchanged.

## B. Files and deliverables

**New**
- `backend/app/template_week.py`

**Edited**
- `backend/app/api/routers/leave_planning.py` — delete the local helper and the local
  weekday map, import both

## C. Instructions

Create `backend/app/template_week.py`, top-level under `app/` following the
`app/doctor_window.py` precedent (importable from any layer, no router import cycle). Move
two things into it, verbatim including their docstrings:

- `DAY_BY_WEEKDAY: dict[int, Day]` — currently `_DAY_BY_WEEKDAY` in `leave_planning.py`.
  Public now, since two modules need it. Keep it a Mon–Fri-only mapping; do **not** widen it
  to cover weekends. Task 2's weekend case is handled by an explicit branch, not by a
  lookup that silently succeeds.
- `load_week_one_template(db) -> dict[tuple[int, Day, Period], MasterSessionType]` —
  currently `_week_one_template`. Its docstring already records both the week-1
  simplification and the lowest-id active-template resolution; carry it across unedited and
  add one line noting it now serves leave charging as well as coverage.

In `leave_planning.py`, delete both definitions and import them. `get_coverage`'s body
changes only in the two names it calls. Nothing else in that module moves —
`_COUNTED_TYPES`, `_PLANNING_DOCTOR_TYPES`, `_slot_keys` and `_weekdays` are coverage-specific
and stay put. In particular do **not** move `_COUNTED_TYPES`: Design Decision 2 turns on the
two predicates being separate, and co-locating them invites exactly the merge it warns
against.

Update the module docstring's reference if it names the local helper.

**Tests.** No new tests. `uv run pytest tests/test_api/test_leave_planning.py` must pass
unchanged — it already covers the no-active-template and two-active-templates cases through
the coverage endpoint (`test_no_active_template_returns_zeros`,
`test_two_active_templates_resolve_to_lowest_id`), which is the behaviour being moved.

---

# Task 2: Chargeability rule and the count endpoint

## A. State of the world

Task 1 is complete: `app/template_week.py` exposes `load_week_one_template` and
`DAY_BY_WEEKDAY`, and `GET /leave-planning/coverage` imports them with no behaviour change.
This task adds the chargeability rule and the endpoint that exposes it. No frontend code,
no migration, no change to any write path.

## B. Files and deliverables

**New**
- `backend/app/leave_charging.py` — the pure rule and summariser
- `backend/tests/test_api/test_leave_charging.py`

**Edited**
- `backend/app/api/schemas/leave.py` — the response models and the range cap
- `backend/app/api/routers/leave.py` — the endpoint
- `backend/app/api/schemas/__init__.py` — export the new models
- `documentation/architecture-clinical.md` — a short entry under "Leave planning"

## C. Instructions

### `app/leave_charging.py`

Module docstring: state Decision 1's rule and its precedence, state Decision 2's
"coverage asks a different question" in one sentence with a pointer to `_COUNTED_TYPES`, and
state Decision 4's read-time property. This module is where a future reader will look first.

```python
EXEMPT_CLOSED = "closed"
EXEMPT_WEEKEND = "weekend"
EXEMPT_NO_TEMPLATE_ROW = "no_template_row"
EXEMPT_NO_SURGERY = "no_surgery"
```

Plain string constants rather than an enum: they are wire values in the response and are
compared nowhere but here.

```python
def exemption_reason(
    doctor_id: int,
    day: datetime.date,
    period: Period,
    template: Mapping[tuple[int, Day, Period], MasterSessionType],
    closed: Container[tuple[datetime.date, Period]],
) -> str | None:
```

Returns `None` when the slot is chargeable, otherwise the reason. One function serves both
the boolean question and the breakdown — do not add a separate `is_chargeable`.

The weekend branch is an **explicit early return** on `day.weekday() > 4`, placed before any
use of `DAY_BY_WEEKDAY`. This is not defensive padding: `POST /leave` is not weekday-filtered
(only `/leave/bulk` and `/leave-planning/bulk` are), and `leave_consolidation.md` Decision 2
records that stray weekend rows are representable and must be handled. Indexing
`DAY_BY_WEEKDAY` with a Saturday would `KeyError` into a 500.

```python
@dataclass(frozen=True)
class ChargingSummary:
    total_entries: int
    chargeable: int
    exempt_by_reason: dict[str, int]   # all four keys always present, zeros included

def summarise_leave_charging(entries, template, closed) -> ChargingSummary:
```

A `dataclass`, not a pydantic model — `app/` stays free of API schema types, and the router
maps it across. `entries` is any iterable of `LeaveEntry`; importing the model here is fine
(`app/models` is a peer, no cycle — unlike `doctor_window.py`, which used a `Protocol` only
to avoid one). Always emit all four reason keys so a caller never has to `.get(..., 0)`, and
so `sum(exempt_by_reason.values()) + chargeable == total_entries` holds unconditionally —
worth an assertion in the tests.

### Schemas (`app/api/schemas/leave.py`)

```python
MAX_CHARGEABLE_RANGE_DAYS = 400   # a leave year plus slack; see Design Decision 8

class LeaveExemptionsOut(BaseModel):
    closed: int
    weekend: int
    no_template_row: int
    no_surgery: int

class LeaveChargeableCountOut(BaseModel):
    doctor_id: int
    from_date: datetime.date
    to_date: datetime.date
    total_entries: int
    chargeable: int
    exempt: int
    exempt_by_reason: LeaveExemptionsOut
```

`exempt` is redundant with the breakdown's sum and is returned anyway: it is the number the
caller actually wants, and making them sum four fields to get it invites a client-side bug.
Document the field-order-equals-precedence-order relationship in the `LeaveExemptionsOut`
docstring.

Export both from `schemas/__init__.py` alongside the other leave models.

### `GET /leave/chargeable-count` (`app/api/routers/leave.py`)

Query params `doctor_id: int`, `from_date: datetime.date`, `to_date: datetime.date`, all
required. Handler order:

1. 404 an unknown `doctor_id`, matching `create_leave`'s wording exactly
   (`f"Doctor {doctor_id} not found"`).
2. 422 `from_date > to_date`, reusing `get_coverage`'s detail string
   (`"from_date must not be after to_date"`).
3. 422 when `(to_date - from_date).days > MAX_CHARGEABLE_RANGE_DAYS`, matching
   `get_coverage`'s message shape.
4. Three queries, no per-slot lookups: the doctor's `LeaveEntry` rows in range;
   `load_week_one_template(db)`; the `PracticeClosure` `(date, period)` set in range.
5. `summarise_leave_charging(...)`, then map to `LeaveChargeableCountOut`.

Place it above `DELETE /leave/{leave_id}` in the file for readability. There is no other
`GET` under `/leave` with a path parameter, so no route-ordering hazard exists — but keep it
above the parameterised route anyway so one is never introduced.

Add it to the router's module docstring, which currently lists the endpoints by milestone.

### Documentation

Add a short paragraph to `documentation/architecture-clinical.md` under "Leave planning":
where the rule lives, that coverage and charging deliberately differ on `ADMIN_TIME`/`WFH`
and why, and that the count is read-time. Three or four sentences — the plan document holds
the reasoning, the architecture doc just needs to point at it.

### Tests (`backend/tests/test_api/test_leave_charging.py`)

Follow `test_leave_planning.py`'s structure: its `seeded` fixture, its `_add_template_row` /
`_set_template_type` helpers (copy them rather than importing across test modules, matching
the existing convention).

**The rule, one test each:**
- `REQUIRES_ROOM` slot with leave → chargeable, no exemptions.
- `PRE_ASSIGNED` → chargeable.
- `ADMIN_TIME` → chargeable. **This is the one most likely to be "fixed" into agreement
  with coverage later** — assert it explicitly and name Design Decision 2 in the test
  docstring.
- `WFH` → chargeable.
- `NO_SURGERY` → exempt, reason `no_surgery`.
- No template row for the slot → exempt, reason `no_template_row`.

**Precedence (the reason must be the outer fact, and counted once):**
- Full-day closure over two chargeable slots → both exempt, reason `closed`.
- Half-day closure → only its own period exempt; the other stays chargeable.
- Closure landing on a `NO_SURGERY` slot → exempt once, reason `closed`, not double-counted.
- Weekend entry created via `POST /leave` (not `/leave/bulk`, which filters weekends) →
  200 with reason `weekend`, **not a 500**. Assert the status code, since the failure mode
  being guarded is an unhandled `KeyError`.

**Invariants and edges:**
- `chargeable + sum(exempt_by_reason.values()) == total_entries` in a mixed fixture.
- No leave in range → all zeros, 200.
- No active template → every entry exempt as `no_template_row`, not a 500 or a 404.
- A `BlockedEntry` and an `ExtraSessionEntry` in range change nothing.
- Leave for another doctor in range is not counted.
- Entries outside the range are not counted (boundaries inclusive at both ends).

**Decisions 4 and 6 made observable:**
- Flip the template from `REQUIRES_ROOM` to `NO_SURGERY` *after* the leave exists and
  re-query: the count drops. This is the read-time property, and the test docstring should
  say it is deliberate and note the cost recorded in Decision 4.
- Move the doctor's `end_date` to before the leave dates and re-query: the count is
  unchanged (Decision 6 — the window gates creation, not counting).

**Errors:** unknown doctor → 404; reversed range → 422; range over the cap → 422; range
exactly at the cap → 200.

Run `uv run pytest tests/test_api/test_leave_charging.py tests/test_api/test_leave_planning.py`
— the second because Task 1's refactor is the foundation this sits on.

---

## Follow-up tickets to raise separately

1. **Leave entitlement and balances.** Owns both questions in Design Decision 7.
2. **A frontend surface for the count** — a total on `LeavePage`'s block rows, or a leave
   register. Blocked on (1) for anything showing a *remaining* balance; a *used* total could
   ship without it.
3. **Anchor the 4-week template cycle to the calendar** — already raised at the foot of
   `annual_leave_planning.md`, unchanged by this ticket but the thing that would make the
   exemption exact for doctors whose pattern varies by week.
