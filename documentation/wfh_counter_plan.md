# WFH Counter & Preference — Implementation Plan

**Status:** Implementation plan (workflow step 2). Reviewed and corrected against
the code. Ready for task breakdown.

## Plan

Add a third system counter, `wfh`, that tracks working-from-home sessions per
doctor, and a per-doctor `wfh_preference` weighting (none / less / normal /
more) on the Doctors page, mirroring the existing supervision-preference
system. The counter becomes the fairness ledger that a future WFH allocation
phase will select against.

## Scope

### In scope

- New `SystemCounterType.WFH` enum member, seeded per doctor like the existing two.
- New `Doctor.wfh_preference` column.
- Rename `SupervisionPreference` → `PreferenceWeight`, shared by both preference columns.
- A shared `PREFERENCE_MULTIPLIERS` table, lifted out of `_log_phase9c.py`.
- Counter write path: tally WFH sessions at generation, and adjust on the
  draft edits that change `is_wfh`.
- Doctors page WFH-preference dropdown; Counters page WFH rows (mostly free).
- Migration (015, DDL only) + backfill script for the new counter rows.

### Out of scope (separate plan)

- The WFH allocation phase itself: choosing *who* works from home when staff
  outnumber rooms.

### Why the allocation phase is a separate plan

Fold in the counter and the preference; keep the phase separate.

The counter and preference are data-model + CRUD + UI work with essentially no
scheduling-algorithm risk — a well-bounded single plan. The allocation phase is
a genuinely hard design problem that deserves its own discussion cycle:

- **Where in the pipeline does it run?** It must precede room resolution
  (Phase 7–9A) since the whole point is to shed people before rooms are
  contested, but it cannot run before Phase 4/5, because duty doctors and
  clinic holders are not candidates and their rooms shrink the pool. Probably
  a new Phase 6, between 5 and 7–9A.
- **How many people go home?** That depends on room supply per session, which
  is only knowable after duty and clinics have taken their rooms. This is a
  per-(week, day, period) capacity calculation that no existing phase does.
- **Interaction with Phase 9C.** `is_eligible_supervisor` and
  `count_supervisable_trainees` both exclude WFH slots, so sending people home
  can make a session unsupervisable — the new phase would have to reserve
  supervisors, or accept the warning.
- **Interaction with Phase 12.** `unresolved_room` already skips WFH slots, so
  the phase would silence warnings rather than create them, but the
  `wfh_on_incompatible_slot` question (template types, roles) is new.

Building the counter first is strictly useful: the phase needs it to exist, and
shipping it early means real WFH history accrues before the phase goes live, so
the first allocating generation starts from a true baseline rather than
all-zeros.

## Design Decisions

**D1. The counter counts every WFH session that was actually worked from home,
template WFH included.**
Not only engine-allocated WFH. The future phase must account for template WFH
anyway — otherwise a doctor with two fixed WFH template slots gets allocated
more on top of colleagues with none. One ledger, one meaning: "sessions this
doctor spent working at home." See D9 for the leave exclusion that "actually
worked" implies.

*Consequence to accept:* until the allocation phase exists the counter largely
restates the master template, and rises deterministically each generation. That
is informative for the fairness question, not a defect, but the Counters page
copy should not imply the engine is balancing it yet.

**D2. Manual WFH toggles in a draft adjust the counter.**
This deliberately diverges from the SUPERVISION counter, which is written at
generation time only (`patch_session`'s docstring states that rule explicitly —
it must be amended to say WFH is the exception and why). The justification:
`is_wfh` is toggled by hand far more than `is_supervising` is, via the cell-edit
popover, so a generation-only counter would visibly disagree with the committed
rota. No new machinery is needed — `swap-roles` already adjusts clinic counters
mid-draft, and the snapshot/scrap lifecycle restores them.

**D3. Two API write sites change `is_wfh` outside generation; both must adjust.**
- `PATCH /rota/{id}/sessions/{sid}` — `is_wfh` true/false, ±1.
- `POST /rota/{id}/sessions/{sid}/set-room` with a `room_id` — clears `is_wfh`
  as a side effect, −1. Its docstring currently says "No counter effect,
  matching swap-rooms"; that stops being true.
- Phase 4's `wfh_abandoned` is in-engine, so it is covered for free by D4's
  final-grid tally. It is not a third site to patch.

*Known pre-existing gap, deliberately not fixed here:* `swap-rooms` moves
`room_id` without touching `is_wfh`, so it can leave a session both WFH and
roomed. `dragRules.ts` blocks that in the UI (it refuses a room drop onto a
WFH target), so it is unreachable in practice, but the API permits it. It has
no counter effect either way — `is_wfh` does not change — so it needs no
adjustment call. Raise it separately if the API is ever driven directly.

**D4. Generation tallies the final grid, not incremental increments.**
A single pass over `grid.slots` at the end of the pipeline, incrementing WFH
once per qualifying slot. This is why D3's Phase 4 case needs no special
handling: a slot whose WFH was abandoned simply is not counted. It also means
the tally is correct no matter what a future allocation phase does or undoes.
Placement: a small step in `generate.py` before `_write_counters`.

**D5. `PreferenceWeight` replaces `SupervisionPreference`.**
Same four members and same wire values (`none`/`less`/`normal`/`more`), so the
frontend `z.enum` and API contract are unchanged in value — only the type name
moves. **18 files** reference the old name (not 12 as first estimated); the
rename is mechanical. The system is not live, so migration 015 can rename the
Postgres enum type outright.

**D6. Multiplier semantics are identical to supervision, and the table is shared.**
Selection is lowest-score-wins, so the existing table works unchanged for a perk
as well as a burden:

| Preference | Multiplier | Supervision meaning | WFH meaning |
|---|---|---|---|
| `none` | 1_000_000 | never supervises | never allocated WFH |
| `less` | 1.5 | supervises less often | gets WFH less often |
| `normal` | 1.0 | baseline | baseline |
| `more` | 0.66 | supervises more often | gets WFH more often |

Move `PREFERENCE_MULTIPLIERS` out of `_log_phase9c.py` into a neutral module
(`app/engine/preference.py`), re-exported from `_log_phase9c` so Phase 9C's
"selection and explanation read the same numbers" invariant is preserved.

**D7. `wfh_preference` governs allocation only; template WFH is always honoured
and always counted.** A doctor set to `none` who has a WFH row in the master
template still works from home on that slot, and it still counts. The preference
is an instruction to the (future) allocation phase, not a veto over the template.
Worth surfacing in the Doctors page help text, since "None" reads as "never" and
that contradiction will otherwise be reported as a bug.

**D8. The counter is written for every doctor; only the *display* is
Partner/Salaried.**
This corrects the provisional plan, where "Partner/Salaried only, matching
supervision" contradicted D1's "every WFH session" — a whole-grid tally
necessarily counts a Trainee with a template WFH row.

The existing precedent settles it, and `counters.py`'s module docstring already
states it: "the engine counts clinics and system events for whoever is
eligible", while both GETs filter to `_COUNTED_TYPES`. So:

- The tally (D4) and the manual adjustments (D3) apply to **every** doctor, with
  no `doctor_type` check. Nothing downstream needs one.
- The Counters page shows Partner/Salaried only, for free, via the existing
  `_COUNTED_TYPES` filter.
- Every doctor still gets a seeded WFH row at zero, preserving the
  unconditional "one row per doctor per counter type" invariant that
  `generate._write_counters`' `.scalar_one()` depends on.

The `wfh_preference` **dropdown** is separately gated to Partner/Salaried on the
Doctors page, matching `showSupervision`. That is a UI scope decision about the
page, not a rule about the column, which every doctor row carries.

**D9. Sessions on leave are excluded from the counter.**
A slot can be both `is_on_leave` and `is_wfh` — a template WFH row on a day the
doctor has booked off. The doctor did not work that session from home, so it
must not count, or the ledger overstates every part-time doctor who happens to
have a WFH template row on a frequently-taken day.

This matches how every engine phase already reads the pair: Phase 5, Phase 9C
and Phase 12 all test `is_on_leave` **before** `is_wfh` and treat leave as the
dominant fact. The tally does the same — `if slot.is_on_leave: continue`
before the WFH test.

*Consequence to accept — leave is derived, not stored.* `is_on_leave` is not a
column on `RotaSession` (see `models/rota.py`'s module docstring); it is
derived live from `LeaveEntry` at read time, via `_leave_lookup`. So the
counter records leave status **as of the moment of each write**, and leave
booked or cancelled later in the draft does not retroactively correct it. This
is drift, and it is accepted rather than engineered away:

- It is exactly how the clinic counters already behave — a clinic counted at
  generation is not decremented when the doctor later books leave over it.
- Re-tallying on commit would need new machinery and would break the
  snapshot/scrap contract, which restores raw counts to a pre-generation value
  the re-tally would immediately contradict.

The rule must be applied at **both** write paths, not just generation.
Excluding leave only in the tally would mean a hand-set WFH on a leave slot
counts while a templated one does not — the two paths must agree. `rota.py`
already has `_leave_lookup(db, config)` and both endpoints already load
`config`, so this is a lookup that is in scope, not new plumbing.

---

## Task 1: Data model changes

**A.** Nothing has been implemented yet. This task lands the enum, the column,
the counter type, the migration and the fixture updates, with no behaviour
change.

**B. Files and deliverables**

Model / schema:
- `backend/app/models/enums.py` — rename `SupervisionPreference` → `PreferenceWeight`; add `WFH = "wfh"` to `SystemCounterType`.
- `backend/app/models/doctor.py` — `wfh_preference` column, `PreferenceWeight`, NOT NULL, default/server_default `normal`.
- `backend/app/models/__init__.py` — export rename.
- `backend/app/api/schemas/doctor.py` — `wfh_preference` on `DoctorIn`/`DoctorPatch`/`DoctorOut`/`DoctorDetailOut`; type rename.
- `backend/app/api/schemas/counter.py` — the "SUPERVISION row for every doctor" docstring (~line 79) now names three types.
- `backend/app/api/routers/doctors.py` — seed `WFH` at doctor creation; update the counter-invariant docstring (~lines 54-62, which enumerates "(room_move, supervision)").
- `backend/app/engine/phases/_log_phase9c.py` — import rename only (the multiplier move is Task 2).

Seeding — **replace the hardcoded pairs with iteration over `SystemCounterType`**
so a fourth counter type never needs this edit again. Three sites hardcode the
pair today:
- `backend/app/api/routers/doctors.py:222`
- `backend/seed/seed_system_counters.py`
- `backend/seed/backfill_system_counters.py` (`_ALL_TYPES`)

Migration:
- `backend/alembic/versions/015_wfh_counter_and_preference.py` — **DDL only**, see C.

Test fixtures that hardcode `(ROOM_MOVE, SUPERVISION)` and will otherwise break
Task 2 (missing WFH rows make `_write_counters`' `.scalar_one()` raise
`NoResultFound`):
- `backend/tests/test_api/conftest.py` — two loops (~lines 385, 430).
- `backend/tests/test_api/test_leave_planning.py` (~line 70).
- `backend/tests/test_api/test_counter_reset.py` — `assert len(counter_ids) == 4` (~line 130) becomes 6; module docstring (~line 11) names three types.
- `backend/tests/test_api/test_doctors.py` (~lines 41-42) — assert three counter rows per doctor.
- `backend/tests/test_engine/factories.py`, `backend/tests/test_engine/test_phase9c.py`, `backend/tests/test_models.py` — follow the rename.

Frontend rename is Task 4; the backend rename does not break it, since the wire
values are unchanged.

**C. Migration 015 — the one genuinely tricky piece.**

Two corrections to the provisional plan, both of which would otherwise fail CI
(`ci.yml` runs `alembic upgrade head` *and* `alembic downgrade base` against
real Postgres):

1. **The type names are snake_case.** `enum_col` names types via `_snake`, so
   they are `supervision_preference` and `system_counter_type` — not
   `supervisionpreference`/`systemcountertype`. The rename target is
   `preference_weight`. Confirm against migration 001's `_enum` helper and 004's
   `reception_role` precedent before writing a line.

2. **The migration must not INSERT rows using the new enum value.** Postgres
   forbids using an enum value in the same transaction that added it, and
   `alembic/env.py` wraps the whole upgrade in a single
   `context.begin_transaction()` — so splitting the DML into a 016 would not
   help either. The migration therefore does DDL only:
   - `ALTER TYPE supervision_preference RENAME TO preference_weight`
   - `ALTER TYPE system_counter_type ADD VALUE IF NOT EXISTS 'wfh'`
   - `ADD COLUMN doctors.wfh_preference` (NOT NULL, server_default `'normal'`)

   The WFH counter rows are backfilled by
   `seed/backfill_system_counters.py`, run as a deploy step after the
   migration. That script already exists, is idempotent, and is documented as
   the repair for exactly this "missing SystemCounter rows" case — reusing it
   is cheaper and safer than a transaction-splitting hack in the migration.
   Task 1 is not complete until that script covers `WFH` (see the seeding
   bullet above) and the deploy step is recorded.

   Guard the whole body with the `if op.get_bind().dialect.name != "postgresql"`
   early-return that 004 uses for the enum work; SQLite renders VARCHAR + CHECK
   from the Python enum and needs only the column add.

3. **Downgrade.** `ADD VALUE` has no inverse, so removing `wfh` needs 004's
   rename/recreate/swap dance against `system_counters.counter_type`; it will
   fail if any row still uses `wfh`, which is the accepted behaviour for
   narrowing an enum. Rename `preference_weight` back and drop the column.

Run `backend/tests/test_models.py`, `backend/tests/test_api/test_doctors.py`
and `backend/tests/test_api/test_counter_reset.py`.

## Task 2: Engine — shared multipliers and the generation tally

**A.** Task 1 is complete: the enum, column, counter row and fixtures exist.
This task makes generation write the counter and puts the multiplier table
somewhere both preferences can read it.

**B. Files and deliverables**
- `backend/app/engine/preference.py` (new) — `PREFERENCE_MULTIPLIERS` keyed by `PreferenceWeight`, carrying the existing comment about why `NONE` is a large finite number rather than `math.inf`.
- `backend/app/engine/phases/_log_phase9c.py` — import `PREFERENCE_MULTIPLIERS` from there and re-export; delete the local table. `supervision_score` unchanged. **Also fix the module docstring**, which refers to the table as `_PREFERENCE_MULTIPLIERS` (stale leading underscore) and says it "lives here" — it now says where the table lives and why the re-export exists.
- `backend/app/engine/generate.py` — after the pipeline, before `_write_counters`, tally the grid into `counters.system[(doctor_id, WFH)]` (D4).
- `backend/tests/test_engine/test_generate.py` — a generation with template WFH rows increments the WFH counter by the right amount; a WFH slot abandoned by Phase 4 duty is not counted; a WFH slot that is also on leave is not counted (D9).
- `backend/tests/test_engine/test_phase9c.py` — unchanged behaviour after the multiplier move.

**C.** The tally:

```
for slot in grid.slots.values():
    if slot.is_on_leave:      # D9 -- leave dominates, as in phases 5/9C/12
        continue
    if slot.is_wfh:
        counters.increment_system(slot.doctor_id, SystemCounterType.WFH)
```

No `doctor_type` filter (D8). Use `CounterState.increment_system` so the
snapshot path is untouched — `_snapshot_counters` already runs before
`_write_counters` and captures pre-generation values, so scrap/rollback covers
the new counter with no change.

Do not add a `multiplier` argument anywhere yet: nothing selects on WFH until
the allocation phase exists. `weighted_system_score`'s docstring says
`multiplier` "is currently only passed by Phase 9C" — that stays true.

## Task 3: API — manual-edit counter adjustments

**A.** Tasks 1–2 are complete: the counter exists and generation writes it. This
task keeps it honest across draft edits (D2, D3, D9).

**B. Files and deliverables**
- `backend/app/api/routers/rota.py` —
  - a `_adjust_system_counter(db, doctor_id, counter_type, delta)` helper alongside the existing `_adjust_clinic_counter`;
  - `patch_session`: ±1 on a real `is_wfh` transition only, skipped when the session is on leave (D9), and amend the docstring's "written at generation time only" claim to name WFH as the exception;
  - `set_room`: −1 when assigning a room clears `is_wfh` (again skipped on leave), and correct the "No counter effect, matching swap-rooms" docstring line.
- `backend/app/api/routers/counters.py` — the module docstring's "all other raw-count mutation happens through generation and swap-roles" sentence is now wrong; extend it to name the two WFH sites.
- `backend/tests/test_api/` — toggle on/off round-trips to the original count; a redundant PATCH (`is_wfh: true` on an already-true slot) does not double-count; a notes-only PATCH does not move the counter; `set-room` on a WFH slot decrements; a WFH toggle on a leave slot does not count (D9); scrapping a draft restores the pre-generation value including manual toggles.

**C.** Three things to get right.

*Guard on the transition, not on the field's presence.* The frontend undo stack
replays PATCHes with the entry's **previous** `is_wfh`/`notes`/`is_supervising`
together (`lib/replayUndo.ts`), so undoing a notes-only edit re-sends the
unchanged `is_wfh`. Keying off `"is_wfh" in fields` would skew the count on
every such undo. Compare against the current value and act only on a real flip.

*Leave (D9).* Both endpoints already load `config` and call `_session_outs`;
derive leave via the existing `_leave_lookup(db, config)` rather than adding a
query. Order the work so the leave test reads the same session date the output
does. Do not clear a counter that was never incremented: a slot that was on
leave when WFH was set was not counted, so turning WFH off must not decrement
it either — which the "skip when on leave" guard gives for free, as long as
the leave state has not changed in between. That residual case is the accepted
drift in D9, not a bug to defend against.

*Clamping.* `_adjust_clinic_counter` floors `raw_count` at 0. The new system
helper deliberately does **not**: a negative raw count signals a bug in the
transition guard and should be visible rather than hidden by a `max(0, ...)`.
Because that diverges from its neighbour, say so in the helper's docstring —
otherwise the next reader will "fix" the inconsistency.

The system helper also needs no get-or-create: unlike clinic rows, a
SystemCounter row exists for every doctor by invariant (Task 1). Use
`.scalar_one()` and let a violation surface, matching `_write_counters`.

## Task 4: Frontend

**A.** Tasks 1–3 are complete and the backend serves `wfh_preference` and a
`wfh` system counter. This task exposes both.

**B. Files and deliverables**
- `frontend/src/api/types.ts` — rename `SupervisionPreference` → `PreferenceWeight` (keep a type alias if the churn is awkward); add `"wfh"` to `SystemCounterKind`; add `wfh_preference` to the doctor types (lines ~364, 372, 393, 418, 885, 893).
- `frontend/src/lib/doctorSchema.ts` — `wfhPreference` field, default `"normal"`, in both directions of the mapping; rename `supervisionPreferenceEnum` to a shared `preferenceWeightEnum`.
- `frontend/src/components/DoctorFormDialog.tsx` — lift `SUPERVISION_PREFERENCES` to a shared `PREFERENCE_OPTIONS` and add a WFH dropdown. The identical array is duplicated in `DoctorsPage.tsx`; both should read the shared one.
- `frontend/src/routes/DoctorsPage.tsx` — a "WFH" column beside "Supervision", same Partner/Salaried gate as `showSupervision` (D8), same optimistic PATCH handler; short help text for D7.
- `frontend/src/routes/CountersPage.tsx` — `wfh` rows arrive automatically since `counter_type` is rendered raw; add a label map (`room_move` → "Room moves", `supervision` → "Supervision", `wfh` → "WFH") while here.
- Matching updates in `DoctorsPage.test.tsx`, `DoctorFormDialog.test.tsx`, `CountersPage.test.tsx`, `api/doctors.test.tsx`, `lib/weightedScore.test.tsx`, `test/fixtures/reference.ts`.

**C.** `weightedScore.ts` needs no change — it is counter-type agnostic. Check
`RotaDetailPage`'s counter panel if it filters system counter types anywhere.

Per D1's consequence, the Counters page copy must not imply the engine balances
WFH yet; it records history only until the allocation phase ships.

## Task 5: Review and documentation

**A.** Tasks 1–4 are complete and the WFH counter and preference are live. This
step is for review and documentation.

**B. Deliverables**
- `documentation/architecture-clinical.md` — the counter section gains the third
  system counter; record D1 (what it counts), D2/D3 (the divergence from
  supervision's generation-only rule and why), D4 (tally not increment), D7
  (preference does not veto the template), D8 (counted for all, displayed for
  Partner/Salaried) and D9 (leave excluded, and the derived-leave drift).
- `documentation/architecture.md` — `PreferenceWeight` as the shared weighting type.
- `documentation/phase_pipeline.md` — a short "not yet implemented" note that the
  WFH counter is the ledger a future WFH allocation phase will select against,
  with the placement constraints from the Scope section above.
- `documentation/planned_updates.md` — add the WFH allocation phase as a
  follow-up plan, plus the two pre-existing gaps this plan surfaced but did not
  fix: `swap-rooms` can leave a session both WFH and roomed (D3), and undoing a
  `set-room` restores the room but not the `is_wfh` it cleared.
- Delete `documentation/wfh_counter_plan.md`.
