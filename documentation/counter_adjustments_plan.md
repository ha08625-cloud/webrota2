# Implementation plan: counter adjustments (replacing opening balances)

Status: **implementation plan** (step 2 of the CLAUDE.md workflow), reviewed
against the shipped opening-balance feature at commit `65fef88`.

## Plan

The opening-balance feature works, but its framing is wrong for the way it is
actually needed. "Opening balance" describes one situation — a doctor who
joined part-way through — and has to be explained before anyone can use it.
The real need is broader: *this counter does not reflect a fair share, nudge
it*. A doctor on compassionate leave for a bereavement misses duty sessions
through no choice of their own; on return the counter reads them as
under-loaded and the engine hammers them until they catch up. An opening
balance can express that, but only by asking the admin to translate "give
them back about two duty sessions" into an absolute credit against a concept
that does not fit the case.

Note the boundary this does *not* cross: ordinary annual leave is not a case
for adjustment. Everyone has the same entitlement, so a doctor with a heavy
leave month genuinely is under-loaded and the engine is right to prefer them.
The adjustment exists for the exceptional absence, not the routine one.

**What we want and what is built are the same stored quantity.** The score is
already `(raw_count + opening_balance) / sessions_per_week`. A bereavement
nudge of "+2" is `opening_balance = current + 2`. Nothing in the data model
prevents it today. What prevents it is the label, the help text
(`CountersPage.tsx:178-182`, which talks only about mid-year joiners), and the
input shape — an absolute box you type a credit into rather than the number
you can see.

So this is not "build a new mechanism". It is "rename the concept, reshape the
input, and rewrite the explanation", on the storage that exists.

### Approaches considered

**A. Make `raw_count` itself editable** (the literal reading of "adjust the
counter directly"). Rejected, in increasing order of consequence:

1. **`raw_count` is `Integer`.** A peer-levelling credit is genuinely
   fractional (3.2). Making it `Numeric` ripples into `value_before` on both
   snapshot tables, both `increment_*` methods, and the `dict[..., int]`
   typing in `CounterState`.
2. **It destroys "work actually done".** `raw_count` is the only thing that
   answers "how many of these has Sam actually done" — the sanity check an
   admin reaches for when someone challenges a fairness figure. Folded in, the
   correction is unrecoverable.
3. **Scrap would silently revert adjustments.** `RotaClinicCounterSnapshot.
   value_before` captures `raw_count` pre-generation and scrap restores it, so
   an adjustment made during an open draft would vanish when that draft is
   scrapped, with no trace. The current separation is immune by construction,
   and `generate.py:547-565` already carries two special cases (clinic and
   system) to protect balances through a scrap.
4. **Duty cannot do it at all.** There is no stored duty counter — the count
   is a `func.count()` over `duty_assignments` (`routers/duty.py:131-141`). A
   stored delta row is unavoidable there, so this approach ends with *two*
   mechanisms rather than the one it was meant to produce.

**B. Keep the additive column; change the concept, the input and the prose
(chosen).** The admin edits the number they can see, the system stores the
delta behind it. Every invariant that makes the current design safe — the
engine never writes it, it is never snapshotted, it survives a scrap —
survives unchanged, because the storage does.

## Scope

In:

- Renaming `opening_balance` to `adjustment` across the model, engine, API,
  frontend and docs; renaming `duty_opening_balances` to
  `duty_counter_adjustments`.
- Dropping `duty_opening_balances.notes` (decision 5).
- Changing the three write endpoints to take a **target effective count**
  rather than a credit, deriving the stored delta server-side.
- Reshaping the Counters page and Duty grid controls: one box holding the
  effective count, plus −/+ steppers, with raw count and current delta as
  secondary text.
- Rewriting the help text and the draft warning.

Out:

- Any change to the score formula, to the engine's selection logic, or to
  which surfaces read the adjusted score. All three already do the right
  thing.
- Reception counters. `receptionWeightedScore.ts` divides by hours actually
  worked over the requested window, so the problem does not arise there.
- A ledger of individual adjustments (decision 5).

## Design decisions

**1. The stored quantity does not change.** `Numeric(5, 1)`, non-null, default
zero, added to `raw_count` before the division, written only by the admin
endpoints, never snapshotted, cleared by reset. The rename is the change; the
semantics are not. This is what keeps the migration trivial and keeps
`generate.py`'s scrap exceptions correct as written.

**2. The wire carries a target total; the server derives the delta.** The body
is `{"target_count": "14.0"}` meaning "make this counter read 14", and the
server stores `adjustment = target_count - raw_count` as raw stands at save
time. The response returns the resulting row, so the UI shows the delta it
produced.

The field is named `target_count` rather than `count` deliberately. The
response carries `raw_count` and `adjustment`; a request field called `count`
reads as though it might be either, and the entire point of this decision is
that the number the admin types and the number that gets stored are different.
The field name has to say which one it is.

The alternative — the client computing the delta and sending that — is
rejected because it reintroduces the exact confusion this ticket exists to
remove: the admin types a number and a different number is stored. It is also
wrong under staleness. If a generation runs between page load and save,
deriving server-side gives the admin the total they asked for against the work
that has actually happened, which is what "make it read 14" means.

**3. Negative deltas, and totals below the raw count, stay legal.** Typing a
total lower than the raw count stores a negative adjustment, which is the
mirror case the current design already allows and which a "this doctor was
over-allocated last quarter" correction needs. No sign constraint anywhere.

**4. Reset-to-zero sets both the raw count and the adjustment to zero**, on all
four reset endpoints, and duty adjustments stay year-scoped. Both survive the
reframing unchanged and for their original reasons: after a reset everyone is
level by definition, so a surviving adjustment reintroduces the skew it was
made to remove; and the duty count restarts on 1 January, so a December
bereavement nudge should expire with the count it adjusts. This is the current
behaviour and no endpoint's logic changes here — only the noun in the
comments.

**5. No reason/notes field, and no per-adjustment ledger.** `AuditLogEntry` is
written by middleware for every non-GET request, so each adjustment is already
recorded with actor, route, body and status — the "why is Sam +5?" question is
answerable, just not on the page. `duty_opening_balances.notes` is dropped
rather than carried through the rename: no UI path writes it (`DutyGrid.tsx`
never sends it; only the wire type at `api/duty.ts:77` mentions it), so it is a
half-built feature, and keeping a column nobody can fill is worse than not
having one. Note that this is the argument for dropping it — *not* "there is no
data to lose". The system is live on production (CLAUDE.md), so a claim about
production data is not available to us here; the claim that is available is
that no code path has ever written this column. If admins ask for reasons on
the page in practice, that becomes a follow-up with evidence behind it.

**6. The draft warning is rewritten, and the edit case is prose only.** Two
distinct interactions with an open draft, and they are resolved differently:

- *Reset during a draft.* A reset zeros both halves (decision 4), but a scrap
  restores only the raw count — the adjustment is never snapshotted, so
  clearing it is permanent whatever happens to the draft. The warning must say
  this, and must not imply a scrap "corrects" or "fixes" counters toward the
  reset.
- *Editing an effective total during a draft.* The raw counts shown on the page
  include an active draft's increments, so a total set during a draft and then
  scrapped reads *lower* than what was typed — raw falls back, the adjustment
  does not.

The second is new with this reframing and was considered for a stronger
mitigation (disabling the control during a draft, or showing the committed
baseline alongside the live raw count). **Rejected in favour of prose**, because
the stored delta is still exactly right: the admin who typed 14 against a raw
of 12 wanted +2 credited, and +2 is what survives the scrap. Only the displayed
*total* moves, and it moves because provisional work was genuinely undone.
Blocking a legitimate admin action to protect a display value is the wrong
trade. The page says it; the control stays live.

**7. The decision log names the adjustment.** `rationale.score()` renders
`raw 0 (+3.2 opening balance) / 4 sessions per week = 0.800`; the parenthetical
becomes `(+3.2 adjustment)`. The zero case still omits it entirely, so lines
for unadjusted doctors are unchanged.

**8. The one-decimal display wins over a bare integer.** The effective-count box
displays one decimal place consistently with every other session quantity on
the page, so saving `14` re-renders as `14.0`. The validator normalises either
way; this is only about what the box shows afterwards.

**9. The endpoint keying asymmetry stays.** The system endpoint is keyed on
`counter_id` in the path while the clinic one is keyed on `(doctor,
clinic_type)` in the body, because clinic rows are lazy and system rows are
seeded per doctor at creation. Unifying them would force the system endpoint to
handle a row it knows always exists. The asymmetry reflects a real difference
and is already documented in `routers/counters.py`'s module docstring.

**10. Tasks are cut by behaviour, not by layer, so every task ships green.**
There is no OpenAPI contract test in this repo and the frontend wire types are
hand-written, so a backend-only wire change leaves a frontend that compiles,
passes its fixture-backed tests, and is broken against the real API. A
layer-by-layer split (model → engine → API → frontend) would put at least one
such commit on main. Instead: Task 1 is a pure rename across every layer at
once, Task 2 changes the wire shape *including* the API client that calls it,
and Task 3 is presentational only. Each is independently green and separately
reviewable, and Task 2 — where all the actual risk is — gets looked at on its
own.

## Task 1: Rename, all layers, no behaviour change

**A.** Nothing has been done yet. This task is a pure rename plus the removal
of one dead column: `opening_balance` becomes `adjustment` everywhere, the duty
table is renamed, and `notes` is dropped. **No endpoint's behaviour, no
request or response shape beyond the field name, and no UI layout changes in
this task.** Backend and frontend suites must both be green at the end of it.

**B.** Files:

*Model and migration*
- `backend/app/models/counter.py`
- `backend/app/models/duty_opening_balance.py` → `duty_counter_adjustment.py`
- `backend/app/models/__init__.py`
- `backend/app/api/routers/doctors.py` (`PURGED_MODELS`, line ~139)
- `backend/alembic/versions/019_counter_adjustments.py` (new)

*Engine*
- `backend/app/engine/datatypes.py` (`CounterState`, lines ~246-294)
- `backend/app/engine/phases/phase2.py` (`_load_counter_state`, lines ~111-125)
- `backend/app/engine/phases/phase5.py` (`_Candidate.balance`, line 130;
  `_score_candidates`, line 149)
- `backend/app/engine/phases/_log_phase5.py` (lines 88, 111 — **easy to miss;
  it is the only caller passing `c.balance` into `rat.score()`**)
- `backend/app/engine/phases/_shared.py` (line 71)
- `backend/app/engine/phases/_log_phase9c.py` (lines 120, 130)
- `backend/app/engine/rationale.py` (`score()`, lines 56-73)
- `backend/app/engine/generate.py` (lines 547-565, **both** scrap exceptions)

`phase4.py`, `phase7_9a.py` and `phase9c.py` contain **no** balance references —
they reach the score through `_shared.py`. Do not go looking there.

*API*
- `backend/app/api/schemas/counter.py`, `schemas/duty.py`, `schemas/__init__.py`
  (lines 68, 73, 75, 157, 160)
- `backend/app/api/routers/counters.py`, `routers/duty.py`
- `backend/app/api/audit_descriptions.py` (lines 116, 177, 179)

*Frontend*
- `frontend/src/lib/weightedScore.ts`
- `frontend/src/api/types.ts` (lines ~751-755, 859-902)
- `frontend/src/api/counters.ts` (lines 13-17, 82-105), `api/duty.ts` (lines
  63-88)
- `frontend/src/components/OpeningBalanceInput.tsx` →
  `CounterAdjustmentInput.tsx`
- `frontend/src/routes/CountersPage.tsx`, `frontend/src/components/DutyGrid.tsx`
- `frontend/src/test/fixtures/reference.ts` (lines 194, 208)

*Tests* — rename in place; two test files are renamed:
- `backend/tests/test_models.py`, `test_api/test_doctors.py`
- `backend/tests/test_api/test_counter_opening_balance.py` →
  `test_counter_adjustment.py`
- `backend/tests/test_api/test_duty_opening_balance.py` →
  `test_duty_adjustment.py`
- `backend/tests/test_datatypes.py`, `test_engine/factories.py`,
  `test_engine/test_lifecycle.py`, `test_engine/test_phase2.py`,
  `test_phase4.py`, `test_phase5.py`, `test_phase7_9a.py`, `test_phase9c.py`,
  `test_rationale.py`
- `frontend/src/lib/weightedScore.test.tsx`, `api/counters.test.tsx`,
  `api/duty.test.tsx`, `routes/CountersPage.test.tsx`,
  `components/DutyGrid.test.tsx`

**C.**

*Model.* Rename `ClinicCounter.opening_balance` and
`SystemCounter.opening_balance` to `adjustment`, keeping the type, nullability,
Python default and `server_default` exactly as they are. Rename the table
`duty_opening_balances` to `duty_counter_adjustments`, the class
`DutyOpeningBalance` to `DutyCounterAdjustment`, its `sessions` column to
`adjustment`, and its unique constraint to
`uq_duty_counter_adjustment_doctor_year`; drop its `notes` column and the
`NOTES_MAX_LENGTH` constant. Rewrite both module docstrings around the new
framing (any exceptional reason a count misrepresents a fair share), keeping
the paragraphs that explain why the value is held apart from `raw_count`, why
it is not snapshotted and why reset clears it — those are still true and still
load-bearing. Update `PURGED_MODELS` to the new class name;
`test_doctors.py` carries a tripwire asserting it covers every FK targeting
`doctors`.

*Migration.* `019_counter_adjustments`, `down_revision = "018"`. The current
head is `018_doctor_type_nurse` — **not** `017_research_studies`. Rename the two
columns with `op.alter_column(..., new_column_name="adjustment")`, rename the
table with `op.rename_table`, rename its `sessions` column, and drop `notes`.
Use `op.batch_alter_table` for the constraint rename, per the SQLite rule in the
migrations section of `architecture-clinical.md`. Column and table renames
preserve data; the only loss is `notes`, which no code path has ever written
(decision 5) — say that in the docstring rather than claiming there is no
production data. Downgrade reverses the renames and re-adds `notes` nullable.

*Engine.* Rename `CounterState.clinic_balance`/`system_balance` to
`clinic_adjustment`/`system_adjustment`, and the accessors
`clinic_opening_balance`/`system_opening_balance` to
`clinic_adjustment_for`/`system_adjustment_for`. The `float` conversion at load
stays — `Decimal / float` raises `TypeError` and the precision buys nothing in
an in-memory sort key. `increment_*` still touches only the raw count.
`rationale.score()`'s `balance` parameter becomes `adjustment` and renders
`(+3.2 adjustment)`, still omitting the parenthetical when zero;
`phase5._Candidate.balance` becomes `adjustment` and both `_log_phase5.py` call
sites follow.

**No selection logic changes in this task.** The formula is identical; if a
phase test's expected allocation moves, something has been renamed wrong.

*API.* Rename the field on `ClinicCounterOut`, `SystemCounterOut` and
`DutyCountOut`. `_OpeningBalanceBase` becomes `_AdjustmentBase`, and
`ClinicOpeningBalanceIn`/`SystemOpeningBalanceIn`/`DutyOpeningBalanceIn` become
`ClinicAdjustmentIn`/`SystemAdjustmentIn`/`DutyAdjustmentIn`. **The request
field stays `sessions` and still means a credit in this task** — the wire shape
changes in Task 2. Drop `notes` from `DutyAdjustmentIn` and from the duty
upsert. Endpoint paths become `/counters/clinic/adjustment`,
`/counters/system/{counter_id}/adjustment` and `/duty/adjustment`; update the
three keys in `audit_descriptions.py` or `test_audit_descriptions.py` fails with
the missing keys. The four reset endpoints' comments take the new noun; their
logic does not change. The `(doctor × clinic type)` cross-product on
`GET /counters/clinic` stays, and its docstring's "the doctor the balance exists
for" reasoning is rewritten to the new framing without changing the behaviour.

*Frontend.* `computeWeightedScore`'s third argument becomes `adjustment`; it
stays a **required** `string` (a `Decimal` on the wire — `rawCount + adjustment`
on an unparsed string concatenates rather than adds, which is a silently wrong
number rather than a crash) and stays required so no caller can drop it
unnoticed. `parseBalance` becomes `parseAdjustment` and `formatOpeningBalance`
becomes `formatAdjustment`. The docstring's claim to mirror
`CounterState.weighted_clinic_score` must stay true — that mirror relationship
is load-bearing. `OpeningBalanceInput` becomes `CounterAdjustmentInput`,
`BALANCE_PATTERN` becomes `ADJUSTMENT_PATTERN`, `BALANCE_HINT` stays a hint but
takes the new noun. Update the two mutation hook names and their URLs, the
`ClinicOpeningBalanceIn`/`DutyOpeningBalanceIn` TS interfaces (dropping
`notes`), the column headers ("Adjustment"), the `aria-label`s and the
`data-testid` at `DutyGrid.tsx:251`, and the `RawCount` helper's prop name.

## Task 2: Wire shape — credit becomes target total

**A.** Task 1 is done: everything speaks of adjustments, the endpoints are at
their new paths, and both suites are green. The wire still takes a **credit**
(`{"sessions": "2.0"}` meaning "+2"). This task changes it to a **target
effective total**, server-derived. It touches the API *and* the frontend
client, because there is no OpenAPI contract test to catch drift between them
(decision 10) — the visible UI does not change in this task, only what it sends.

**B.** Files:

- `backend/app/api/schemas/counter.py`, `schemas/duty.py`
- `backend/app/api/routers/counters.py` (`set_clinic_adjustment`,
  `set_system_adjustment`), `routers/duty.py` (`set_duty_adjustment`)
- `backend/app/api/audit_descriptions.py` (wording only)
- `backend/tests/test_api/test_counter_adjustment.py`,
  `test_duty_adjustment.py`
- `frontend/src/api/counters.ts`, `api/duty.ts` and their tests
- `frontend/src/routes/CountersPage.tsx`,
  `frontend/src/components/DutyGrid.tsx` (call sites only — see C)

**C.** Replace `_AdjustmentBase.sessions` with `target_count`, keeping the same
`ge`/`le` bounds and the same one-decimal-place validator (rename the error
message and the method accordingly). The normalisation still matters for the
response, for the reason its current docstring gives.

Each endpoint resolves the raw count first, then stores `target_count -
raw_count`:

- `PUT /counters/clinic/adjustment` — body `doctor_id`, `clinic_type_id`,
  `target_count`. Still upserts the `ClinicCounter` row at `raw_count=0` if
  absent, so a pair with no row yet gets `adjustment = target_count`. Setting a
  zero adjustment still leaves the row in place: unlike the duty table, this row
  also carries a raw count that may be non-zero, so "no deviation" is not the
  same as "nothing to store".
- `PUT /counters/system/{counter_id}/adjustment` — body `target_count`. 404 for
  an unknown id; rows are seeded per doctor, so there is nothing to create.
- `PUT /duty/adjustment` — body `doctor_id`, `year`, `target_count`. Derives the
  delta against the `func.count()` over `duty_assignments` for 1 Jan–31 Dec of
  `year`, which the endpoint already computes for its response, and still
  **deletes the row when the derived delta is zero** so the table holds only
  real deviations.

**The duty derivation depends on an invariant worth stating in the docstring.**
`GET /duty/counts` counts over the caller's `from_date`/`to_date` range, while
this endpoint counts over the whole calendar year. Under the credit wire that
mismatch was invisible. Under a target total it is not: if a caller displayed a
partial-range count and the admin typed a total against it, the server would
derive the delta against a different raw count and store a silently wrong
number. It is safe today only because `DutyGrid`'s adjustment panel reads
`annualCountsData`/`annualRange` and is scoped to a whole year. Write that
down as a requirement on the caller, not as an accident.

Update the three `audit_descriptions.py` sentences to say the admin set a
counter's total rather than a credit.

*Frontend, this task.* Both mutation payloads take `target_count`. The existing
controls still edit the **adjustment**, so each call site converts before
sending: `target_count = raw_count + typed_adjustment`, using the `raw_count`
already on the row it is rendering. The server stores `target - raw`, which is
the typed adjustment exactly, so behaviour is unchanged end to end. This is a
deliberately throwaway two-line conversion that Task 3 deletes — it exists so
this task is shippable on its own.

*Tests.* The existing suites assert credit semantics throughout and need
rewriting, not renaming. Cover at minimum: a target above raw storing a
positive delta; a target below raw storing a negative one (decision 3); a
target equal to raw storing zero and, for duty only, deleting the row; a
clinic pair with no row getting `adjustment = target_count`; and the
staleness case — set a target, change `raw_count` underneath, set the same
target again, and assert the delta was re-derived against the new raw
(decision 2's whole justification).

## Task 3: The control, the prose and the warning

**A.** Tasks 1-2 are done: storage, engine and wire all speak of adjustments,
and the endpoints take a target total. The UI still shows a separate
"Adjustment" column holding a credit box, and converts to a target before
sending. This task makes the box hold the effective count directly.

**B.** Files:

- `frontend/src/components/CounterAdjustmentInput.tsx` and its consumers
- `frontend/src/routes/CountersPage.tsx` and `CountersPage.test.tsx`
- `frontend/src/components/DutyGrid.tsx` and `DutyGrid.test.tsx`
- `frontend/src/lib/weightedScore.ts` (`formatAdjustment` usage only)

**C.** The control becomes: a box holding the **effective count**
(`raw_count + adjustment`, one decimal per decision 8), `−` and `+` buttons
stepping it by one, a Save button live only while the text differs from the
saved effective count, and secondary text on the row reading e.g. `12 done, +2
adjusted` — omitting the second clause entirely when the adjustment is zero, so
unadjusted rows are as quiet as they are now. Save sends the typed total
(deleting Task 2's conversion); the response's `raw_count` and `adjustment` are
what the row re-renders from, so a delta derived against a raw count that moved
is visible immediately. The `useEffect` that follows the saved value must now
follow the derived effective count.

On `CountersPage`, the separate "Adjustment" column is **removed** and the "Raw
count" header becomes "Count", since the editable box now carries both jobs.
The `RawCount` helper folds into the control's secondary text. The invariant
from `architecture-clinical.md` still holds and must be checked in review: "how
many of these has this doctor actually done" stays answerable from the row.
The control keeps carrying **no** draft warning of its own.

On `DutyGrid`, the same control replaces the one already in its collapsed
"Opening balances" panel (`DutyGrid.tsx:273-304` — the grid can already set
these; this is a reshape, not a new capability). Decide explicitly whether the
panel stays collapsed by default: editing was a rare admin act when it meant
"credit a joiner", and is a somewhat less rare one now. Provisionally keep it
collapsed and rename it "Counter adjustments ({year})". The bolded "lowest
annual weighted score" keeps reading the adjusted score.

Rewrite the page's explanatory paragraph around exceptional absence, with the
mid-year joiner and the compassionate-leave return as the two worked examples,
and keep the levelling hint for the joiner case (peer score ÷ 10 × sessions per
week, added to their current count). State the boundary from the Plan section:
ordinary annual leave is not a case for adjustment. Add the one sentence
decision 8's drift implies — the box shows a total that grows as the doctor
works, so re-typing a number typed weeks ago *reduces* the adjustment rather
than reapplying it.

Rewrite `DRAFT_WARNING` per decision 6. It must cover both cases: a reset zeros
the count and the adjustment together, and a scrap restores the raw count but
never the adjustment, so that half of the reset is permanent; and a total set
while a draft is open will read lower if that draft is scrapped, because the
raw count falls back and the adjustment does not. It must not imply a scrap
"corrects" or "fixes" counters toward the reset.

## Task 4: Review and documentation

**A.** Tasks 1-3 are complete and the feature is live. This step is review and
documentation only.

**B.** Files: `documentation/architecture-clinical.md`,
`documentation/phase_pipeline.md`, and this plan.

**C.** In `architecture-clinical.md`:

- The **Opening balances** paragraph (line ~178) is rewritten: the noun, the
  broader framing, the target-total wire shape (decision 2), and the
  draft-edit case in decision 6, which the current text does not cover.
- The `duty_opening_balances` paragraph (line ~139) takes the new table name
  and loses its reference to `notes` (decision 5).
- The formula sentences at the top of "Counters and snapshots" (line ~163), the
  `CounterState` bullet (line ~33) and the scrap exception in the
  snapshot-lifecycle list (line ~183) keep their meaning and change their noun.
- The **CountersPage** entry (line ~469) needs more than a rename: it describes
  a separate balance column and an "any credit is shown beside the raw count
  (`3 (+3.2)`)" display that Task 3 replaces.

In `phase_pipeline.md`, correct the formula statements in the Phase 5 (line
~131) and Phase 9C (lines ~229, ~244) sections; Phase 4 and Phase 7-9A carry the
same sentence by reference and should be checked.

Then delete this file.
