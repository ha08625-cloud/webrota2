# Provisional plan: counter adjustments (replacing opening balances)

Status: **provisional plan** (step 1 of the CLAUDE.md workflow). Written
against the shipped opening-balance feature, not against the plan that
produced it.

## Problem

The opening-balance feature works, but its framing is wrong for the way it
is actually needed. "Opening balance" describes one situation — a doctor who
joined part-way through — and has to be explained before anyone can use it.
The real need is broader and simpler: *this counter does not reflect a fair
share, nudge it*. A doctor on compassionate leave for a bereavement misses
duty sessions through no choice of their own; on return the counter reads
them as under-loaded and they get hammered until they catch up. An opening
balance can express that, but only by asking the admin to translate "give
them back about two duty sessions" into an absolute credit figure against a
concept that does not fit the case.

Note the boundary this does *not* cross: ordinary annual leave is not a case
for adjustment. Everyone has the same entitlement, so a doctor with a heavy
leave month genuinely is under-loaded and the engine is right to prefer
them. The adjustment exists for the exceptional absence, not the routine one.

## The central finding

**What we want and what is built are the same stored quantity.** The score
is already `(raw_count + opening_balance) / sessions_per_week`. A bereavement
nudge of "+2" is `opening_balance = current + 2`. Nothing in the data model
prevents it today. What prevents it is the label, the help text
(`CountersPage.tsx:179`, which talks only about mid-year joiners), and the
input shape — an absolute box you type a credit into rather than the number
you can see.

So this ticket is not "build a new mechanism". It is "rename the concept,
reshape the input, and rewrite the explanation", on the storage that exists.

## Approaches considered

**A. Make `raw_count` itself editable (the literal reading of "adjust the
counter directly").** Rejected, for four reasons, in increasing order of
consequence:

1. **`raw_count` is `Integer`.** A peer-levelling credit is genuinely
   fractional (3.2). Making it `Numeric` ripples into `value_before` on both
   snapshot tables, both `increment_*` methods, and the `dict[..., int]`
   typing in `CounterState`.
2. **It destroys "work actually done".** `raw_count` is the only thing that
   answers "how many of these has Sam actually done" — the sanity check an
   admin reaches for when someone challenges a fairness figure. Folded in,
   the correction is unrecoverable.
3. **Scrap would silently revert adjustments.** `RotaClinicCounterSnapshot.
   value_before` captures `raw_count` pre-generation and scrap restores it,
   so an adjustment made during an open draft would vanish when that draft
   is scrapped, with no trace. The current separation is immune by
   construction, and `generate.py:556` already carries a special case to
   protect balances through a scrap.
4. **Duty cannot do it at all.** There is no stored duty counter — the count
   is a `func.count()` over `duty_assignments` (`routers/duty.py:131-141`).
   A stored delta row is unavoidable there, so this approach ends with *two*
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
- Dropping `duty_opening_balances.notes` (see decision 5).
- Changing the three write endpoints to take a **target effective count**
  rather than a credit, deriving the stored delta server-side.
- Reshaping the Counters page control: one box holding the effective count,
  plus −/+ steppers, with raw count and current delta as secondary text.
- Rewriting the help text and the draft warning.

Out:

- Any change to the score formula, to the engine's selection logic, or to
  which surfaces read the adjusted score. All three already do the right
  thing.
- Reception counters. `receptionWeightedScore.ts` divides by hours actually
  worked over the requested window, so the problem does not arise there.
- A ledger of individual adjustments. See decision 5.

## Design decisions

**1. The stored quantity does not change.** `Numeric(5, 1)`, non-null,
default zero, added to `raw_count` before the division, written only by the
admin endpoints, never snapshotted, cleared by reset. The rename is the
change; the semantics are not. This is what keeps the migration trivial and
keeps `generate.py`'s scrap exception correct as written.

**2. The wire carries a target total; the server derives the delta.** The
body is `{"count": "14.0"}` meaning "make this counter read 14", and the
server stores `adjustment = 14 - raw_count` as raw stands at save time. The
response returns the resulting row so the UI shows the delta it produced.

The alternative — the client computing the delta and sending that — is
rejected because it reintroduces the exact confusion this ticket exists to
remove: the admin types a number and a different number is stored. It is
also wrong under staleness. If a generation runs between page load and save,
deriving server-side gives the admin the total they asked for against the
work that has actually happened, which is what "make it read 14" means.

**3. Negative deltas, and totals below the raw count, stay legal.** Typing a
total lower than the raw count stores a negative adjustment, which is the
mirror case the current design already allows and which a "this doctor was
over-allocated last quarter" correction needs. No sign constraint anywhere.

**4. Reset-to-zero still clears the adjustment, and duty adjustments stay
year-scoped.** Both survive the reframing unchanged and for their original
reasons: after a reset everyone is level by definition, so a surviving
adjustment reintroduces the skew it was made to remove; and the duty count
restarts on 1 January, so a December bereavement nudge should expire with
the count it adjusts.

**5. No reason/notes field, and no per-adjustment ledger.** `AuditLogEntry`
is written by middleware for every non-GET request, so each adjustment is
already recorded with actor, route, body and status — the "why is Sam +5?"
question is answerable, just not on the page. `duty_opening_balances.notes`
is dropped rather than carried through the rename: it is written by no UI
path today (`DutyGrid.tsx` never sends it, only the wire type in
`api/duty.ts:77` mentions it), so it is a half-built feature, and keeping a
column nobody can fill is worse than not having one. If admins ask for
reasons on the page in practice, that becomes a follow-up with evidence
behind it.

**6. The draft warning must be rewritten, not just re-worded.** Today's
warning (`CountersPage.tsx:31`) explains that a scrap restores raw counts
but not balances, in the context of *resetting*. Editing an effective total
creates a second, sharper case: the raw counts shown on the page include an
active draft's increments, so a total set during a draft and then scrapped
reads *lower* than what was typed — raw falls back, the adjustment does not.
That is not a bug to fix (the adjustment is a deliberate permanent fact
about the doctor, not a fact about the draft), but the page has to say it.

**7. The decision log names the adjustment.** `rationale.score()` renders
`raw 0 (+3.2 opening balance) / 4 sessions per week = 0.800`; the
parenthetical becomes `(+3.2 adjustment)`. The zero case still omits it
entirely, so lines for unadjusted doctors are unchanged.

## Open questions

1. Should the Counters page's effective-count box accept a bare integer for
   the common nudge case and only require a decimal when one is meant? The
   validator normalises to one decimal place either way, so this is about
   whether the box re-renders `14` as `14.0` after saving. Provisionally:
   display the effective count with one decimal, consistently with every
   other session quantity on the page.
2. The system counters' endpoint is keyed on `counter_id` in the path while
   the clinic one is keyed on `(doctor, clinic_type)` in the body, because
   clinic rows are lazy and system rows are seeded. Worth unifying on the
   pair for both while we are renaming the endpoints anyway? Provisionally:
   no — the asymmetry reflects a real difference and is documented where it
   matters.

## Task 1: Data model and migration

**A.** Nothing has been done yet. This task renames the storage; nothing
that reads it moves in this task, so the tree will not typecheck until
Task 2 lands — Tasks 1 and 2 should be reviewed together.

**B.** Files: `backend/app/models/counter.py`,
`backend/app/models/duty_opening_balance.py` (renamed to
`duty_counter_adjustment.py`), `backend/app/models/__init__.py`,
`backend/app/api/routers/doctors.py` (`PURGED_MODELS`),
`backend/alembic/versions/018_counter_adjustments.py` (new; current head is
`017_research_studies`), `backend/tests/test_models.py`,
`backend/tests/test_api/test_doctors.py`.

**C.** Rename `ClinicCounter.opening_balance` and
`SystemCounter.opening_balance` to `adjustment`, keeping the type, nullability,
Python default and `server_default` exactly as they are. Rename the table
`duty_opening_balances` to `duty_counter_adjustments`, the class
`DutyOpeningBalance` to `DutyCounterAdjustment`, and its unique constraint
to `uq_duty_counter_adjustment_doctor_year`; drop its `notes` column and the
`NOTES_MAX_LENGTH` constant. Rewrite both module docstrings around the new
framing (any exceptional reason a count misrepresents a fair share), keeping
the paragraphs that explain why the value is held apart from `raw_count`,
why it is not snapshotted and why reset clears it — those are still true and
still load-bearing.

The system is not live, so the migration renames in place with no data
preservation concern; use `op.batch_alter_table` for the constraint rename,
per the SQLite rule in the migrations section of `architecture-clinical.md`.
Update `PURGED_MODELS` to the new class name — `test_doctors.py` carries a
tripwire asserting it covers every FK targeting `doctors`.

## Task 2: Engine and decision log

**A.** Task 1 is done: the storage is renamed and nothing compiles against
it yet.

**B.** Files: `backend/app/engine/datatypes.py`,
`backend/app/engine/phases/phase2.py` (`_load_counter_state`),
`backend/app/engine/rationale.py`, `backend/app/engine/generate.py` (the
scrap exception around line 556), `backend/app/engine/phases/phase4.py`,
`phase7_9a.py`, `phase9c.py`, `_log_phase9c.py`, `_shared.py`, `phase5.py`;
and the engine tests that name the old field
(`test_datatypes.py`, `test_phase2.py`, `test_phase4.py`, `test_phase5.py`,
`test_phase7_9a.py`, `test_phase9c.py`, `test_rationale.py`,
`test_lifecycle.py`, `factories.py`).

**C.** Rename `CounterState.clinic_balance`/`system_balance` to
`clinic_adjustment`/`system_adjustment` and the two accessor methods to
`clinic_adjustment_for`/`system_adjustment_for`. The `float` conversion at
load stays — `Decimal / float` raises `TypeError` and the precision buys
nothing in an in-memory sort key. `increment_*` still touches only the raw
count. `rationale.score()`'s `balance` parameter becomes `adjustment` and
renders `(+3.2 adjustment)`, still omitting the parenthetical when zero.

**No selection logic changes in this task.** The formula is identical; if a
phase test's expected allocation moves, something has been renamed wrong.

## Task 3: API

**A.** Tasks 1-2 are done: the storage and the engine both speak of
adjustments. The wire still says `opening_balance` and still takes a credit.

**B.** Files: `backend/app/api/schemas/counter.py`, `schemas/duty.py`,
`schemas/__init__.py`, `backend/app/api/routers/counters.py`,
`routers/duty.py`, `backend/app/api/audit_descriptions.py`,
`backend/tests/test_api/test_counter_opening_balance.py` and
`test_duty_opening_balance.py` (both renamed).

**C.** Rename `opening_balance` to `adjustment` on `ClinicCounterOut`,
`SystemCounterOut` and `DutyCountOut`. Replace the three `*OpeningBalanceIn`
bodies' `sessions` field with `count` — the **target effective total**, same
`Numeric(5,1)` validation and the same one-decimal-place normaliser.

Endpoint paths become:

- `PUT /counters/clinic/adjustment` — body `doctor_id`, `clinic_type_id`,
  `count`; still upserts the `ClinicCounter` row at `raw_count=0` if absent.
  Stores `count - raw_count`.
- `PUT /counters/system/{counter_id}/adjustment` — body `count`.
- `PUT /duty/adjustment` — body `doctor_id`, `year`, `count`. Derives the
  delta against a `func.count()` over `duty_assignments` for that calendar
  year, matching what `GET /duty/counts` reports for the same year, and
  still **deletes the row when the derived delta is zero** so the table
  holds only real deviations.

Update `audit_descriptions.py` for all three. The four reset endpoints keep
clearing the adjustment (decision 4); their comments need the new noun. The
`(doctor × clinic type)` cross-product on `GET /counters/clinic` stays, and
its docstring's "the doctor the balance exists for" reasoning is rewritten
to the new framing without changing the behaviour.

## Task 4: Frontend

**A.** Tasks 1-3 are done. The page still shows an opening-balance column
with an absolute credit box.

**B.** Files: `frontend/src/lib/weightedScore.ts` and its test,
`frontend/src/api/types.ts`, `api/counters.ts`, `api/duty.ts` and their
tests, `frontend/src/components/OpeningBalanceInput.tsx` (renamed
`CounterAdjustmentInput.tsx`), `frontend/src/routes/CountersPage.tsx` and its
test, `frontend/src/components/DutyGrid.tsx` and its test,
`frontend/src/test/fixtures/reference.ts`.

**C.** `computeWeightedScore`'s third argument becomes `adjustment`; it stays
a **required** `string` (a `Decimal` on the wire — `rawCount + adjustment` on
an unparsed string concatenates rather than adds, which is a silently wrong
number rather than a crash) and stays required so no caller can drop it
unnoticed. `formatOpeningBalance` becomes `formatAdjustment`. The docstring's
claim to mirror `CounterState.weighted_clinic_score` must stay true — that
mirror relationship is load-bearing.

The control becomes: a box holding the **effective count**
(`raw_count + adjustment`, one decimal), `−` and `+` buttons stepping it by
one, a Save button live only while the text differs from the saved effective
count, and secondary text on the row reading e.g. `12 done, +2 adjusted` —
omitting the second clause entirely when the adjustment is zero. Save sends
the typed total; the response's `raw_count` and `adjustment` are what the row
re-renders from, so a delta derived against a raw count that moved is visible
immediately. The column header becomes "Count" with the old "Opening balance"
column removed, since the editable box now carries both jobs. The control
keeps carrying **no** draft warning of its own.

Rewrite the page's explanatory paragraph around exceptional absence, with the
mid-year joiner and the compassionate-leave return as the two worked
examples, and keep a levelling hint for the joiner case (peer score ÷ 10 ×
sessions per week, added to their current count). Rewrite `DRAFT_WARNING` per
decision 6: it must now cover both the reset case and the edit case.

`DutyGrid` needs the same control in its counts panel — it currently reads
the balance but cannot set one — and its bolded "lowest annual weighted
score" keeps reading the adjusted score.

## Task 5: Review and documentation

**A.** Tasks 1-4 are complete and the feature is live. This step is review
and documentation only.

**B.** Files: `documentation/architecture-clinical.md`,
`documentation/phase_pipeline.md`, and this plan.

**C.** In `architecture-clinical.md`, the "Counters and snapshots" section's
**Opening balances** paragraph and the `duty_opening_balances` paragraph in
the data-model section both need rewriting: the noun, the broader framing,
the target-total wire shape (decision 2), the dropped notes column, and the
draft-edit case in decision 6, which the current text does not cover. The
formula sentences at the top of that section and the scrap exception in the
snapshot-lifecycle list keep their meaning and change their noun. In
`phase_pipeline.md`, correct the formula statements in the Phase 5 and
Phase 9C sections and check Phase 4 and Phase 7-9A for the same sentence.
Then delete this file.
