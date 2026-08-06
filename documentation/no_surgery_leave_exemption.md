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
- Tests for each, and a short entry in `documentation/architecture-clinical.md` under
  "Leave planning".

Three tasks: the shared template lookup (refactor), the rule (pure, unit-tested), the
endpoint (plumbing plus HTTP tests).

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
this **computation** order:

1. The date is a Saturday or Sunday → `weekend`.
2. The doctor has no template week-1 row for `(weekday, period)` → `no_template_row`.
3. That row's `session_type` is `NO_SURGERY` → `no_surgery`.
4. `(date, period)` is in `PracticeClosure` → `closed`.

Otherwise it is chargeable. `REQUIRES_ROOM`, `PRE_ASSIGNED`, `ADMIN_TIME` and `WFH` are all
chargeable — the doctor was due to be at work, whatever they were doing.

An order is needed at all because more than one reason can apply to one slot (a weekend has
no template row; a closure can land on a `NO_SURGERY` slot). Making the reasons mutually
exclusive by a fixed precedence is what lets the four counts sum to `exempt` and be displayed
as a breakdown.

**Closure is checked last, deliberately.** The obvious ordering is most-external-fact-first
— "Easter Monday" explains an exemption to an admin better than "no template row" does — and
that is how the fields are *ordered for display* in `LeaveExemptionsOut`. But computing in
that order collapses two different facts into one bucket: *the practice shut on a day this
doctor would have worked* and *the practice shut on a day they were not working anyway*.

Only the first is doctor-specific, and it is the standard denominator for pro-rata bank
holiday entitlement for part-time staff — exactly the number the entitlement ticket
(Decision 7) will need. The second is derivable from the `practice_closures` table alone,
without this endpoint. So checking closure last yields strictly more information for the
same four buckets and the same sum: `closed` becomes "would have worked, but the practice was
shut", and `no_surgery` / `no_template_row` keep their plain meaning.

Display order and computation order are therefore **decoupled on purpose**, and the schema
docstring must say so — otherwise the next reader will "fix" the mismatch and silently
destroy the pro-rata number.

Closures are half-day granular (`PracticeClosure` is keyed `(date, period)`, migration 016),
so a half-day closure exempts only its own period. Closures cannot fall on a weekend
(`routers/closures.py` rejects weekend dates), so the weekend-vs-closed ordering is not
reachable in practice; it is fixed anyway so the function is total.

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
resolving the active template. That moves to `app/master_template.py` and both callers import
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

### 3b. Why these modules sit top-level under `app/`

`app/master_template.py` and `app/leave_charging.py` go top-level, next to
`app/doctor_window.py` — but **not** for `doctor_window.py`'s reason, and the distinction
matters because the convention is documented and otherwise erodes.

`doctor_window.py` is top-level because *the engine imports it*, and `engine/` importing from
`api/` would invert the layering (its own module docstring and
`architecture-clinical.md`'s "doctor employment window" paragraph both say exactly this).
Neither module here is engine-facing; nothing under `engine/` will import either. They are
top-level for a weaker but sufficient reason: **pure logic shared by two routers**, which has
nowhere else to live given there is no services layer. Say that in their docstrings rather
than gesturing at the `doctor_window.py` precedent, which does not apply.

Name: **`master_template.py`, not `template_week.py`**. `app/engine/week_map.py` already
exports a function called `template_week(gen_week, start_week)` (used in `grid_utils.py`), and
a module of that name three directories away would make `from ...engine.week_map import
template_week` and `from ...template_week import load_week_one_template` coexist in the same
codebase.

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

### 6b. `no_template_row` is a silent under-count, and stays a separate bucket for that reason

To the engine, a missing template row and a `NO_SURGERY` row are the same thing:
`grid_utils.py`'s rebuild falls back to `NO_SURGERY` when the active template has no row for
a slot. Both are exempt here too, so splitting them changes no total. They are kept as **two
buckets purely as a diagnostic**, and that has to be written down or someone will merge them.

The failure they distinguish is real. The master rota write surface is single-slot
create/delete — "master rota bulk row operations" is still an open task in
`architecture.md` — so a doctor added through the frontend whose template has not been
populated yet has *no* week-1 rows. Every one of their leave slots then reports exempt,
`no_template_row`, and the endpoint returns `chargeable_sessions: 0` with a 200 and no warning
anywhere. That is indistinguishable, from the total alone, from a doctor who genuinely worked
none of those slots.

Two consequences, both binding on later work:

- The follow-up frontend ticket **must surface `no_template_row` distinctly**, not fold it
  into a single "exempt" figure. A large `no_template_row` count means "the template is
  incomplete", not "this doctor was not due in".
- Nothing here should be changed to 404 or 422 on an unpopulated template. Returning the
  honest breakdown is the right behaviour; making it *loud* is the UI's job.

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

The range cap **reuses `MAX_BULK_RANGE_DAYS = 366`**, already in `schemas/leave.py` and
already justified there as a leave year. The coverage endpoint's
`MAX_COVERAGE_RANGE_DAYS = 62` is wrong for this caller — the natural call is a whole leave
year, so the first real caller would hit it — but inventing a third cap (the provisional 400)
in a module that already has one for the same stated reason invites "which one applies
here?". If 366 ever proves too tight, widen the existing constant rather than adding a
sibling.

**Counts are in sessions, not days**, and the wire field names must say so:
`chargeable_sessions` and `exempt_sessions`, not bare `chargeable` / `exempt`. Decision 7's
whole point is that entitlement has to be expressed in the same unit this rule counts in;
shipping an unlabelled integer is how that goes wrong. `total_entries` already names its own
unit (one `LeaveEntry` row = one half-day session) and stays as it is.

---

# Task 1: Extract the week-1 template lookup

## A. State of the world

Nothing has been built. This task is a pure refactor with no behaviour change: it moves an
existing private helper out of a router so a second caller (Task 2) can use it. The existing
`tests/test_api/test_leave_planning.py` is the proof of correctness and must pass unchanged.

## B. Files and deliverables

**New**
- `backend/app/master_template.py`

**Edited**
- `backend/app/api/routers/leave_planning.py` — delete the local helper and the local
  weekday map, import both

## C. Instructions

Create `backend/app/master_template.py`, top-level under `app/`. **Not** `template_week.py`:
`app/engine/week_map.py` already exports a `template_week()` function and the collision would
be permanent (Decision 3b). The module docstring should say it holds pure logic shared by two
routers — do **not** copy `doctor_window.py`'s "the engine imports it too" rationale, which
is not true of this module (Decision 3b again).

Move two things into it, verbatim including their docstrings:

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

Also export `WEEKDAY_MAX = 4` from the new module. `_WEEKDAY_MAX = 4` is already defined
identically in both `routers/leave.py` and `routers/leave_planning.py`, and Task 2 would make
a third copy; one public constant next to the weekday map it belongs with stops that. Repoint
both routers' local definitions at it. This is the only addition to an otherwise
move-only task — it is a constant, not behaviour, so `test_leave_planning.py` still proves
the refactor.

Update the module docstring's reference if it names the local helper.

**Tests.** No new tests. `uv run pytest tests/test_api/test_leave_planning.py` must pass
unchanged — it already covers the no-active-template and two-active-templates cases through
the coverage endpoint (`test_no_active_template_returns_zeros`,
`test_two_active_templates_resolve_to_lowest_id`), which is the behaviour being moved.

---

# Task 2: The chargeability rule

## A. State of the world

Task 1 is complete: `app/master_template.py` exposes `load_week_one_template`,
`DAY_BY_WEEKDAY` and `WEEKDAY_MAX`, and `GET /leave-planning/coverage` imports them with no
behaviour change.

This task adds the **pure rule only** — no schema, no router, no HTTP. Task 3 wires it to an
endpoint. The split is deliberate: the rule is the part with the design decisions in it and
carries most of the test matrix, while the endpoint is plumbing. Keeping them apart also
keeps each task inside one chat's context, and proves the rule is genuinely testable without
a `TestClient` (Decision 3).

## B. Files and deliverables

**New**
- `backend/app/leave_charging.py` — the pure rule and summariser
- `backend/tests/test_engine/test_leave_charging.py` — unit tests, no HTTP

Nothing else is edited. `app/leave_charging.py` is imported by nothing until Task 3.

Test placement note: these are pure-function tests with no app fixture, so they sit under
`tests/test_engine/` (the suite's home for non-HTTP tests) rather than `tests/test_api/`,
despite the module living outside `engine/`. If that reads oddly to whoever picks this up,
`tests/test_leave_charging.py` at the top level is equally acceptable — what matters is that
it needs no `client` fixture.

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
compared nowhere but here. Declare them in **computation-precedence order** (Decision 1) and
say in a comment that `LeaveExemptionsOut` deliberately orders its fields differently, so the
mismatch reads as intentional from either end.

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

The weekend branch is an **explicit early return** on `day.weekday() > WEEKDAY_MAX`, placed
before any use of `DAY_BY_WEEKDAY`. This is not defensive padding: `POST /leave` is not weekday-filtered
(only `/leave/bulk` and `/leave-planning/bulk` are), and `leave_consolidation.md` Decision 2
records that stray weekend rows are representable and must be handled. Indexing
`DAY_BY_WEEKDAY` with a Saturday would `KeyError` into a 500.

```python
@dataclass(frozen=True)
class ChargingSummary:
    total_entries: int
    chargeable_sessions: int
    exempt_by_reason: dict[str, int]   # all four keys always present, zeros included

def summarise_leave_charging(entries, template, closed) -> ChargingSummary:
```

A `dataclass`, not a pydantic model — `app/` stays free of API schema types, and the router
maps it across. `entries` is any iterable of `LeaveEntry`; importing the model here is fine
(`app/models` is a peer, no cycle — unlike `doctor_window.py`, which used a `Protocol` only
to avoid one). Always emit all four reason keys so a caller never has to `.get(..., 0)`, and
so `sum(exempt_by_reason.values()) + chargeable_sessions == total_entries` holds
unconditionally — worth an assertion in the tests.

`summarise_leave_charging` reads `doctor_id` off each entry and never takes one as a
parameter, so a mixed-doctor iterable summarises correctly with no change. That is the
property Decision 8 relies on for the later register view, so it is asserted by a test rather
than left as a claim.

### Tests (`backend/tests/test_engine/test_leave_charging.py`)

Pure-function tests: build the `template` dict and `closed` set as literals and pass plain
`LeaveEntry(...)` instances (unsaved objects are fine — nothing here touches a session). No
`client`, no `seeded`, no DB.

**The rule, one case each:**
- `REQUIRES_ROOM` → chargeable. `PRE_ASSIGNED` → chargeable.
- `ADMIN_TIME` → chargeable. **This is the one most likely to be "fixed" into agreement with
  coverage later** — assert it explicitly and name Design Decision 2 in the docstring.
- `WFH` → chargeable.
- `NO_SURGERY` → `no_surgery`. Missing template key → `no_template_row`.
- Saturday and Sunday → `weekend`, taken before any `DAY_BY_WEEKDAY` lookup.

**Precedence (Decision 1's computation order):**
- Closure on a would-have-worked slot → `closed`.
- Closure on a `NO_SURGERY` slot → **`no_surgery`, not `closed`** — this is the reversal from
  the provisional plan, and the test docstring must say why: `closed` has to mean "would have
  worked but the practice shut" for the entitlement ticket's pro-rata number to be
  recoverable.
- Closure on a slot with no template row → `no_template_row`, same reasoning.
- Half-day closure → only its own period is exempt.

**Invariants:**
- `chargeable_sessions + sum(exempt_by_reason.values()) == total_entries` over a mixed list.
- All four reason keys present with zeros when nothing is exempt.
- Empty iterable → all zeros, no `KeyError`.
- **Mixed-doctor list** summarises per-entry against a two-doctor template map (the
  Decision 8 property above).

`uv run pytest tests/test_engine/test_leave_charging.py`.

---

# Task 3: The count endpoint

## A. State of the world

Tasks 1 and 2 are complete: `app/master_template.py` holds the shared template lookup, and
`app/leave_charging.py` holds `exemption_reason` / `summarise_leave_charging` with unit tests
covering the whole rule. Nothing imports `leave_charging` yet.

This task exposes it over HTTP. No migration, no change to any write path, no frontend.

## B. Files and deliverables

**New**
- `backend/tests/test_api/test_leave_charging_endpoint.py`

**Edited**
- `backend/app/api/schemas/leave.py` — the response models
- `backend/app/api/routers/leave.py` — the endpoint
- `backend/app/api/schemas/__init__.py` — export the new models
- `documentation/architecture-clinical.md` — a short entry under "Leave planning"

## C. Instructions

### Schemas (`app/api/schemas/leave.py`)

No new range constant — reuse the existing `MAX_BULK_RANGE_DAYS = 366` already at the top of
this module (Decision 8).

```python
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
    chargeable_sessions: int
    exempt_sessions: int
    exempt_by_reason: LeaveExemptionsOut
```

`exempt_sessions` is redundant with the breakdown's sum and is returned anyway: it is the
number the caller actually wants, and making them sum four fields to get it invites a
client-side bug. The `_sessions` suffixes are load-bearing — Decision 8's unit note.

The `LeaveExemptionsOut` docstring must state that **field order is display order and is
deliberately not the computation order** (Decision 1): closure is checked *last*, so `closed`
means "the doctor would have worked this slot but the practice was shut", not "this slot fell
on a closure". Without that line the two orders look like a bug and someone will align them.

Export both from `schemas/__init__.py` alongside the other leave models.

### `GET /leave/chargeable-count` (`app/api/routers/leave.py`)

Query params `doctor_id: int`, `from_date: datetime.date`, `to_date: datetime.date`, all
required. Handler order:

1. 404 an unknown `doctor_id`, matching `create_leave`'s wording exactly
   (`f"Doctor {doctor_id} not found"`). Use **`db.get(Doctor, doctor_id)`**, not a query
   filtered on `Doctor.active` — an inactive doctor's historical leave is still historical
   leave (Decision 6), and an active filter here would 404 it. There is a test for exactly
   this below, because the wrong version looks perfectly reasonable in review.
2. 422 `from_date > to_date`, reusing `get_coverage`'s detail string
   (`"from_date must not be after to_date"`).
3. 422 when `(to_date - from_date).days > MAX_BULK_RANGE_DAYS`, matching `get_coverage`'s
   message shape.
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
and why, that closure is the *last* precedence check so `closed` means "would have worked but
the practice shut", and that the count is read-time. Four or five sentences — the plan
document holds the reasoning, the architecture doc just needs to point at it.

Also update the `/leave` row of that document's router-surface table, which currently lists
the endpoints on this router.

### Tests (`backend/tests/test_api/test_leave_charging_endpoint.py`)

Task 2's unit tests own the rule's case matrix; **do not repeat it here**. These tests cover
wiring, queries, and HTTP behaviour only.

Follow `test_leave_planning.py`'s structure: its `seeded` fixture (doctors AA/BB, an active
template, `REQUIRES_ROOM` Monday AM+PM for both — so Tue–Fri are naturally `no_template_row`),
and its `_add_template_row` / `_set_template_type` helpers (copy them rather than importing
across test modules, matching the existing convention).

**Wiring — one end-to-end pass of each reason,** enough to prove the three loads reach the
rule, not to re-test it:
- A `REQUIRES_ROOM` Monday with leave → `chargeable_sessions` counts it.
- A `NO_SURGERY` Monday → `no_surgery`; a Tuesday → `no_template_row`.
- A full-day closure on a would-have-worked Monday → `closed` for both periods (proves the
  `PracticeClosure` query and its `(date, period)` keying).
- Weekend entry created via `POST /leave` (not `/leave/bulk`, which filters weekends) →
  **200** with reason `weekend`. Assert the status code specifically: the failure mode being
  guarded is an unhandled `KeyError` surfacing as a 500.

**Query scoping — the part only an endpoint test can catch:**
- Leave for another doctor in range is not counted.
- Entries outside the range are not counted; both boundaries are inclusive.
- A `BlockedEntry` and an `ExtraSessionEntry` in range change nothing.
- No leave in range → all zeros, 200.
- No active template → every entry `no_template_row`, 200 — not a 500 or a 404.
- `chargeable_sessions + sum(exempt_by_reason.values()) == total_entries` on a mixed range.

**Decisions 4 and 6 made observable:**
- Flip the template from `REQUIRES_ROOM` to `NO_SURGERY` *after* the leave exists and
  re-query: the count drops. This is the read-time property, and the test docstring should
  say it is deliberate and note the cost recorded in Decision 4.
- Move the doctor's `end_date` to before the leave dates and re-query: the count is
  unchanged (Decision 6 — the window gates creation, not counting).
- **Set `doctor.active = False` and re-query: 200, count unchanged.** The other half of
  Decision 6, and the test that catches an `active`-filtered doctor lookup in the handler —
  which is the natural thing to write and is wrong.

**Errors:** unknown doctor → 404; reversed range → 422; range over `MAX_BULK_RANGE_DAYS` →
422; range exactly at the cap → 200.

Run `uv run pytest tests/test_api/test_leave_charging_endpoint.py tests/test_engine/test_leave_charging.py tests/test_api/test_leave_planning.py`
— the last because Task 1's refactor is the foundation this sits on.

---

## Follow-up tickets to raise separately

1. ~~**Leave entitlement and balances.** Owns both questions in Design Decision 7.~~ **Shipped**
   (migration 026, `app/leave_entitlement.py`, `routers/leave_entitlement.py`,
   `LeaveEntitlementBalances.tsx`; see "Leave entitlement" in
   `documentation/architecture-clinical.md`). Decision 7.2 was resolved by keeping
   `sessions_per_week` authoritative and *reporting* the template's disagreement rather than
   picking a side. Decision 7.1 is only half-answered: usage is still read-time, but the
   entitlement side is now pinnable with a stored override, so a wrong balance can be corrected
   without snapshotting everything. Freezing usage at year close remains open. That ticket also
   subsumed (2) below, since a balance needs the used figure on screen anyway — including
   `no_template_row` shown distinctly, as Decision 6b requires.
2. **A frontend surface for the count** — a total on `LeavePage`'s block rows, or a leave
   register. Blocked on (1) for anything showing a *remaining* balance; a *used* total could
   ship without it. Whatever it renders, it **must show `no_template_row` distinctly** rather
   than a single "exempt" figure — see Decision 6b, where that bucket is the only signal that
   a doctor's master template was never populated.
3. **Anchor the 4-week template cycle to the calendar** — already raised at the foot of
   `annual_leave_planning.md`, unchanged by this ticket but the thing that would make the
   exemption exact for doctors whose pattern varies by week.
