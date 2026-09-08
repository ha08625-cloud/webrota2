# Implementation plan: counter opening balances (mid-year joiners)

Status: **implementation plan**. Reviewed against the code (step 2 of the
CLAUDE.md workflow). The provisional plan's problem statement, its rejection
of approach A, and design decisions 1-6 all survived review unchanged; what
follows corrects four factual errors in the task breakdown, adds three
design decisions the provisional plan had missed, and settles the four open
questions.

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
  `ROOM_MOVE` displacement (Phase 4 and Phase 7-9A) and `SUPERVISION`
  selection (Phase 9C). Here the unfairness is real allocation, not just a
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
not 48. Substituting back: `(0 + 3.2) / 4 = 0.8`, exactly the peer score,
which is the property the whole design rests on.

## Approaches considered

**A. Pro-rate the denominator from the employment window.** Score becomes
`raw / (spw × fraction_of_the_counted_period_employed)`. Needs no new
data (`Doctor.start_date` / `end_date` already exist at
`app/models/doctor.py:45-46`, and `app/leave_entitlement.py` already
pro-rates leave the same way) and needs no admin action.

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
they are reset by hand, not by the calendar
(`architecture-clinical.md:148`).

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
  (`CounterState`), the engine's decision-log rationale text, the counters
  page, and the duty grid.
- Admin editing of the balance, and clearing it on reset.

Out (candidates for a follow-up, not this plan):

- A computed "suggested balance" endpoint. See settled question 3.
- Any change to reception counters. `receptionWeightedScore.ts` divides by
  hours actually worked over the requested window, so a mid-year joiner is
  already handled correctly there — the denominator only counts time they
  were present. Verified, no change needed.
- Retrospective reconstruction of what a balance "should have been" for
  someone who already joined. There is no counter history to derive it
  from; the admin sets the number.

## Design decisions

**1. The balance is additive, stored separately from `raw_count`, and the
engine never writes it.** Score becomes `(raw_count + opening_balance) / spw`.
Keeping it in its own column matters for the draft lifecycle:
`RotaClinicCounterSnapshot` / `RotaSystemCounterSnapshot` store
`value_before: int` for `raw_count` only
(`app/models/counter_snapshot.py:44,57`), so a balance the engine never
touches needs no snapshot column and cannot be corrupted by scrap/restore.
Folding the credit into `raw_count` instead would be simpler on day one and
wrong on day two — it would be indistinguishable from work actually done,
and a reset would silently destroy it.

**2. Reset-to-zero clears the balance as well as the count.** After a
reset every doctor is level at zero by definition, so a surviving joiner
credit would re-introduce exactly the skew it was created to remove. This
is a behaviour change to the four existing reset endpoints and needs to be
said out loud in their confirm text — see decision 7 for the wording trap.

**3. The duty balance is year-scoped; the clinic and system balances are
not.** The duty count is derived per calendar year (`getYearRange` →
`GET /duty/counts?from_date&to_date`), so a balance that outlived its year
would keep crediting someone who is no longer a new starter — and by the
next 1 January every doctor is genuinely level again, because the count
itself restarts. `(doctor_id, year)` is the same shape `LeaveEntitlement`
already uses for the same reason, so the precedent exists in the codebase.
Clinic and system counters are lifetime-cumulative with a manual reset, so
their balance simply persists until a reset clears it — matching the
lifetime of the count it adjusts.

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
`DutyAssignment` (`app/api/routers/duty.py:98-108`) — so its balance needs
somewhere to live, and the `(doctor_id, year)` grain from decision 3 makes
that a table rather than a column on `Doctor`.

**7. NEW — a balance change is not undone by scrapping a draft, and the
counters page must not say it is.** `CountersPage.tsx:22` appends a
`DRAFT_WARNING` to every reset confirmation saying "all counters will be
restored to their pre-generation values and this reset will be undone".
That is true of `raw_count`, which is snapshotted, and false of the
balance, which by decision 1 is not. After decision 2 makes reset clear the
balance too, a reset during an active draft followed by a scrap restores
the count and leaves the balance permanently at zero. The warning text has
to distinguish the two, and the balance-editing control needs no draft
warning at all — a balance edit is never rolled back.

**8. NEW — the engine holds balances as `float`, converted at load.**
`CounterState.clinic` / `.system` are `dict[..., int]` and every consumer
does float arithmetic. `Decimal / float` raises `TypeError` in Python, so
carrying `Numeric(5,1)` values into `(raw + balance) / spw` unconverted is
a crash, not a rounding question. `_load_counter_state` converts to `float`
at the boundary. Decimal buys nothing in a pure in-memory sort key.

**9. NEW — the clinic balance is addressed by `(doctor_id,
clinic_type_id)`, not by `counter_id`.** Clinic counter rows are created
**lazily** — `CounterState.is_new_clinic_key` exists precisely so
`generate._write_to_db` can INSERT them on first use, and
`architecture-clinical.md:148` states it outright: "Counter rows are
created lazily (get-or-create in the engine and swap endpoints); only
system counters are seeded." A new joiner therefore has **no clinic counter
rows at all**, and `GET /counters/clinic` returns only rows that exist. An
endpoint keyed on `counter_id` would be unusable for exactly the person the
feature exists for. System counters are unaffected: `create_doctor`
(`app/api/routers/doctors.py:220`) seeds a `ROOM_MOVE` and `SUPERVISION`
row for every new doctor, so `counter_id` is always available there.

## Settled open questions

1. **A duty range straddling a year boundary.** Resolve the balance from
   the year of `from_date`. When `from_date` is absent, return a zero
   balance. The duty grid always passes a whole calendar year
   (`DutyGrid.tsx:70`, `getYearRange`), so this is the only caller and the
   answer is exact for it; documenting the rule in the endpoint docstring
   is cheaper than summing across years for a case that does not occur.
2. **Who else needs to be told.** The audit half needs **no work**:
   `AuditLogEntry` is written by middleware for every non-GET request that
   reaches the API (`app/models/audit.py`), so a `PUT` is logged
   automatically with actor, route, body and status. The draft-warning half
   is real but inverts the provisional plan's assumption — see decision 7.
3. **Whether the suggestion is really out of scope.** Yes, out. But the
   cheap half of it is in: the counters page already renders every peer's
   weighted score in a column, so the admin has the input in front of them.
   Task 4 adds a one-line hint next to the balance input stating the
   formula (`peer score ÷ 10 × sessions per week`) rather than an endpoint
   that computes it. If admins get the arithmetic wrong in practice, the
   endpoint becomes a follow-up ticket with evidence behind it.
4. **Whether duty needs this at all, given it is advisory.** Keep it in.
   Duty is the surface the problem was noticed on, and its marginal cost is
   one table and one endpoint — Task 4's frontend score change is shared
   with the counters work regardless. Dropping it would leave the reported
   symptom unfixed to save the cheapest part of the plan.

## Task 1: Data model

**A.** Nothing has been done yet. This task adds the storage and nothing
that reads it.

**B.** Files:

- `backend/app/models/counter.py` — add `opening_balance` to
  `ClinicCounter` and `SystemCounter`; the module docstring's "Weighted
  score (raw_count / doctor.sessions_per_week) is computed at query time"
  becomes wrong and must be updated.
- `backend/app/models/duty_opening_balance.py` — new.
- `backend/app/models/__init__.py` — export it.
- `backend/alembic/versions/013_counter_opening_balance.py` — new. Current
  head is `012_recurring_note_instances`, so `down_revision = "012"`.
- `backend/app/api/routers/doctors.py` — `PURGED_MODELS`.
- `backend/tests/test_models.py`, `backend/tests/test_api/test_doctors.py`.

Deliverable: the columns and table exist, default to zero, and the
migration runs clean on an existing database.

**C.** `opening_balance` is `Numeric(5, 1)`, `nullable=False`, Python
default `Decimal("0.0")` and `server_default="0"` — the server default is
what makes the migration safe against existing rows. New table
`duty_opening_balances`: `id`, `doctor_id` FK, `year` int,
`sessions Numeric(5, 1)` non-null, optional `notes String(200)`, unique on
`(doctor_id, year)`. Read `backend/app/models/leave_entitlement.py` first
and follow its shape and docstring style — this is deliberately its
sibling. No check constraint on sign (decision 5).

Add `DutyOpeningBalance` to `PURGED_MODELS` in `routers/doctors.py`. That
tuple is the single edit point for both the delete and its response counts,
and `tests/test_api/test_doctors.py` carries a tripwire asserting it covers
every FK targeting `doctors` — omitting it fails that test rather than
silently breaking doctor deletion, but fix it here regardless.

## Task 2: Engine

**A.** Task 1 is done: the storage exists but nothing reads it.

**B.** Files:

- `backend/app/engine/datatypes.py` — `CounterState` (line 229).
- `backend/app/engine/phases/phase2.py` — `_load_counter_state` (line 103)
  is where counters are read from the DB. **Not `context.py`**, which the
  provisional plan named in error; `context.py` does not touch counters,
  and `CounterState()` is constructed in exactly one place, `phase2.py:111`.
- `backend/app/engine/rationale.py` — `score()` (line 56).
- `backend/app/engine/phases/phase4.py` (`_room_move_score_text`, line
  573), `phase7_9a.py` (`_room_move_score_text`, line 869),
  `phase9c.py` (`_line`, line 296) — these **do** need edits; see below.
- `backend/app/engine/phases/phase5.py` — read for context; unchanged.
- `backend/tests/test_datatypes.py`, `tests/test_engine/test_phase2.py`,
  `test_phase4.py`, `test_phase5.py` and the Phase 9C tests.

Deliverable: every engine weighted score accounts for the balance, the
decision log reports it honestly, and no phase's selection logic changes.

**C.** `CounterState` grows `clinic_balance: dict[tuple[int, int], float]`
and `system_balance: dict[tuple[int, SystemCounterType], float]` alongside
`clinic` and `system`, populated by `_load_counter_state` from the rows it
already reads — no extra query. Convert with `float(row.opening_balance)`
per decision 8. `weighted_clinic_score` and `weighted_system_score` become
`(raw + balance) / spw`, with `spw == 0` still returning `inf` before
anything else is considered. `increment_clinic` / `increment_system` are
untouched — they move `raw_count` only, which is what keeps the snapshot
contract in decision 1 true.

**The provisional plan's claim that "the phases should need no edits at
all" is wrong.** Three rationale helpers read the raw count out of
`CounterState` directly and pass it to `rationale.score(raw, spw,
weighted)` for the decision log:

- `phase4.py:577` and `phase7_9a.py:873` — `counters.system.get((doctor_id,
  SystemCounterType.ROOM_MOVE), 0)`
- `phase9c.py:299` — the same for `SUPERVISION`

Left alone, these print a line whose stated numerator and denominator do
not produce its stated result (`raw=0, spw=4 → 0.80`). The decision log is
the artefact a doctor uses to challenge an allocation, so an incoherent
line there is worse than a wrong one. Extend `rationale.score()` to take
the balance and render it — e.g. `0 (+3.2 opening) ÷ 4 = 0.80`, omitting
the parenthetical entirely when the balance is zero so every existing line
is byte-identical — and update the three call sites to pass it. This is the
only phase change; nothing in any phase's *selection* logic moves.

Tests: a doctor with a balance sorts behind an identical doctor without
one; a balance does not survive into `increment_*` or into the values
written by `_write_to_db`; `spw == 0` still returns infinity regardless of
balance; a zero balance leaves rationale text unchanged; a non-zero balance
produces a line whose arithmetic is self-consistent.

## Task 3: API

**A.** Tasks 1-2 are done: storage exists and the engine reads it. Nothing
is exposed over the wire yet.

**B.** Files:

- `backend/app/api/schemas/counter.py`, `duty.py`.
- `backend/app/api/routers/counters.py`, `duty.py`.
- `backend/tests/test_api/test_counters.py`, `test_duty.py`.

Deliverable: balances are readable, settable and cleared by reset.

**C.** Add `opening_balance` to `ClinicCounterOut`, `SystemCounterOut` and
`DutyCountOut`.

`GET /counters/clinic` returns the **cross-product** of counted doctors
(`_COUNTED_TYPES`, i.e. Partner and Salaried) × clinic types, not just the
rows that exist, per decision 9. Rows with no DB row carry `id: null`,
`raw_count: 0`, `opening_balance: 0.0`. This is a visible change to the
counters page — types a doctor has never been allocated now appear as
explicit zeros — and it is the point: without it an admin cannot set a
balance for a joiner at all. `GET /counters/system` is unchanged in shape,
since those rows are seeded.

New endpoints, `clinical: write` (no extra work — the routers are already
classified in `main.py`'s `_AREA` and gating is router-level):

- `PUT /counters/clinic/opening-balance` — body carries `doctor_id`,
  `clinic_type_id`, `sessions`. **Upserts**, creating the `ClinicCounter`
  row with `raw_count=0` if absent. Not keyed on `counter_id`; see
  decision 9.
- `PUT /counters/system/{counter_id}/opening-balance` — keyed on
  `counter_id`, which is safe here because the rows are seeded.
- `PUT /duty/opening-balance` — body carries `doctor_id`, `year`,
  `sessions`; upserts, and deletes the row when set to zero so the table
  holds only real deviations (the `LeaveEntitlement` "a row is a deviation"
  principle).

All three return the relevant `*Out` model, following the existing reset
endpoints' shape.

`GET /duty/counts` resolves each doctor's balance from
`duty_opening_balances` for `from_date.year`, returning `0.0` when
`from_date` is `None`. State the rule in the endpoint docstring (settled
question 1). Note the existing asymmetry, which this plan does not change:
duty counts cover all `active` doctors, while counter endpoints cover
Partner and Salaried only.

The four reset endpoints additionally zero the balance (decision 2).
`reset-all` on each side does so for every row, matching the existing
comment about not leaving invisible non-zero values behind.

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
computes `((raw + balance) / spw) * 10`. **The balance arrives as a JSON
string**, not a number — `Numeric` serialises the way
`Doctor.sessions_per_week` already does ("10.0"), which the function's own
docstring calls out for `spw`. Parse it with `Number()`; `raw + balance`
on an unparsed string concatenates instead of adding, and `0 + "3.2"` is a
silent wrong answer rather than a crash. Type it `string` on the wire in
`types.ts` for the same reason. The docstring names
`CounterState.weighted_clinic_score` as the function it mirrors and must be
updated to keep saying something true — that mirror relationship is
load-bearing, per `architecture-clinical.md:439`.

A row with a non-zero balance needs to say so. The raw count column keeps
showing work actually done, with the credit shown separately rather than
baked into it — an admin looking for "how much duty has Sam actually done"
must not be given a number inflated by a credit. A suffixed `(+3.2)` next
to the raw count is the cheapest thing that is honest.

Editing follows the pattern `CountersPage` already uses for its reset
controls, behind the same `useWriteGate`. Two differences from reset:

- The balance input carries **no** `DRAFT_WARNING` — a balance edit is not
  snapshotted and a scrap never undoes it (decision 7).
- The reset confirmations' `DRAFT_WARNING` text must be corrected to say
  that scrapping restores the *count* but not the balance, which the reset
  clears permanently. The current wording ("all counters will be restored
  to their pre-generation values and this reset will be undone") becomes
  false the moment decision 2 ships.

Add the formula hint next to the input (settled question 3): "to level a
joiner with the group, use peer score ÷ 10 × sessions per week".

On rows returned with `id: null` (a clinic counter that does not exist
yet), the per-row reset control is disabled — there is nothing to reset —
while the balance input remains active.

`DutyGrid`'s "lowest annual weighted score is bolded" logic reads the
adjusted score, which is the entire point of the feature.

## Task 5: Review and documentation

**A.** Tasks 1-4 are complete and the feature is live. This step is review
and documentation only.

**B.** Files: `documentation/architecture-clinical.md`,
`documentation/phase_pipeline.md`, and this plan.

**C.** `architecture-clinical.md:148` currently states that
`clinic_counters` and `system_counters` "store **raw counts only**" and
that the fairness metric is `raw_count / sessions_per_week`; both clauses
become wrong. Rewrite that paragraph to carry the balance, the formula
`(raw_count + opening_balance) / sessions_per_week`, and the reasoning
behind decisions 1-3, 7 and 9 — particularly that the balance is *not*
snapshotted and therefore survives a scrap. The lazy-creation sentence in
the same paragraph needs the Task 3 change to `GET /counters/clinic`.
`phase_pipeline.md:119` and `:198` state the formula in the Phase 5 and
Phase 9C sections and need the same correction; check the Phase 4 and
Phase 7-9A sections for the same sentence. Then delete this file.
