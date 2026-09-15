# Implementation Plan — Make `Nurse` inert to the generation engine

## Plan

`Nurse` was added (commit `ca44223`) as a rule-identical clone of `AHP`. It should
instead be **inert**: a nurse's room is decided by a human on the master rota (or in
staging), Phase 2 copies it into the grid, and no phase ever reads a nurse as demand
or writes to a nurse's slot again. AHP behaviour is unchanged.

"Inert" is defined precisely as three properties:

1. **No demand.** A nurse never causes the engine to allocate anything — no D-room
   demand in Phases 7–9A, no clinic candidacy in Phase 5. (Duty, supervision and WFH
   already exclude nurses without a change.)
2. **Immovable.** No phase may move a nurse out of the room Phase 2 gave them, ever —
   including when the alternative is another doctor going roomless. Absolute, with no
   last-resort exception, so the rule is one sentence and one predicate.
3. **Opaque.** A nurse's room is a normal occupied room to everybody else. This needs
   no code: `grid.assign_room` in Phase 2 already makes `is_room_free` false for it,
   so every free-room search in every phase routes around it for free.

Property 3 is why nurses stay in `context.doctors` and in the grid rather than being
filtered out of the engine: filtering them would release their rooms to other doctors,
which is the opposite of what is wanted.

## Scope

**In scope:** the five engine call sites that currently treat a nurse as demand or as
movable, plus the clinic-eligibility write path and picker that let a nurse be
configured into a clinic at all.

The five sites were established by tracing every path that mutates a doctor's room.
`grid.assign_room` / `grid.free_room` are called from Phases 2, 4, 5, 7–9A, 9B and 9C,
and each call's subject is chosen by one of these gates:

| Gate | Where | Excludes a nurse today? |
|---|---|---|
| `phase2._PRE_OCCUPYING_TYPES` | Phase 2 | n/a — this is the write we are preserving |
| `phase4._protection` | Phase 4 preferred-room eviction | yes, via `_PROTECTED_TYPES` — **but see D2** |
| Salaried-only sweep (`phase4.py:267`) | Phase 4 fallback sweep | yes |
| *(none)* | Phase 4 `_consolidate_duty_rooms` bump | **no — site 1** |
| `_log_phase5.displaceability` | Phase 5 room resolution | **no — site 2** |
| `phase7_9a._D_ROOM_TYPES` | Passes 1 and 2 subjects | **no — site 3** |
| `phase7_9a._DISPLACEABLE_TYPES` | Passes 1/2 victims, Pass 3 subjects | yes |
| `phase9b._SWAPPABLE_TYPES` | Phase 9B WFH swap | yes |
| `phase9c._SUPERVISOR_TYPES` | Phase 9C supervisor seating | yes |
| `is_room_free` | `phase9c._book_sr_room` | yes — property 3 |

Site 4 is Phase 5's `_eligible_doctors` (clinic candidacy — demand, not a room write),
and site 5 is `phase4._protection`, which is currently safe by accident and is made
safe on purpose (D2).

**Out of scope, deliberately:**

- **Master rota / staging write surface.** A nurse's room is set by choosing
  "Pre-assigned room" on the cell, which already exists and already works;
  `MasterCellEditPopover.tsx` and `masterRotaConflicts.ts` contain no doctor-type
  branching at all, and Phase 2's `_PRE_OCCUPYING_TYPES` already claims the room and
  already releases it when the nurse is on leave. Staging goes through the same path —
  `context._load_staging_or_template` substitutes staged sessions for template ones and
  nothing downstream knows the difference. No new session type, no doctor-type branch
  in the pair validator.
- **A nurse cell left as `requires_room`.** Once nurses leave `_D_ROOM_TYPES`, no pass
  rooms such a slot (Pass 3 gates on `_DISPLACEABLE_TYPES`, so it does not pick the
  nurse up), and Phase 12's existing `unresolved_room` check names the nurse, day and
  period on the draft. That is the whole warning path, and it costs nothing: decided
  over a Phase 0 warning or an API-level block because the admin is going to fix it on
  the draft anyway, and a second warning in a second place is noise.
- **Duty.** `DutyGrid` already offers Partner/Salaried only. A nurse duty row written
  directly against the API would apply a role, but nothing in the product can produce
  one; not worth a Phase 0 check.
- **A nurse pinned to the only SR room.** `phase9c._book_sr_room` then finds no free SR
  room and the supervisor is left roomless for Pass 3, exactly as for any other
  `PRE_ASSIGNED` SR row. `phase0.py:250` already warns on every such row regardless of
  doctor type, so this is covered; it is the one place inertness has a visible cost on
  somebody else, and Task 3 records it in the docs rather than adding code.
- **Extra sessions and blocked slots.** Leave-planning constructs only; the engine
  never reads them.
- **Seed counter rows, leave, entitlement, WFH, supervision, leave planning, the
  grids' display grouping.** All already correct for an inert nurse.

## Design Decisions

**D1. One named predicate, plus a test that pins the type tuples to it.**
`is_inert(context, doctor_id)` and `INERT_TYPES = (DoctorType.NURSE,)` go in
`phases/_shared.py`, next to the other cross-phase helpers, and the three sites that
branch per-doctor consult it.

The provisional plan claimed this alone makes a sixth inert staff type a one-tuple
edit. It does not, and the gap is worth naming rather than inheriting. Two of the
guarantees — no D-room demand, and no eviction by Phase 4's fallback sweep or Phase
7–9A's victim search — are enforced by a type being *absent from* a tuple
(`_D_ROOM_TYPES`, `_DISPLACEABLE_TYPES`, `_SWAPPABLE_TYPES`, `_SUPERVISOR_TYPES`).
Absence is not something `is_inert` can express, and adding `DoctorType.X` to
`INERT_TYPES` would give X neither guarantee while looking like it had.

So the predicate is paired with a test in `tests/test_engine/test_inert.py` asserting
`set(INERT_TYPES)` is disjoint from each of those four tuples. That is what actually
makes the sixth type a one-tuple edit: it fails loudly at the moment someone adds a
member without removing it from the demand sets, which is the only failure mode that
matters.

**D2. `is_inert` is checked explicitly in `phase4._protection`, and `Nurse` stays in
`_PROTECTED_TYPES` alongside it.** The provisional plan left `_protection` alone,
reasoning that `_PROTECTED_TYPES` and inert "coincide today but mean different
things". The observation is right; the conclusion does not follow. After this ticket
Nurse's membership of `_PROTECTED_TYPES` is the *only* thing preventing Phase 4's
preferred-room step from evicting a nurse — inertness would silently depend on a
constant whose stated purpose is seniority protection, which a future ticket could
legitimately revisit without knowing it had broken property 2.

`_protection` therefore returns `(True, "protected: the engine never moves a nurse")`
for an inert occupant, checked first, and `_PROTECTED_TYPES` keeps Nurse as the
seniority rule it already is. Two checks that happen to agree, each self-contained —
which is the outcome the provisional plan wanted and the mechanism it was missing.
The comment on `_PROTECTED_TYPES` currently claims keeping the pair in one tuple "is
what stops the pair drifting apart by omission"; that claim stops being true with this
ticket and must be rewritten, not left.

**D3. Nurses are excluded from clinics at both ends.** Phase 5 skips them as candidates
(with a decision-log exclusion reason, like every other filter there), *and* the clinic
type write path rejects a nurse `doctor_id` with a 400, mirroring `_reject_sr_rooms`.
The engine skip alone would leave a configured-but-dead eligibility row silently doing
nothing, which is the failure mode the decision log exists to prevent; the API
rejection alone would leave pre-existing rows live. Both, and the picker filter, make
the state unreachable and unrepresentable.

**D4. Phase 5's `displaceability()` gains the inert check, not `_resolve_room`.** That
function already returns `(displaceable, reason)` and the reason is what the log
prints, so the protection and its explanation arrive together. Same reasoning for
putting Phase 4's consolidation skip behind a new narrator method rather than a bare
`continue`.

**D5. No migration, no data change.** `Nurse` rows, their template cells and their
`ClinicCounter`/`SystemCounter` rows are all still valid. Their `ROOM_MOVE`,
`SUPERVISION` and clinic counters stay at zero, as `seed_system_counters.py` already
describes.

The provisional plan said "the counters simply stay at zero" without qualification.
That is wrong for WFH: `generate._write_counters` (`generate.py:127`) tallies every
slot with `is_wfh` and carries no doctor-type filter — its docstring says so
explicitly, and `seed_system_counters.py` names WFH as the deliberate exception to
the other two. A nurse with a WFH row in the master template therefore increments a
WFH counter, before and after this ticket. That is correct and is not a violation of
inertness: the counter records what the template already said, and no phase wrote to
the nurse's slot to produce it.

---

## Task 1: Engine — the inert predicate and its call sites

**A. State of the world.** Nothing has been done. `Nurse` is currently rule-identical
to `AHP` in the engine. This task makes it inert and is the whole behavioural change;
Task 2 closes the clinic-configuration surface that would otherwise let a nurse back
into Phase 5.

**B. Files and deliverables.**

| File | Deliverable |
|---|---|
| `backend/app/engine/phases/_shared.py` | New `INERT_TYPES = (DoctorType.NURSE,)` and `is_inert(context, doctor_id) -> bool`, with a docstring stating the three properties above, that inert doctors stay in the grid so their rooms stay occupied, and that the predicate cannot express the "absent from the demand tuples" half of the rule — `test_inert.py` is what pins that. Import `DoctorType` from `...models.enums` (the module already imports `Day`, `Period`, `SystemCounterType` from there). |
| `backend/app/engine/phases/phase7_9a.py` | Remove `DoctorType.NURSE` from `_D_ROOM_TYPES`; update the constant's comment (drop "Nurse carries the same D-room demand as AHP") and the module docstring's "Trainee/AHP" gloss. No other change — nurses are not in `_DISPLACEABLE_TYPES`, so Passes 1, 2 and 3 already ignore them as victims and as Pass 3 subjects. |
| `backend/app/engine/phases/phase4.py` | Two changes. (i) In `_protection`, return `(True, "protected: the engine never moves a nurse")` for an inert occupant, checked *before* the `_PROTECTED_TYPES` test, per D2; rewrite the `_PROTECTED_TYPES` comment and `_protection`'s docstring accordingly. (ii) In `_consolidate_duty_rooms`, skip when the occupant is inert (narrate, `continue`), placed *before* the existing duty-occupant guard — a nurse cannot hold a duty role today, so the order is behaviourally moot, but inert is the absolute rule and should read as the first thing checked. |
| `backend/app/engine/phases/_log_phase4.py` | New `ConsolidationNarrator.blocked_by_inert_occupant(occupant_id, occupant_code)`, shaped like `blocked_by_duty_occupant` (`:396`): action `consolidate_room_skipped`, `related_doctor_id=occupant_id`, `room_id=self._duty_room.id`, rationale via `rat.stages(self._problem_line, …, rat.decided(...))` ending in a `rat.decided` saying the nurse's room is fixed by the master rota and the engine never moves one, so consolidation is abandoned and both stay put. Check line ~247's prose (`"protected (not Partner/AHP/Nurse and holds no role this session)"`) — it describes `_protection`, which D2 now adds a branch to, so it needs the nurse clause reworded rather than left. |
| `backend/app/engine/phases/phase5.py` | In `_eligible_doctors`, exclude inert doctors, appending `(code, "nurses are never assigned clinics")` to `excluded`. Place it immediately after the `doctor is None or not doctor.active` check — it is a property of the doctor, not of the slot, so it belongs with the other doctor-level filter and before the slot lookups. |
| `backend/app/engine/phases/_log_phase5.py` | In `displaceability()`, return `(False, "protected: Nurse — the engine never moves a nurse")` for an inert occupant, immediately after the `slot is None` check. |

**C. Instructions.**

- Do not filter nurses out of `context.doctors` or out of Phase 2. Property 3 depends
  on their slots existing and holding their rooms.
- Tests to change: `tests/test_engine/test_phase7_9a.py::test_nurse_single_session_displacement`
  (~line 506) currently asserts a nurse *joins* the Pass 2 D-room candidate pool —
  invert it: a nurse with a `requires_room` slot is never a Pass 2 subject, is left
  roomless, and the Partner occupant keeps the D room with `ROOM_MOVE` still at zero.
  Rename it to match. `tests/test_engine/test_phase4.py`'s protected-type parametrize
  at ~line 318 keeps passing unchanged and should stay.
- Tests to add:
  - `tests/test_engine/test_inert.py` (new): `set(INERT_TYPES)` is disjoint from
    `phase7_9a._D_ROOM_TYPES`, `phase7_9a._DISPLACEABLE_TYPES`,
    `phase9b._SWAPPABLE_TYPES` and `phase9c._SUPERVISOR_TYPES` (D1).
  - Phase 4: consolidation does not bump a nurse out of the duty doctor's room, the
    duty doctor is left unconsolidated, and the `consolidate_room_skipped` entry is
    logged.
  - Phase 4: the preferred-room step does not evict a nurse *and* the log reason names
    inertness rather than the doctor type (D2 — this is what distinguishes the new
    branch from the pre-existing `_PROTECTED_TYPES` one).
  - Phase 5: never selects a nurse for a clinic even when one is in
    `doctor_eligibilities`, and the exclusion reason appears in the log.
  - Phase 5: does not displace a nurse to free an eligible clinic room.
  - A whole-pipeline test that a nurse's `PRE_ASSIGNED` room is unchanged before and
    after a full run in a week that also has duty, clinics and trainee D-room demand —
    this is the test that actually pins the ticket.
- Run `uv run pytest tests/test_engine/` only.

## Task 2: Clinic eligibility — close the configuration surface

**A. State of the world.** Task 1 is complete: Phase 5 now skips nurses as candidates.
This task stops a nurse being configured into a clinic in the first place, so the skip
is a backstop rather than a silent disagreement with stored data (D3).

**B. Files and deliverables.**

| File | Deliverable |
|---|---|
| `backend/app/api/routers/clinic_types.py` | New `_reject_nurse_doctors(db, payload)` modelled line-for-line on `_reject_sr_rooms` (`:106`): same 400, same singular/plural `noun`/`verb` detail phrasing, same "needs the DB to resolve id -> type" docstring note. Query `Doctor.code` where `Doctor.id.in_(doctor_ids)` and `Doctor.doctor_type == DoctorType.NURSE`, ordered by code. Call it beside `_reject_sr_rooms` in both `create_clinic_type` (`:215`) and `update_clinic_type` (`:309`). Note the router currently imports the `app.models` aggregate — follow the file's existing convention rather than converting it here. |
| `backend/app/api/audit_descriptions.py` | Nothing new — no new route. Confirm only. |
| `frontend/src/components/ClinicTypeFormDialog.tsx` | Filter nurses out of `activeDoctors` (`:53`), whose only consumer is `notYetAddedDoctors`, so the "Nurses" optgroup and its "All nurses" option vanish. Update the comment at `:66` ("Trainees, AHPs and nurses are excluded and must be added individually") — it stops being true for nurses. An *already-stored* nurse row still renders in the added-list, which reads from `doctorsById` (`:51`, built from the unfiltered list) and so needs no change; do not hide it, or a clinic type carrying one could never be saved again. |
| `backend/tests/test_api/test_clinic_types.py` | A nurse in `doctor_eligibilities` 400s on both POST and PUT; a payload with no nurse is unaffected. |
| `frontend/src/components/ClinicTypeFormDialog.test.tsx` | The picker offers no nurse and no "All nurses"; a pre-existing nurse row still renders and can be removed. |

**C. Instructions.** Run `uv run pytest tests/test_api/test_clinic_types.py` and
`npm run test -- src/components/ClinicTypeFormDialog.test.tsx`.

## Task 3: Review and documentation

**A. State of the world.** Tasks 1–2 are complete and the feature is live. This step is
review and documentation only.

**B. Deliverables.**

- `documentation/architecture-clinical.md` — rewrite the `DoctorType` paragraph at
  ~line 113. It currently states `Nurse` is rule-identical to `AHP` and that the two
  are deliberately kept in shared constants so they cannot drift; that is now wrong in
  both halves. Replace with the three properties of inertness, the `is_inert`
  predicate and the `test_inert.py` disjointness test as their joint definition (D1),
  D2 (why `Nurse` is checked in `_protection` *and* stays in `_PROTECTED_TYPES`), the
  fact that an unroomed nurse surfaces only as Phase 12's existing `unresolved_room`
  warning, and the one cost inertness imposes on others: a nurse pinned to the only SR
  room leaves a supervisor roomless, already warned by `phase0.py:250`.
- `documentation/phase_pipeline.md` — the Phase 7–9A "Trainee/AHP shorthand" paragraph
  at ~line 148 names Nurse in the D-room demand set; remove it. Add the consolidation
  skip and the `_protection` branch to the Phase 4 bullet lists, and the candidate
  exclusion to Phase 5. While in this file, fix an unrelated pre-existing error found
  during review: the Pass 3 paragraphs describe the fallback order as `SR > D > C > W`
  in two places, but `phase7_9a._PASS3_FALLBACK_TYPE_ORDER` is `(D, C, W, SR)` and the
  module docstring agrees with the code. Correct the prose to match the constant.
- `backend/app/models/enums.py` — the `DoctorType` docstring makes the same
  rule-identical claim; rewrite.
- Delete `documentation/nurse_inert_provisional_plan.md` and
  `documentation/nurse_inert_implementation_plan.md`.
