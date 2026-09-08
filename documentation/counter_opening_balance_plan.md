# Provisional plan: counter opening balances (mid-year joiners)

Status: **provisional**. Written in the discussion phase — it needs the
review pass (step 2 of the CLAUDE.md workflow) before it becomes an
implementation plan. The open questions at the end are the things that
review has to settle.

## Problem

A doctor who joins part-way through the year starts every counter at zero.
Because the fairness score is `raw_count / sessions_per_week`, a zero raw
count reads as "maximally under-loaded", so the joiner is preferred for
allocation until they have absorbed a full year's worth of work in the
months they have actually been present.

Where this bites, in increasing order of consequence:

- **Duty page** (`DutyGrid`) — display only. Duty is planned by hand; the
  bolded lowest annual weighted score is a hint to whoever is filling the
  week in, not an automatic allocation. A wrong hint means the planner is
  nudged towards the new starter for weeks.
- **Clinic and system counters** — the engine actually consumes these.
  `CounterState.weighted_clinic_score` / `weighted_system_score`
  (`backend/app/engine/datatypes.py:245`) drive clinic selection (Phase 5),
  `ROOM_MOVE` displacement (Phase 7-9A) and `SUPERVISION` selection
  (Phase 9C). Here the unfairness is real allocation, not just a
  misleading number: the new starter is picked first for clinics, moved
  out of rooms first, and given supervision first, until they catch up.

## Why the "sessions they would have worked" credit is the wrong number

The originally-proposed credit was `weeks_missed × sessions_per_week` —
e.g. 12 weeks × 4 sessions = 48. That is the count of *working* sessions
they would have done. Every counter in the system counts something much
rarer than that: duty sessions, clinics of one type, room moves,
supervision stints. Crediting 48 duty sessions to a 4-session doctor gives
them a duty score of `48 / 4 × 10 = 120` against colleagues sitting in
single figures, and they would never be picked for duty again that year.

The credit has to be denominated in the thing the counter counts. The
figure that puts a joiner level with the group is:

```
opening_balance = peer_weighted_score × their_sessions_per_week
```

i.e. "start them at the group's current score rather than at zero". For a
4-session joiner arriving when the group averages a duty score of 8.0
(`raw/spw`, unscaled 0.8), the credit is `0.8 × 4 = 3.2` duty sessions —
not 48.

## Approaches considered

**A. Pro-rate the denominator from the employment window.** Score becomes
`raw / (spw × fraction_of_the_counted_period_employed)`. Needs no new
data (`Doctor.start_date` / `end_date` already exist, and
`app/leave_entitlement.py` already pro-rates leave the same way) and needs
no admin action.

Rejected as the primary mechanism for two reasons. First, the fraction has
to be measured against the *elapsed or planned* part of the period, not the
whole period: on 1 October, someone who started on 1 September has been
present for 1 of the 9 months so far, and pro-rating by their 4/12 share of
the calendar year under-credits them threefold. The honest boundary for the
duty grid is "the last date duty has been planned to", which is awkward to
define and moves as planning advances. Second, it is volatile at the start:
a denominator of two weeks means a single assignment spikes the joiner from
lowest to highest.

Third and decisively: it cannot be applied to the clinic and system
counters at all. Those are lifetime-cumulative stored raw counts read
straight by the engine, with no "counted period" to pro-rate against —
they are reset by hand, not by the calendar.

**B. An explicit opening balance (chosen).** Store, per counter, a number
of credited sessions that is added to the raw count before the score is
computed. Stable, auditable, admin-overridable, and it is the only shape
that works for the engine counters, so it gives one concept across all
three surfaces instead of a display rule for duty and something else for
the engine.

## Scope

In:

- An opening balance on clinic counters, system counters and the annual
  duty count.
- Reading it wherever a weighted score is computed: the engine
  (`CounterState`), the counters page, and the duty grid.
- Admin editing of the balance, and clearing it on reset.

Out (candidates for a follow-up, not this plan):

- A computed "suggested balance" endpoint. The admin can read peer scores
  straight off the counters page and do the multiplication; a joiner is a
  once-or-twice-a-year event, and a suggestion engine is not worth its
  weight until the manual version has been used in anger.
- Any change to reception counters. `receptionWeightedScore.ts` divides by
  hours actually worked, so a mid-year joiner is already handled correctly
  there — the denominator only counts time they were present.
- Retrospective reconstruction of what a balance "should have been" for
  someone who already joined. There is no counter history to derive it
  from; the admin sets the number.

## Design decisions

**1. The balance is additive, stored separately from `raw_count`, and the
engine never writes it.** Score becomes `(raw_count + opening_balance) / spw`.
Keeping it in its own column matters for the draft lifecycle:
`RotaClinicCounterSnapshot` / `RotaSystemCounterSnapshot` copy `raw_count`
only, so a balance the engine never touches needs no snapshot column and
cannot be corrupted by scrap/restore. Folding the credit into `raw_count`
instead would be simpler on day one and wrong on day two — it would be
indistinguishable from work actually done, and a reset would silently
destroy it.

**2. Reset-to-zero clears the balance as well as the count.** After a
reset every doctor is level at zero by definition, so a surviving joiner
credit would re-introduce exactly the skew it was created to remove. This
is a behaviour change to the four existing reset endpoints and needs to be
said out loud in their confirm text.

**3. The duty balance is year-scoped; the clinic and system balances are
not.** The duty count is derived per calendar year (`getYearRange` →
`GET /duty/counts?from&to`), so a balance that outlived its year would keep
crediting someone who is no longer a new starter. `(doctor_id, year)` is
the same shape `LeaveEntitlement` already uses for the same reason, so the
precedent exists in the codebase. Clinic and system counters are
lifetime-cumulative with a manual reset, so their balance simply persists
until a reset clears it — matching the lifetime of the count it adjusts.

**4. Balances are stored in sessions, at one decimal place**
(`Numeric(5,1)`), matching `LeaveEntitlement.entitlement_sessions` and
`Doctor.sessions_per_week`. A credit derived from a peer average is
fractional (3.2 above), and rounding it to an integer at storage time
distorts a small number badly.

**5. Negative balances are allowed.** The mirror case is real: someone
returning from a long absence, or a leaver whose count should be treated as
already served. Nothing in the score maths objects, and forbidding it would
mean inventing a second mechanism later.

**6. The counter tables get a column; duty gets a new table.**
`clinic_counters` and `system_counters` already have exactly the right row
grain, so a nullable-with-default column on each is the whole change. Duty
has no counter table — the count is a `func.count()` over
`DutyAssignment` — so its balance needs somewhere to live, and the
`(doctor_id, year)` grain from decision 3 makes that a table rather than a
column on `Doctor`.

## Task 1: Data model

**A.** Nothing has been done yet. This task adds the storage and nothing
that reads it.

**B.** Files:

- `backend/app/models/counter.py` — add `opening_balance` to
  `ClinicCounter` and `SystemCounter`.
- `backend/app/models/duty_opening_balance.py` — new.
- `backend/app/models/__init__.py` — export it.
- `backend/alembic/versions/` — one migration (check the current head
  first; the numbering convention is in the existing files).
- `backend/tests/test_models.py` — round-trip and default coverage.

Deliverable: the columns and table exist, default to zero, and the
migration runs clean on an existing database.

**C.** `opening_balance` is `Numeric(5,1)`, `nullable=False`, Python
default `Decimal("0.0")` and `server_default="0"` — the server default is
what makes the migration safe against existing rows. New table
`duty_opening_balances`: `id`, `doctor_id` FK, `year` int,
`sessions Numeric(5,1)` non-null, optional `notes String(200)`, unique on
`(doctor_id, year)`. Read `backend/app/models/leave_entitlement.py` first
and follow its shape and docstring style — this is deliberately its
sibling. No check constraint on sign (decision 5).

Add `DutyOpeningBalance` to the purge list in
`routers/doctors.py`'s delete — that endpoint enumerates every table
holding a `doctor_id`, and a new one silently omitted is a foreign-key
failure on the next doctor delete.

## Task 2: Engine

**A.** Task 1 is done: the storage exists but nothing reads it.

**B.** Files:

- `backend/app/engine/datatypes.py` — `CounterState`.
- `backend/app/engine/context.py` — loads counters into `CounterState`.
- `backend/app/engine/phases/phase5.py`, `phase7_9a.py`, `phase9c.py` —
  read for context; ideally unchanged.
- `backend/tests/test_datatypes.py`, `tests/test_engine/test_phase5.py`,
  `test_phase4.py` and the Phase 9C tests.

Deliverable: every engine weighted score accounts for the balance, with no
change to any phase's own logic.

**C.** `CounterState` grows balance maps alongside `clinic` and `system`,
populated by `context.load_context()` from the same query that loads the
counters. `weighted_clinic_score` and `weighted_system_score` become
`(raw + balance) / spw`, `spw == 0` still returning `inf` before anything
else is considered. `increment_clinic` / `increment_system` are untouched —
they move `raw_count` only, which is what keeps the snapshot contract in
decision 1 true.

The phases should need no edits at all; if one does, that is a sign the
balance has leaked somewhere it should not be, and is worth raising rather
than patching.

Tests: a doctor with a balance sorts behind an identical doctor without
one; a balance does not survive into `increment_*`; `spw == 0` still beats
everything to infinity regardless of balance.

## Task 3: API

**A.** Tasks 1-2 are done: storage exists and the engine reads it. Nothing
is exposed over the wire yet.

**B.** Files:

- `backend/app/api/schemas/counter.py`, `duty.py`.
- `backend/app/api/routers/counters.py`, `duty.py`.
- `backend/tests/test_api/test_counters.py`, `test_duty.py`.

Deliverable: balances are readable, settable and cleared by reset.

**C.** Add `opening_balance` to `ClinicCounterOut` and `SystemCounterOut`,
and `opening_balance` to `DutyCountOut` (resolved from
`duty_opening_balances` for the year the requested range falls in — see the
open question below about ranges that straddle a year boundary).

New endpoints, following the existing reset endpoints' shape and returning
the same `*Out` models:

- `PUT /counters/clinic/{counter_id}/opening-balance`
- `PUT /counters/system/{counter_id}/opening-balance`
- `PUT /duty/opening-balance` — body carries `doctor_id`, `year`,
  `sessions`; upserts, and deletes the row when set to zero so the table
  holds only real deviations (the `LeaveEntitlement` "a row is a deviation"
  principle).

The four reset endpoints additionally zero the balance (decision 2).
`reset-all` on each side does so for every row, matching the existing
comment about not leaving invisible non-zero values behind.

These are `clinical: write`; nothing extra is needed, since the routers are
already classified in `main.py`'s `_AREA` and gating is router-level.

## Task 4: Frontend

**A.** Tasks 1-3 are done: the backend stores, reads and serves balances.
The UI still shows the unadjusted score.

**B.** Files:

- `frontend/src/lib/weightedScore.ts` and its test — the shared score.
- `frontend/src/api/types.ts`, `counters.ts`, `duty.ts` — wire types and
  mutation hooks.
- `frontend/src/routes/CountersPage.tsx` and its test.
- `frontend/src/components/DutyGrid.tsx` and its test.

Deliverable: both surfaces show the adjusted score, mark which rows carry a
credit, and let an admin set one.

**C.** `computeWeightedScore` takes the balance as a third argument and
computes `((raw + balance) / spw) * 10`. Its docstring names
`CounterState.weighted_clinic_score` as the function it mirrors and must be
updated to keep saying something true — that mirror relationship is load-
bearing, per `architecture-clinical.md`'s note on `weightedScore.ts`.

A row with a non-zero balance needs to say so. The raw count column should
keep showing work actually done, with the credit shown separately rather
than baked into it — an admin looking for "how much duty has Sam actually
done" must not be given a number inflated by a credit. Exact presentation
is a UI decision for the review pass; a suffixed `(+3.2)` next to the raw
count is the cheapest thing that is honest.

Editing follows whatever pattern the counters page already uses for its
reset controls, behind the same `useWriteGate`.

`DutyGrid`'s "lowest annual weighted score is bolded" logic reads the
adjusted score, which is the entire point of the feature.

## Task 5: Review and documentation

**A.** Tasks 1-4 are complete and the feature is live. This step is review
and documentation only.

**B.** Files: `documentation/architecture-clinical.md`,
`documentation/phase_pipeline.md`, and this plan.

**C.** Update the counters section of `architecture-clinical.md` — it
currently states flatly that the fairness metric is
`raw_count / sessions_per_week` and that counters store raw counts only;
both sentences become wrong and need to carry the balance and the reasoning
behind decisions 1-3. `phase_pipeline.md` describes the weighted score in
the Phase 5, 7-9A and 9C sections and needs the same correction. Then
delete this file.

## Open questions for the review pass

1. **A duty range straddling a year boundary.** The duty grid asks for a
   calendar year, so today the question does not arise, but `GET
   /duty/counts` takes arbitrary `from`/`to`. Sum the balances of both
   years, take the year the range starts in, or return the balance
   per-year and let the caller decide?
2. **Who else needs to be told.** A balance changes generation outcomes.
   Should setting one be written to the audit log (the audit table exists
   and records who did what), and should the counters page warn about an
   active draft the way the reset controls already do?
3. **Whether the suggestion is really out of scope.** The manual figure
   requires the admin to compute `peer_score / 10 × spw` by hand and to
   know that is the right formula. If that turns out to be the step people
   get wrong, the suggestion endpoint moves in-scope and this plan grows a
   task.
4. **Whether duty needs this at all, given it is advisory.** The engine
   counters are the ones with real consequences. A cheaper first release
   would do Tasks 1-3 for clinic and system counters only and leave the
   duty grid alone. That halves the work; it also leaves the surface the
   problem was noticed on unfixed.
