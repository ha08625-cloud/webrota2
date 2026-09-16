# Plan — TOIL or payment for extra sessions

Implementation plan (workflow stage 2). Ready to break into tasks.

## Scope

An extra session is currently a bare record of intent: doctor, date, period.
The practice compensates one in one of two ways — **time off in lieu** or
**payment** — and the app records neither, so the choice lives in someone's
email. This adds it.

In scope:

- A `compensation` field on `ExtraSessionEntry`, set when an extra session is
  planned and correctable afterwards.
- The choice offered on both surfaces that create an extra session: the
  Individual Leave tab's `ExtraSessionsSection` form and the Annual Planner's
  `PlanningCellPopover`.
- A **TOIL** extra session credits **+1 session** to that doctor's leave
  entitlement for the calendar year the session falls in, visible in the
  Individual Leave tab's balance line.
- A **Payment** extra session changes nothing about leave. The app records the
  decision; it does not raise an invoice, feed payroll, or hold a rate.

Out of scope, and deliberately:

- Any money. No amount, rate or payroll export. "Payment" here is a label on a
  decision, and nothing downstream reads it.
- Any change to the engine or the staging copy loop. TOIL is an
  entitlement-accounting fact; the override that turns a planned extra session
  into a worked staged slot is untouched.
- A TOIL balance for doctor types with no leave entitlement (see Design
  Decisions).
- Any change to the Annual Planner Excel export. It renders `E` from the cell
  state and the note, neither of which changes here.

## Design decisions

### TOIL credits the entitlement, and is derived, never stored

`LeaveEntitlement` already has an `adjustment_sessions` column, and writing
TOIL into it would need no schema change at all. It is still the wrong place.
That column means "what an admin granted or docked this year", and it is
hand-edited; a derived figure sharing it could be overwritten by an admin
editing something else, and deleting the extra session would not reverse it.

Instead TOIL is **counted at read time** from `extra_session_entries`, exactly
as used leave is counted at read time from `leave_entries` — the pattern
`LeaveEntitlement`'s docstring already commits to ("No `used` or `remaining`
column"). It arrives as a new `toil_sessions` addend in `EntitlementBreakdown`
and a new field on `LeaveEntitlementOut`, added into `total_sessions` alongside
carry-over and adjustment. Delete the extra session and the credit goes with
it, with no second write to get wrong.

The accepted cost is the same one that module already accepts: a historical
total moves when its inputs are edited.

### A TOIL session that plainly did not happen credits nothing

An extra session is a record of *intent*, not of work done, so a planned one
can be overtaken by events. Four cases, all reachable today:

1. **Leave booked over the slot.** `POST /leave/bulk` and
   `POST /leave-planning/bulk` both leave a covering extra session in place and
   merely *report* it as `superseded_extra_sessions`. Leave wins in the staging
   copy loop, so the doctor does not work that session.
2. **Blocked booked over the slot.** `POST /leave-planning/bulk` refuses an
   `extra_session` action on a cell that already holds a `BlockedEntry`
   (`blocked_exists`), but says nothing about a blocked row added *after* the
   extra session. An admin who blocks a cell has recorded the doctor as
   unavailable — a whole-day training session is the canonical case — so the
   credit is withheld.
3. **A practice closure added over the slot** after the session was planned.
4. **The employment window shortened** past the date after the session was
   planned. (Both create paths refuse an out-of-window date up front, but
   `Doctor.start_date` / `end_date` are editable afterwards.)

In all four the doctor does not work the session, so crediting TOIL for it
would hand out leave that was never earned. The credit therefore applies the
same four exclusions at read time.

Case 2 needs a caveat in the docstring, because it is the one exclusion that
does not follow from what the rest of the system does. `BlockedEntry` is
planner-only: nothing in `POST /staging` or under `engine/` reads it, so a
blocked slot carrying an extra session **is still copied into staging**. The
exclusion is therefore a judgement about what the admin meant, not a
consequence of the copy loop. It is made because blocked is the state the
planner already treats as "not available", and because a credit that outlives
an explicit unavailability marker is the harder one to explain to a doctor.

**This is not `leave_charging.exemption_reason` and must not reuse it.** That
predicate exempts a slot whose template row is `NO_SURGERY` or missing — which
is precisely the *normal* case for an extra session, the whole point being a
doctor working a slot they do not normally work. Reusing it would zero almost
every credit. The TOIL predicate is its own, smaller thing: leave on the slot,
blocked on the slot, a closure on the slot, or outside the employment window.
Its home is a new `backend/app/toil_credit.py`, mirroring `leave_charging.py`'s
shape (a pure per-entry predicate plus a summariser, no DB access) and for the
reason that module gives — the rules carry the design decisions and are worth
unit-testing without a `TestClient`.

Weekends need no exclusion: both create paths already reject them, and there is
no later edit that can turn a weekday into a Saturday.

### The template row is deliberately not a fifth exclusion

Considered and rejected: withholding the credit when the doctor's week-1
template row for the slot is `REQUIRES_ROOM` or `PRE_ASSIGNED`.

The argument for it is real and should be recorded rather than rediscovered.
The `POST /staging` copy loop only converts an extra session into a working
slot when the template row is absent or in `_OVERRIDABLE_TYPES`
(`NO_SURGERY` / `ADMIN_TIME` / `WFH`) — see `routers/staging.py`. On a
`REQUIRES_ROOM` or `PRE_ASSIGNED` row the extra session is a **no-op**: the
doctor was already rostered to see patients that session, so nothing extra was
worked and a +1 credit is unearned. That state is reachable, because nothing
checks the template at create time and the template is editable afterwards.

It is not excluded anyway, for two reasons. The practice's own reading is that
an extra session is a decision between the doctor and the practice, and the
template is a separate artefact that is often behind; a credit that silently
vanishes because someone later filled in a template row would be harder to
explain than an occasional over-credit an admin can correct with
`adjustment_sessions`. And the exclusion would drag the week-1 template into
`toil_credit.py`, which is otherwise a small pure module over four plain
containers — the one thing the "not `leave_charging`" decision above is trying
to keep it out of.

Revisit if over-credits are actually observed.

### Existing rows become Payment

The column is `NOT NULL` with `server_default 'Payment'`, so every row in
production today reads as Payment. Nothing was ever credited as TOIL before, so
this leaves every historical leave balance exactly as it stands — a nullable
"not yet decided" state would instead light up every old row as an unresolved
to-do, and would need a "must choose" rule to stop the blank state spreading to
new ones. Anything that should have been TOIL is corrected by editing the row,
which is what the new PATCH exists for.

### The bulk endpoint's compensation is nullable on the wire, unlike the POST's

`ExtraSessionIn.compensation` defaults to `PAYMENT`: a single-entry create with
the field omitted means "Payment", which is the status quo and the commoner
case.

`PlanningActionIn.compensation` is instead `ExtraSessionCompensation | None =
None`, where `None` means **"Payment on insert, unchanged on update"**. The
difference is not cosmetic. The bulk endpoint is a state-setting grid whose
`extra_session` action is emitted for *any* change to a cell, including a
notes-only edit; if an omitted field meant Payment there, any client that had
not been updated — or any future code path emitting an action without the
field — would silently downgrade a TOIL row to Payment and quietly delete a
leave credit. A null that means "don't touch" cannot do that. `notes` has the
same shape of hazard and accepts it, but a note is not worth a session of
leave.

### TOIL is refused for doctor types with no entitlement

`LEAVE_WEEKS_BY_DOCTOR_TYPE` omits locums, AHPs and nurses: AHP and nurse leave
is assigned by a third party, and a locum is engaged per session. A TOIL credit
for one of them has nowhere to land. Recording it anyway and silently ignoring
it in the balance is the quiet disagreement `leave_entitlement.py` was written
to avoid, so it is refused at the API boundary with a 422 — the same treatment
an entitlement override on an AHP already gets — and the UI disables the option
with the reason stated rather than failing on submit.

Giving those doctor types a TOIL balance of their own, independent of annual
leave, is a different and much larger feature: a new accounting concept, not a
field on an existing one. Not now.

### Leave still does not delete a superseded extra session

Considered and rejected for this work: having `POST /leave/bulk` and
`POST /leave-planning/bulk` **delete** an extra session their leave covers,
which would make the TOIL count a plain count with no exclusions.

It does not buy that. It addresses one of the four cases above; a blocked row,
a closure or a window edit still strands a planned session that never happens,
so the read-time exclusions are needed either way. Against that it is
destructive and asymmetric: bulk leave writes every weekday in a range, so one
mis-typed end date would silently destroy several planned extra sessions, and
removing the leave afterwards would not bring them back. It also reverses an
explicit decision recorded in both endpoints ("Reported, never deleted and
never a 409 — the row itself stays as the record of intent").

The real gap it is reaching for is that `superseded_extra_sessions` is
*transient*: it is reported once in the save response and is gone on the next
refresh, so nothing on screen afterwards says why a planned session is being
ignored. That is fixed here as a **display** change rather than a cascade
delete — Task 4 flags such rows in `ExtraSessionsSection`, where it doubles as
the explanation for a credit that did not accrue.

The flag is computed **client-side from leave and blocked rows only**, not from
a new server field. Those two are already on the page; closure and window are
not, and fetching them to reproduce the server's predicate in TypeScript would
put the rule in two places, which is the failure mode this whole module is
written against. The aggregate `toil_skipped` counts on the balance line carry
the other two reasons, and that split is deliberate: the row flag answers "why
is this row greyed out", the summary answers "why is my total not what I
expected".

### One weekday session is one session

Extra sessions are half days, and leave is counted in sessions throughout —
"one session = one AM or PM half day". A TOIL extra session is therefore worth
exactly 1.0, never 0.5 and never a day. No new unit enters the system.

### TOIL across the year boundary is a carry-over, and is documented not coded

A TOIL session worked in December credits that December's entitlement; leave
taken in lieu in January charges January's. The balance is right in each year
and wrong in neither, but the credit and its use land on opposite sides of the
1 January boundary and nothing prompts anyone about it.

No new mechanism for this. `carry_over_sessions` already exists for exactly
"how much came from last year" and an admin closing a leave year is already
editing it. What is added is documentation: the architecture doc records that
December TOIL taken in January is corrected through carry-over, and the
existing carry-over note on the balance line is where it will show up. Building
a prompt for it would mean modelling *when* TOIL was taken, which this feature
deliberately does not do — a TOIL leave session is an ordinary `LeaveEntry` and
stays one.

## Task 1: Data model and migration

**A.** Nothing is done yet. This task adds the stored field and nothing that
reads it.

**B.** Files:

- `backend/app/models/enums.py` — new `ExtraSessionCompensation`.
- `backend/app/models/extra_session.py` — the new column.
- `backend/alembic/versions/021_extra_session_compensation.py` — new.
- `backend/tests/test_models.py` — wherever model shapes are asserted.

**C.**

1. Add to `models/enums.py` (not to the domain package — see architecture.md's
   named exception at "Migrations": that file is the registry migration `001`'s
   `_enum()` helper and `enum_col` both read):

   ```python
   class ExtraSessionCompensation(str, enum.Enum):
       TOIL = "TOIL"
       PAYMENT = "Payment"
   ```

   Title-case values, matching every other enum in the file. `_snake()` renders
   the type name `extra_session_compensation`; the migration must use the same
   helper rather than hard-coding that string.

2. On `ExtraSessionEntry`, a non-nullable `compensation` column using
   `enum_col(ExtraSessionCompensation)`, with
   `default=ExtraSessionCompensation.PAYMENT` **and**
   `server_default="Payment"`. Both: the Python default serves ORM inserts, the
   server default serves the migration's backfill and any row inserted outside
   the app. Document on the column that "Payment" is the value every
   pre-existing row takes and why.

3. Migration `021`, `down_revision = "020"`. It must produce exactly what
   `Base.metadata.create_all()` produces, since the test suite builds SQLite
   from the models and CI round-trips the chain against Postgres 16.
   - Copy `017_research_studies.py`'s `_values` / `_enum` / `_create_enum_types`
     / `_drop_enum_types` helpers verbatim with
     `_NEW_ENUMS = (ExtraSessionCompensation,)`. That is the 001 pattern: on
     Postgres the named type is created once at the top of `upgrade()` with
     `checkfirst=True`, and the column references it via
     `postgresql.ENUM(create_type=False)`; on SQLite `_enum()` falls through to
     plain `sa.Enum`.
   - `op.add_column("extra_session_entries", sa.Column("compensation",
     _enum(ExtraSessionCompensation), nullable=False,
     server_default=ExtraSessionCompensation.PAYMENT.value))`. Non-nullable
     with the server default in one step; there is no pre-existing null state
     to backfill separately, and no `batch_alter_table` is needed because
     SQLite can add a column in place (it cannot alter a *constraint*, which
     is what 020's batch usage was for).
   - `downgrade()` drops the column and then calls `_drop_enum_types()`. The CI
     round trip exercises both directions, so a left-behind type will fail the
     build.

4. In the migration docstring, say *why* Payment is the default — the accrual
   consequence (no historical leave balance moves), not just the mechanics.

5. `backend/tests/test_models.py`: assert the column defaults to `PAYMENT` on
   an ORM insert that omits it. `test_datatypes.py` imports enums individually
   and asserts nothing generic about the registry, so it needs no change —
   confirm that before adding anything to it.

## Task 2: Backend — write paths

**A.** Task 1 is done: the column exists and defaults to Payment. Nothing sets
it yet and nothing reads it.

**B.** Files:

- `backend/app/api/schemas/extra_session.py`
- `backend/app/api/schemas/__init__.py` (export the new patch schema)
- `backend/app/api/routers/extra_sessions.py`
- `backend/app/api/schemas/leave_planning.py`
- `backend/app/api/routers/leave_planning.py`
- `backend/tests/test_api/test_extra_sessions.py`,
  `backend/tests/test_api/test_leave_planning.py`

**C.**

1. `ExtraSessionIn` gains `compensation: ExtraSessionCompensation =
   ExtraSessionCompensation.PAYMENT`. Defaulted, not required, so an existing
   API client keeps working and keeps meaning what it meant. `ExtraSessionOut`
   inherits it, which puts it on `GET /extra-sessions`, on
   `LeaveBulkOut.superseded_extra_sessions` and on
   `PlanningBulkOut.superseded_extra_sessions` with no further edit.

2. New `ExtraSessionUpdateIn(BaseModel)` with the single field
   `compensation: ExtraSessionCompensation` (required — a PATCH body that
   changes nothing is a client bug here, unlike `LeaveEntitlementIn`).

3. `create_extra_session` validates it: a `TOIL` request for a doctor whose
   `doctor_type not in LEAVE_WEEKS_BY_DOCTOR_TYPE` is a **422** naming the type
   and the reason, worded like `upsert_entitlement`'s refusal
   ("{type} doctors have no leave entitlement, so a session cannot be taken in
   lieu"). Order it after the existing doctor-exists / weekend / window /
   leave-conflict checks, so a request failing more than one still reports the
   most specific fact first. Pass `compensation=payload.compensation` into the
   `ExtraSessionEntry(...)` construction.

4. New **`PATCH /extra-sessions/{entry_id}`** taking `ExtraSessionUpdateIn`,
   returning `ExtraSessionOut`. Required for correcting a backfilled row, and
   for the ordinary "this one's going to be TOIL after all" edit;
   delete-and-recreate is not an acceptable substitute when the planner has
   already been printed. 404 for an unknown id, then the same 422 rule as the
   POST (the doctor is loaded from the row, not the body). Nothing else on the
   row is editable here — date, period and doctor are not the same edit, and
   changing them is still delete-and-recreate. No audit call is needed: the
   audit middleware logs every non-GET request automatically.

5. The Annual Planner:
   - `PlanningActionIn` gains
     `compensation: ExtraSessionCompensation | None = None`, documented with
     the "Payment on insert, unchanged on update" rule from the Design
     Decisions, and noted as meaningful only for `extra_session` (the way
     `notes` is noted as meaningless for `clear`).
   - `PlanningSkipReason` gains `"toil_not_entitled"`.
   - In `apply_planning_bulk`'s section 4 (`extra_session`), after the
     `leave_exists` / `blocked_exists` skips: a `compensation ==
     ExtraSessionCompensation.TOIL` action for a doctor whose type is not in
     `LEAVE_WEEKS_BY_DOCTOR_TYPE` is a **skip** with reason
     `"toil_not_entitled"`, *not* a 422 that fails the batch. The endpoint's
     established line is that only a client bug (a weekend, an unknown doctor
     id) fails the whole batch; this is a legitimate state a stale grid can
     produce, so it joins `outside_doctor_dates` in the skip list.
   - The existing-row branch currently reads
     `if existing.notes == action.notes: skip duplicate`. Extend it: compute
     `wanted = action.compensation if action.compensation is not None else
     existing.compensation`; the action is a `duplicate` skip only when
     `existing.notes == action.notes and existing.compensation == wanted`,
     otherwise both fields are written and it counts as **applied** — the same
     treatment a changed note already gets.
   - The insert branch writes
     `compensation=action.compensation or ExtraSessionCompensation.PAYMENT`.
   - `doctors[action.doctor_id]` is already in scope for the window check, so
     the entitlement test needs no extra query.

6. Tests:
   - `test_extra_sessions.py`: the default on an omitted field; TOIL accepted
     for a partner and refused (422) for a locum on create; PATCH round trip
     Payment→TOIL and back; PATCH 404; PATCH TOIL on a locum row → 422.
   - `test_leave_planning.py`: an `extra_session` action with
     `compensation: "TOIL"` writes it; the same action repeated is a
     `duplicate` skip; a compensation-only change on an existing row counts as
     applied; an action omitting `compensation` on an existing **TOIL** row
     leaves it TOIL (the regression this nullability exists for); a TOIL action
     for a locum is a `toil_not_entitled` skip and the rest of the batch still
     applies.

## Task 3: Backend — the TOIL credit

**A.** Tasks 1–2 are done: compensation is stored and settable everywhere.
Balances still ignore it. This task makes a TOIL session worth a leave session.

**B.** Files:

- `backend/app/toil_credit.py` — new.
- `backend/app/leave_entitlement.py` — `EntitlementBreakdown`,
  `build_entitlement`.
- `backend/app/api/schemas/leave_entitlement.py` — `LeaveEntitlementOut`,
  new `ToilSkipsOut`.
- `backend/app/api/routers/leave_entitlement.py` — `_load_year_inputs`,
  `_build_out`, `list_entitlements`.
- `backend/tests/test_engine/test_toil_credit.py` — new. Note the directory:
  the pure-logic tests for `app/leave_charging.py` and
  `app/leave_entitlement.py` both live under `tests/test_engine/` despite not
  being engine modules, and this module follows its two siblings.
- `backend/tests/test_engine/test_leave_entitlement.py`,
  `backend/tests/test_api/test_leave_entitlement_endpoint.py`.

**C.**

1. `toil_credit.py`, modelled on `leave_charging.py`:
   - Reason constants `SKIP_ON_LEAVE`, `SKIP_BLOCKED`, `SKIP_CLOSED`,
     `SKIP_OUTSIDE_WINDOW`, declared in precedence order, with an `_ALL_REASONS`
     tuple as `leave_charging` has.
   - `credit_skip_reason(entry, leave_slots, blocked_slots, closed, doctor) ->
     str | None`, pure. `leave_slots` and `blocked_slots` are
     `Container[tuple[int, date, Period]]` keyed by
     `(doctor_id, date, period)` — the shape `leave_planning._slot_keys`
     already produces — and `closed` is
     `Container[tuple[date, Period]]`, matching `leave_charging`'s. `doctor` is
     anything with the `doctor_window._HasWindow` shape; call
     `doctor_window.is_within_window` rather than re-deriving the comparison.
   - `summarise_toil_credit(entries, leave_slots, blocked_slots, closed,
     doctors_by_id) -> ToilCreditSummary` with `credited_sessions: Decimal`,
     `toil_entries: int`, `skipped_by_reason: dict[str, int]`. Payment entries
     are filtered *here*, not by the caller, so one function answers "how much
     TOIL did this doctor earn" from a doctor's whole extra-session list.
     Reads `doctor_id` off each entry, like `summarise_leave_charging`, so a
     mixed-doctor iterable summarises correctly.
   - `credited_sessions` is a `Decimal` even though it is always integral, so
     it composes with the rest of `leave_entitlement.py` without a cast at
     every call site.
   - A module docstring that says, in as many words, (a) why this is not
     `leave_charging.exemption_reason` — a future reader will try to merge them
     — and (b) the `BlockedEntry` caveat from the Design Decisions: blocked is
     not read by the staging copy loop, so this exclusion is a judgement about
     intent rather than a consequence of the copy.

2. `EntitlementBreakdown` gains `toil_sessions: Decimal`, and
   `build_entitlement` a `toil_sessions: Decimal = Decimal("0.0")` argument,
   added into `total` alongside carry-over and adjustment and quantised with
   them. For a doctor type with no entitlement the early-return branch sets it
   to `Decimal("0.0")`, matching how that branch zeroes carry-over and
   adjustment today — so a legacy hand-inserted TOIL row on an AHP still
   reports `None` entitlement rather than crashing or leaking a figure.

3. `_load_year_inputs` also loads the year's `ExtraSessionEntry` rows grouped
   by doctor, and builds the practice-wide `(doctor_id, date, period)` key sets
   for leave and for `BlockedEntry`. It returns a wider tuple; all three call
   sites (`list_entitlements`, `get_entitlement`, `upsert_entitlement`) must be
   updated. Two extra queries for the whole practice, in the same "the reads
   every balance needs, once" spirit — and note the leave key set is built from
   the `LeaveEntry` rows already loaded, not a second query.

4. `_build_out` calls `summarise_toil_credit` for the doctor's entries, passes
   `toil_sessions=summary.credited_sessions` into `build_entitlement`, and
   returns `toil_sessions` plus a `toil_skipped: ToilSkipsOut` breakdown
   (`on_leave`, `blocked`, `closed`, `outside_window`) — the same courtesy
   `exempt_by_reason` pays on the leave side, so a doctor who planned four TOIL
   sessions and was credited three can be told why. Extend
   `LeaveEntitlementOut`'s docstring "Entitlement" bullet, which currently
   enumerates the addends and would otherwise become wrong.

5. `remaining_sessions` needs no change: it is `total_sessions - used`, and the
   credit is already inside `total_sessions`.

6. `list_entitlements` currently drops an inactive doctor with no leave entries
   (`if not doctor.active and not entries: continue`). Widen it to keep an
   inactive doctor who has extra-session rows in the year too — otherwise a
   leaver whose last act was a TOIL session vanishes from the year they earned
   it in, and the year's totals stop adding up, which is the exact failure that
   filter's comment says it exists to prevent.

7. Tests, at both levels:
   - `test_engine/test_toil_credit.py`: each of the four skips in isolation;
     precedence when more than one applies; Payment entries filtered out; a
     mixed-doctor iterable.
   - `test_engine/test_leave_entitlement.py`: the credit lands in `total`; it
     is quantised with the other addends; the no-entitlement branch returns
     `toil_sessions=0.0` with everything else `None`.
   - `test_api/test_leave_entitlement_endpoint.py`: a TOIL session raises the
     doctor's `entitlement_sessions` by 1 and their `remaining_sessions` by 1;
     a Payment session does not; a TOIL session in December credits that year
     and not the next; each skip shows in `toil_skipped`; a locum with a
     hand-inserted TOIL row still reports `None` entitlement; an inactive
     doctor with a TOIL row and no leave appears in the list.

## Task 4: Frontend — Individual Leave tab

**A.** Tasks 1–3 are done: the backend stores, validates and credits
compensation. No UI exposes it.

**B.** Files:

- `frontend/src/api/types.ts` — `ExtraSessionCompensation`, `ExtraSessionEntry`,
  `ExtraSessionIn`, `LeaveEntitlement`, `ToilSkips`.
- `frontend/src/api/extraSessions.ts` — `useUpdateExtraSession`.
- `frontend/src/components/ExtraSessionsSection.tsx` (+ its test)
- `frontend/src/components/LeaveEntitlementSummary.tsx` (+ its test)
- `frontend/src/routes/LeavePage.tsx` (+ its test) — passes leave and blocked
  rows down.
- `frontend/src/test/msw/handlers.ts`

**C.**

1. Add the wire types, mirroring `enums.py` by *value*:
   `export type ExtraSessionCompensation = "TOIL" | "Payment"`. Add
   `compensation` to `ExtraSessionEntry` (required — the server always sends
   it) and to `ExtraSessionIn` as optional. Add `toil_sessions: string` and
   `toil_skipped: ToilSkips` to `LeaveEntitlement`.

2. `useUpdateExtraSession` in `extraSessions.ts`, mirroring the existing
   mutations: `apiClient.patch<ExtraSessionEntry>(`/extra-sessions/${id}`,
   { compensation })`, invalidating `extraSessionKeys.all` **and**
   `leaveKeys`' entitlement query — a compensation change moves a balance, which
   `useCreateExtraSession` did not have to think about. The existing comment
   about *not* invalidating `rotaKeys` is still true and still for the same
   reason; extend it rather than replacing it. `apiClient.patch` already
   exists.

3. `ExtraSessionsSection`:
   - A **Compensation** select in the add form beside Period, defaulting to
     **Payment**, sending it on submit.
   - A **Compensation** column in the table with an inline select that PATCHes
     on change.
   - Whether TOIL is offerable is a per-doctor question, and this section's
     list can span doctors (the tab's "All doctors" option). The add form uses
     the selected doctor; each table row uses **that row's** doctor, from the
     `doctorsById` map the component already builds. A helper
     `canTakeToil(doctorType)` over the three entitled types, mirroring the
     server rule client-side — do not let the 422 be the first line of defence,
     per the weekday precedent in this file. When it is not offerable, disable
     the TOIL option and state the reason in the same place the existing "this
     doctor is inactive" hint sits.
   - The **superseded flag**: a new prop carrying the doctor's leave and
     blocked `(date, period)` keys for the year. `LeavePage` already calls
     `useLeave(doctorId, year)`; blocked comes from `GET
     /leave-planning/blocked`, which the page does not yet call — add it there,
     not here, so this component keeps having no data-fetching of its own. A
     row whose slot carries leave or blocked renders muted with
     "superseded by leave — not credited" / "blocked — not credited" next to
     the compensation. Show it for Payment rows too; the row is equally not
     going to be worked, and the wording just drops the "not credited" clause.

4. `LeaveEntitlementSummary`: `adjustmentNotes` gains a `TOIL credited: +N`
   line when `toil_sessions` is non-zero, and a second line when any credit was
   withheld, summing `toil_skipped` and naming the reasons present ("2 TOIL
   sessions not credited — covered by leave, practice closure"). This is the
   screen where the +1 has to be visible and explicable; an entitlement that
   silently grew is worse than no feature. Extend the component's docstring
   accordingly — it currently enumerates what moves a balance.

5. `handlers.ts`: add a `PATCH /api/v1/extra-sessions/:id` handler, and give
   the existing extra-session and entitlement handlers the new fields so
   unrelated tests do not start reading `undefined`.

## Task 5: Frontend — Annual Planner

**A.** Tasks 1–4 are done; the Individual Leave tab is complete. The planner
still creates extra sessions without asking, which would make the two creation
paths disagree.

**B.** Files:

- `frontend/src/api/types.ts` — `PlanningActionIn`, `PlanningSkipReason`
- `frontend/src/lib/planningMonth.ts` (+ its test) — **required, not
  conditional**: see step 2.
- `frontend/src/components/PlanningCellPopover.tsx` (+ a new test file)
- `frontend/src/components/LeavePlanningGrid.tsx` (+ its test)
- `frontend/src/components/LeaveYearCalendar.tsx` (+ its test)

Not in this task: `exportLeavePlanning.ts` / `exportStyles.ts`. The export
renders the `E` code and the cell note, and step 3 keeps both unchanged.
Re-run its tests to confirm, but expect no edit.

**C.**

1. `PlanningActionIn` gains `compensation?: ExtraSessionCompensation | null`
   and `PlanningSkipReason` gains `"toil_not_entitled"`.

2. `planningMonth.ts` must carry compensation through the pending-edit
   pipeline, or a compensation-only change is silently dropped.
   `buildPlanningActions` currently emits nothing when
   `before === after && notesBefore === notesAfter`, and switching a cell from
   Payment to TOIL changes neither. Specifically:
   - `PendingEdit` gains `compensation: ExtraSessionCompensation | null`
     (null for any state other than `extra_session`, the way `notes` is
     cleared for `normal`).
   - `PlanningActionsInput` gains an `extraCompensation: Map<string,
     ExtraSessionCompensation>` built from the loaded `ExtraSessionEntry`
     rows, alongside the existing `extraNotes` map (a `toCompensationMap`
     helper beside `toNotesMap`).
   - The no-op filter becomes `before === after && notesBefore === notesAfter
     && compBefore === compAfter`, and the emitted `extra_session` action
     carries `compensation`.
   - Unit tests for each: a compensation-only change emits one
     `extra_session` action and no `clear`; a state change to
     `extra_session` carries the chosen compensation; a change away from
     `extra_session` emits the `clear` and no compensation.

3. `PlanningCellPopover` gains a **Compensation** select, rendered only when
   `draftState === "extra_session"`, defaulting to Payment. The grid's
   selection is single-doctor by construction (`selection.doctorId`, consumed
   by `selectionCells`), so the doctor is unambiguous and TOIL can be disabled
   with the reason stated for a non-entitled one, exactly as in Task 4. Add the
   field to the prefill `useEffect` and to `handleApply`'s payload, and to
   `LeavePlanningGrid`'s uniformity check — a selection whose cells differ only
   in compensation is *not* uniform and must fall back the way a mixed one
   does.

4. The grid cell code stays **`E`** for both kinds. The planner's one-letter
   codes are a coverage-reading aid and a fourth letter would crowd a dense
   grid; compensation goes in the cell `title` instead, which is where the
   grid's other secondary facts already live. Revisit only if admins ask.

5. Handle `toil_not_entitled` wherever `LeavePlanningGrid` renders the bulk
   response's skips (around the existing `outside_doctor_dates` message), with
   a message naming the doctor type, so a skipped action does not read as
   applied.

6. `LeaveYearCalendar`: add the compensation to the day's `title` for a day
   carrying an extra session, and — for the `leave-and-extra` state it already
   models — say the extra session is superseded. The colour scale and the
   legend do not change; compensation is not a coverage fact.

## Task 6: Review and documentation

**A.** Tasks 1–5 are complete and the feature is live.

**B.** Files: `documentation/architecture-clinical.md`,
`documentation/architecture.md` if anything shared moved, and this plan file.

**C.**

1. In `architecture-clinical.md`, update the extra-sessions and Individual
   Leave sections:
   - Compensation exists, with the two values and the "existing rows are
     Payment" backfill.
   - TOIL credits the entitlement **at read time**, as a fourth addend
     alongside carry-over and adjustment, and `adjustment_sessions` was
     deliberately not reused.
   - The credit's four exclusions, the reason they are **not**
     `leave_charging`'s, and the `BlockedEntry` caveat (planner-only, so that
     one exclusion is a judgement about intent).
   - The template-row case that is deliberately *not* excluded, and why.
   - December TOIL taken in January is corrected through `carry_over_sessions`.
   - Leave still does not delete a superseded extra session; the flag is a
     display change, computed client-side from leave and blocked only.
   - The bulk endpoint's null-means-unchanged compensation, and why it differs
     from the POST's default.
2. Check the `/leave/entitlement` description still matches what the endpoint
   returns now that the total has a fourth addend and the response carries
   `toil_skipped`.
3. Delete `documentation/toil_extra_sessions_plan.md`.
