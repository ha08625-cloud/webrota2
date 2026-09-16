# Plan — TOIL or payment for extra sessions

Provisional plan (workflow stage 1). Not yet an implementation plan.

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
can be overtaken by events. Three cases, all reachable today:

1. **Leave booked over the slot.** `POST /leave/bulk` and
   `POST /leave-planning/bulk` both leave a covering extra session in place and
   merely *report* it as `superseded_extra_sessions`. Leave wins in the staging
   copy loop, so the doctor does not work that session.
2. **A practice closure added over the slot** after the session was planned.
3. **The employment window shortened** past the date after the session was
   planned. (Both create paths refuse an out-of-window date up front, but
   `Doctor.start_date` / `end_date` are editable afterwards.)

In all three the doctor does not work the session, so crediting TOIL for it
would hand out leave that was never earned. The credit therefore applies the
same three exclusions at read time.

**This is not `leave_charging.exemption_reason` and must not reuse it.** That
predicate exempts a slot whose template row is `NO_SURGERY` or missing — which
is precisely the *normal* case for an extra session, the whole point being a
doctor working a slot they do not normally work. Reusing it would zero almost
every credit. The TOIL predicate is its own, smaller thing: leave on the slot,
a closure on the slot, or outside the employment window. Its home is a new
`backend/app/toil_credit.py`, mirroring `leave_charging.py`'s shape (a pure
per-entry predicate plus a summariser, no DB access) and for the reason that
module gives — the rules carry the design decisions and are worth unit-testing
without a `TestClient`.

Weekends need no exclusion: both create paths already reject them, and there is
no later edit that can turn a weekday into a Saturday.

### Existing rows become Payment

The column is `NOT NULL` with `server_default 'Payment'`, so every row in
production today reads as Payment. Nothing was ever credited as TOIL before, so
this leaves every historical leave balance exactly as it stands — a nullable
"not yet decided" state would instead light up every old row as an unresolved
to-do, and would need a "must choose" rule to stop the blank state spreading to
new ones. Anything that should have been TOIL is corrected by editing the row,
which is what the new PATCH exists for.

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

It does not buy that. It addresses one of the three cases above; a closure or a
window edit still strands a planned session that never happens, so the
read-time exclusions are needed either way. Against that it is destructive and
asymmetric: bulk leave writes every weekday in a range, so one mis-typed end
date would silently destroy several planned extra sessions, and removing the
leave afterwards would not bring them back. It also reverses an explicit
decision recorded in both endpoints ("Reported, never deleted and never a 409 —
the row itself stays as the record of intent").

The real gap it is reaching for is that `superseded_extra_sessions` is
*transient*: it is reported once in the save response and is gone on the next
refresh, so nothing on screen afterwards says why a planned session is being
ignored. That is worth fixing, as a **display** change rather than a cascade
delete — flag such rows in `ExtraSessionsSection` and on `LeaveYearCalendar` as
"superseded by leave", with a delete button next to the flag so the admin
clears it deliberately. It stands alone and is not a prerequisite: this plan's
Task 5 adds that flag for TOIL rows, where it doubles as the explanation for a
credit that did not accrue. Extending it to Payment rows is a small follow-up
ticket if wanted.

### One weekday session is one session

Extra sessions are half days, and leave is counted in sessions throughout —
"one session = one AM or PM half day". A TOIL extra session is therefore worth
exactly 1.0, never 0.5 and never a day. No new unit enters the system.

## Task 1: Data model and migration

**A.** Nothing is done yet. This task adds the stored field and nothing that
reads it.

**B.** Files:

- `backend/app/models/enums.py` — new `ExtraSessionCompensation`.
- `backend/app/models/extra_session.py` — the new column.
- `backend/alembic/versions/021_extra_session_compensation.py` — new.
- `backend/tests/test_models.py`, `backend/tests/test_datatypes.py` — wherever
  the enum registry and model shapes are asserted.

**C.**

1. Add to `models/enums.py` (not to the domain package — see architecture.md's
   named exception: that file is the registry migration `001`'s `_enum()`
   helper and `enum_col` both read):

   ```python
   class ExtraSessionCompensation(str, enum.Enum):
       TOIL = "TOIL"
       PAYMENT = "Payment"
   ```

   Title-case values, matching every other enum in the file.

2. On `ExtraSessionEntry`, a non-nullable `compensation` column using
   `enum_col(ExtraSessionCompensation)`, with `default=PAYMENT` **and**
   `server_default="Payment"`. Both: the Python default serves ORM inserts, the
   server default serves the migration's backfill and any row inserted outside
   the app.

3. Migration `021`, revises `020`. It must produce exactly what
   `Base.metadata.create_all()` produces, since the test suite builds SQLite
   from the models and CI round-trips the chain against Postgres 16.
   - On Postgres, create the native `extra_session_compensation` type
     explicitly with `checkfirst`, then add the column referencing it with
     `postgresql.ENUM(create_type=False)` — the pattern migration `001`
     documents. On SQLite use plain `sa.Enum`.
   - `downgrade()` drops the column and then the type. The CI round trip
     exercises both directions, so a left-behind type will fail the build.
   - The column goes on as `nullable=False` with the server default in one
     step; there is no pre-existing null state to backfill separately.

4. Note in the migration docstring *why* Payment is the default — the accrual
   consequence, not just the mechanics.

## Task 2: Backend — write paths

**A.** The column exists and defaults to Payment. Nothing sets it yet and
nothing reads it.

**B.** Files:

- `backend/app/api/schemas/extra_session.py`
- `backend/app/api/routers/extra_sessions.py`
- `backend/app/api/schemas/leave_planning.py`
- `backend/app/api/routers/leave_planning.py`
- `backend/tests/test_api/test_extra_sessions.py`,
  `backend/tests/test_api/test_leave_planning.py`

**C.**

1. `ExtraSessionIn` gains `compensation: ExtraSessionCompensation =
   ExtraSessionCompensation.PAYMENT`. Defaulted, not required, so an existing
   API client keeps working and keeps meaning what it meant.
   `ExtraSessionOut` inherits it.

2. `create_extra_session` validates it: a `TOIL` request for a doctor whose
   `doctor_type not in LEAVE_WEEKS_BY_DOCTOR_TYPE` is a **422** naming the type
   and the reason, worded like `upsert_entitlement`'s refusal. Order it after
   the existing doctor-exists / weekend / window checks, so a request failing
   more than one still reports the most specific fact first.

3. New **`PATCH /extra-sessions/{id}`** taking `{compensation}` only, returning
   `ExtraSessionOut`. Required for correcting a backfilled row, and for the
   ordinary "this one's going to be TOIL after all" edit; delete-and-recreate is
   not an acceptable substitute when the planner has already been printed. Same
   422 rule as the POST. 404 for an unknown id. Nothing else on the row is
   editable here — date, period and doctor are not the same edit, and changing
   them is still delete-and-recreate.

4. The Annual Planner: the `extra_session` action in `LeavePlanningBulkIn`
   gains the same defaulted field, and the extra-session loop in
   `create_bulk_planning` writes it. Two existing-row rules to settle
   explicitly, next to the `notes` handling that already makes this choice:
   - An `extra_session` action on a slot that already has one and where **only**
     the compensation differs is an **update**, counted as applied — the same
     treatment a changed note gets.
   - A TOIL action for a non-entitled doctor is a **skip** with a new reason
     (`"toil_not_entitled"`), *not* a 422 that fails the batch. The bulk
     endpoint's established line is that only a client bug (a weekend, an
     unknown doctor id) fails the whole batch; this is a legitimate state a
     stale grid can produce, so it joins `outside_doctor_dates` in the skip
     list.

5. Tests: the default on an omitted field; TOIL accepted for a partner and
   refused for a locum on both create paths; PATCH round trip; the planner
   compensation-only update counting as applied; the new skip reason.

## Task 3: Backend — the TOIL credit

**A.** Compensation is stored and settable everywhere. Balances still ignore
it. This task makes a TOIL session worth a leave session.

**B.** Files:

- `backend/app/toil_credit.py` — new.
- `backend/app/leave_entitlement.py` — `EntitlementBreakdown`, `build_entitlement`.
- `backend/app/api/schemas/leave_entitlement.py` — `LeaveEntitlementOut`.
- `backend/app/api/routers/leave_entitlement.py` — `_load_year_inputs`, `_build_out`.
- `backend/tests/test_toil_credit.py` — new;
  `backend/tests/test_leave_entitlement.py`,
  `backend/tests/test_api/test_leave_entitlement_endpoint.py`.

**C.**

1. `toil_credit.py`, modelled on `leave_charging.py`:
   - Reason constants `SKIP_ON_LEAVE`, `SKIP_CLOSED`, `SKIP_OUTSIDE_WINDOW`.
   - `credit_skip_reason(entry, leave_slots, closed, start_date, end_date) ->
     str | None`, pure, taking plain containers.
   - `summarise_toil_credit(entries, ...) -> ToilCreditSummary` with
     `credited_sessions`, `toil_entries`, `skipped_by_reason`. Payment entries
     are filtered here, not by the caller, so one function answers "how much
     TOIL did this doctor earn" from a doctor's whole extra-session list.
   - A module docstring that says, in as many words, why this is not
     `leave_charging.exemption_reason` — a future reader will try to merge them.
   - Reuse `doctor_window.is_within_window` rather than re-deriving the window
     comparison.

2. `EntitlementBreakdown` gains `toil_sessions: Decimal`, and
   `build_entitlement` a `toil_sessions: Decimal = Decimal("0.0")` argument,
   added into `total` alongside carry-over and adjustment and quantised with
   them. For a doctor type with no entitlement it returns `0.0` with everything
   else already `None`, matching how that branch zeroes carry-over and
   adjustment today.

3. `_load_year_inputs` also loads the year's `ExtraSessionEntry` rows grouped by
   doctor, and builds the per-doctor set of leave `(date, period)` keys it
   already has the entries for. One extra query for the whole practice, in the
   same "three reads every balance needs" spirit.

4. `_build_out` calls the summariser and passes the credit through, and
   `LeaveEntitlementOut` gains `toil_sessions` plus a small
   `toil_skipped: ToilSkipsOut` breakdown — the same courtesy
   `exempt_by_reason` pays on the leave side, so a doctor who planned four TOIL
   sessions and was credited three can be told why.

5. `remaining_sessions` needs no change: it is `total_sessions - used`, and the
   credit is already inside `total_sessions`.

6. Tests, at both levels: credit appears in the total; a Payment session does
   not; each of the three skips; a TOIL session in December credits that year
   and not the next; a non-entitled doctor with a (legacy, hand-inserted) TOIL
   row still reports `None` entitlement rather than crashing.

## Task 4: Frontend — Individual Leave tab

**A.** The backend stores, validates and credits compensation. No UI exposes it.

**B.** Files:

- `frontend/src/api/types.ts` — `ExtraSessionCompensation`, `ExtraSessionEntry`,
  `ExtraSessionIn`, `LeaveEntitlement`.
- `frontend/src/api/extraSessions.ts` — `useUpdateExtraSession`.
- `frontend/src/components/ExtraSessionsSection.tsx` (+ its test)
- `frontend/src/components/LeaveEntitlementSummary.tsx` (+ its test)
- `frontend/src/routes/LeavePage.tsx` (+ test) if the doctor type needs passing
  down.
- `frontend/src/test/msw/handlers.ts`, `frontend/src/test/fixtures/reference.ts`

**C.**

1. Add the wire types. `useUpdateExtraSession` mirrors the existing mutations,
   including the comment about *not* invalidating `rotaKeys` — still true, and
   still for the same reason.

2. `ExtraSessionsSection`: a **Compensation** select in the add form beside
   Period, defaulting to **Payment** (the status quo, and the commoner case
   until told otherwise), and a **Compensation** column in the table with an
   inline select that PATCHes on change. The section already has the selected
   doctor; it needs that doctor's `doctor_type` to decide whether TOIL is
   offerable — available from the `useDoctors(false)` map it already builds, so
   no new prop. When it is not offerable, the TOIL option is disabled with the
   reason stated in the same place the existing "this doctor is inactive" hint
   sits, rather than left to fail on submit. Mirror the server rule
   client-side; do not let the 422 be the first line of defence, per the
   weekday precedent in that file.

3. `LeaveEntitlementSummary`: `adjustmentNotes` gains a
   `TOIL credited: +N` line when non-zero, and a skipped line when any credit
   was withheld ("2 TOIL sessions not credited — covered by leave"). This is
   the screen where the +1 has to be visible and explicable; an entitlement
   that silently grew is worse than no feature.

## Task 5: Frontend — Annual Planner

**A.** Tasks 1–4 are done; the Individual Leave tab is complete. The planner
still creates extra sessions without asking, which would make the two creation
paths disagree.

**B.** Files:

- `frontend/src/api/leavePlanning.ts`, `frontend/src/api/types.ts`
- `frontend/src/components/PlanningCellPopover.tsx` (+ test)
- `frontend/src/components/LeavePlanningGrid.tsx` (+ test)
- `frontend/src/lib/planningMonth.ts` if the cell state carries it
- `frontend/src/lib/exportLeavePlanning.ts`, `exportStyles.ts`
- `frontend/src/components/LeaveYearCalendar.tsx` (+ test)

**C.**

1. The bulk action type gains `compensation`, and `PlanningCellPopover` gains
   the control — visible only once "Extra session" is the chosen action, and
   with TOIL disabled for a non-entitled doctor as in Task 4.

2. The grid cell code stays **`E`** for both kinds. The planner's one-letter
   codes are a coverage-reading aid and a fourth letter would crowd a dense
   grid; compensation goes in the cell `title` instead, which is where the
   grid's other secondary facts already live. Revisit only if admins ask.

3. The **superseded flag** from the Design Decisions section, scoped here to
   TOIL rows: in `ExtraSessionsSection`'s table and in `LeaveYearCalendar`'s
   cell title, a row whose slot also carries leave reads as "superseded by
   leave — not credited". The calendar already resolves that precedence for
   colour; this makes the accounting consequence legible in the same place.

4. Handle the new `toil_not_entitled` skip reason wherever the grid renders
   the bulk response's skips, so a skipped action does not read as applied.

## Task 6: Review and documentation

**A.** Tasks 1–5 are complete and the feature is live.

**B.** Files: `documentation/architecture-clinical.md`,
`documentation/architecture.md` if anything shared moved, and this plan file.

**C.**

1. In `architecture-clinical.md`, update the extra-sessions and Individual
   Leave sections: compensation exists, TOIL credits the entitlement at read
   time, and the credit's three exclusions with the reason they are **not**
   `leave_charging`'s. Record that `adjustment_sessions` was deliberately not
   reused, and that leave still does not delete a superseded extra session.
2. Check the `/leave/entitlement` description still matches what the endpoint
   returns now that the total has a fourth addend.
3. Delete `documentation/toil_extra_sessions_plan.md`.
