# WFH Counter & Preference — Provisional Plan

**Status:** Provisional (workflow step 1). Needs review/expansion into an implementation plan before task breakdown.

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
- Migration (015) + backfill script for the new counter rows.

### Out of scope (separate plan — see below)

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

**D1. The counter counts every WFH session, template WFH included.**
Not only engine-allocated WFH. The future phase must account for template WFH
anyway — otherwise a doctor with two fixed WFH template slots gets allocated
more on top of colleagues with none. One ledger, one meaning: "sessions this
doctor spent at home."

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

**D3. Three write sites change `is_wfh` outside generation; all three must adjust.**
- `PATCH /rota/{id}/sessions/{sid}` — `is_wfh` true/false, ±1.
- `POST /rota/{id}/sessions/{sid}/set-room` with a `room_id` — clears `is_wfh`
  as a side effect, −1. Its docstring currently says "No counter effect,
  matching swap-rooms"; that stops being true.
- Phase 4's `wfh_abandoned` — in-engine, so it is covered for free if the
  generation tally (D4) counts the final grid rather than incrementing as it goes.

**D4. Generation tallies the final grid, not incremental increments.**
A single pass over `grid.slots` at the end of the pipeline, incrementing WFH
once per slot with `is_wfh` true. This is why D3's Phase 4 case needs no special
handling: a slot whose WFH was abandoned simply is not counted. It also means
the tally is correct no matter what a future allocation phase does or undoes.
Placement: a small step in `generate.py` before `_write_counters`, or a trivial
`phase_wfh_tally`. Prefer the former until the allocation phase gives the latter
a reason to exist.

**D5. `PreferenceWeight` replaces `SupervisionPreference`.**
Same four members and same wire values (`none`/`less`/`normal`/`more`), so the
frontend `z.enum` and API contract are unchanged in value — only the type name
moves. 12 files reference the old name; the rename is mechanical. The system is
not live, so migration 015 can rename the Postgres enum type outright.

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

**D8. Partner/Salaried only, matching supervision.**
`SUPERVISION_TYPES` on the Doctors page and `_COUNTED_TYPES` in the counters
router both already filter to Partner/Salaried; the WFH preference and counter
follow the same rule. Trainee/AHP doctors still get a seeded WFH counter row at
zero, preserving the existing unconditional "one row per doctor per counter
type" invariant that `generate._write_counters`' `.scalar_one()` depends on.

---

## Task 1: Data model changes

**A.** Nothing has been implemented yet. This task lands the enum, the column,
the counter type and the migration, with no behaviour change.

**B. Files and deliverables**
- `backend/app/models/enums.py` — rename `SupervisionPreference` → `PreferenceWeight`; add `WFH = "wfh"` to `SystemCounterType`.
- `backend/app/models/doctor.py` — `wfh_preference` column, `PreferenceWeight`, NOT NULL, default/server_default `normal`.
- `backend/app/models/__init__.py` — export rename.
- `backend/app/api/schemas/doctor.py` — `wfh_preference` on `DoctorIn`/`DoctorPatch`/`DoctorOut`/`DoctorDetailOut`; type rename.
- `backend/app/api/routers/doctors.py` — add `SystemCounterType.WFH` to the create-time seeding loop; update the counter-invariant docstring.
- `backend/app/engine/phases/_log_phase9c.py` — import rename only (multiplier move is Task 2).
- `backend/alembic/versions/015_wfh_counter_and_preference.py` — rename the `supervisionpreference` enum type to `preferenceweight`; add the `wfh` value to `systemcountertype`; add `doctors.wfh_preference`; insert a `wfh` SystemCounter row for every existing doctor.
- `backend/seed/seed_system_counters.py`, `backend/seed/backfill_system_counters.py` — include `WFH`.
- `backend/tests/test_engine/factories.py`, `backend/tests/test_models.py`, `backend/tests/test_api/test_doctors.py` — follow the rename; assert three counter rows per doctor.

**C.** Straight mechanical change. The one thing to get right is the Postgres
enum work in 015: adding a value to `systemcountertype` and renaming
`supervisionpreference` are both DDL that must be ordered before any DML that
uses them. Confirm `enum_col`'s `_snake` naming produces `preferenceweight` and
match the migration to it. Run `backend/tests/test_models.py` and
`backend/tests/test_api/test_doctors.py`.

## Task 2: Engine — shared multipliers and the generation tally

**A.** Task 1 is complete: the enum, column and counter row exist. This task
makes generation write the counter and puts the multiplier table somewhere both
preferences can read it.

**B. Files and deliverables**
- `backend/app/engine/preference.py` (new) — `PREFERENCE_MULTIPLIERS` keyed by `PreferenceWeight`.
- `backend/app/engine/phases/_log_phase9c.py` — import `PREFERENCE_MULTIPLIERS` from there and re-export; delete the local table. `supervision_score` unchanged.
- `backend/app/engine/generate.py` — after the pipeline, before `_write_counters`, tally `is_wfh` slots into `counters.system[(doctor_id, WFH)]` (D4).
- `backend/tests/test_engine/test_generate.py` — a generation with template WFH rows increments the WFH counter by the right amount; a WFH slot abandoned by Phase 4 duty is not counted.
- `backend/tests/test_engine/test_phase9c.py` — unchanged behaviour after the multiplier move.

**C.** The tally must use `CounterState.increment_system` so the snapshot path
is untouched — `_snapshot_counters` already runs before `_write_counters` and
captures pre-generation values, so scrap/rollback covers the new counter with no
change. Do not add a `multiplier` argument anywhere yet: nothing selects on WFH
until the allocation phase exists.

## Task 3: API — manual-edit counter adjustments

**A.** Tasks 1–2 are complete: the counter exists and generation writes it. This
task keeps it honest across draft edits (D2, D3).

**B. Files and deliverables**
- `backend/app/api/routers/rota.py` —
  - a `_adjust_system_counter(db, doctor_id, counter_type, delta)` helper alongside the existing `_adjust_clinic_counter`;
  - `patch_session`: ±1 on a real `is_wfh` transition only (no-op when the value is unchanged), and amend the docstring's "written at generation time only" claim to name WFH as the exception;
  - `set_room`: −1 when assigning a room clears `is_wfh`, and correct the "No counter effect, matching swap-rooms" docstring line.
- `backend/app/api/routers/counters.py` — the module docstring's "all other raw-count mutation happens through generation and swap-roles" sentence is now wrong; extend it.
- `backend/tests/test_api/` — toggle on/off round-trips to the original count; a redundant PATCH (`is_wfh: true` on an already-true slot) does not double-count; `set-room` on a WFH slot decrements; scrapping a draft restores the pre-generation value including manual toggles.

**C.** Guard every adjustment on an actual transition, not on the field being
present in the patch — the frontend undo stack replays PATCHes and will
otherwise skew the count. Clamping at zero is not wanted: a negative raw count
signals a bug and should be visible rather than hidden.

## Task 4: Frontend

**A.** Tasks 1–3 are complete and the backend serves `wfh_preference` and a
`wfh` system counter. This task exposes both.

**B. Files and deliverables**
- `frontend/src/api/types.ts` — rename `SupervisionPreference` → `PreferenceWeight` (keep a type alias if the churn is awkward); add `"wfh"` to `SystemCounterKind`; add `wfh_preference` to the doctor types.
- `frontend/src/lib/doctorSchema.ts` — `wfhPreference` field, default `"normal"`, in both directions of the mapping.
- `frontend/src/components/DoctorFormDialog.tsx` — lift `SUPERVISION_PREFERENCES` to a shared `PREFERENCE_OPTIONS` and add a WFH dropdown.
- `frontend/src/routes/DoctorsPage.tsx` — a "WFH" column beside "Supervision", same Partner/Salaried gate (D8), same optimistic PATCH handler; short help text for D7.
- `frontend/src/routes/CountersPage.tsx` — `wfh` rows arrive automatically since `counter_type` is rendered raw; add a label map (`room_move` → "Room moves", `supervision` → "Supervision", `wfh` → "WFH") while here.
- Matching updates in `DoctorsPage.test.tsx`, `DoctorFormDialog.test.tsx`, `CountersPage.test.tsx`, `api/doctors.test.tsx`, `test/fixtures/reference.ts`.

**C.** `weightedScore.ts` needs no change — it is counter-type agnostic. Check
`RotaDetailPage`'s counter panel if it filters system counter types anywhere.

## Task 5: Review and documentation

**A.** Tasks 1–4 are complete and the WFH counter and preference are live. This
step is for review and documentation.

**B. Deliverables**
- `documentation/architecture-clinical.md` — the counter section gains the third
  system counter; record D1 (what it counts), D2/D3 (the divergence from
  supervision's generation-only rule and why), D4 (tally not increment), D7
  (preference does not veto the template).
- `documentation/architecture.md` — `PreferenceWeight` as the shared weighting type.
- `documentation/phase_pipeline.md` — a short "not yet implemented" note that the
  WFH counter is the ledger a future WFH allocation phase will select against,
  with the placement constraints from the Scope section above.
- `documentation/planned_updates.md` — add the WFH allocation phase as a
  follow-up plan.
- Delete `documentation/wfh_counter_plan.md`.
