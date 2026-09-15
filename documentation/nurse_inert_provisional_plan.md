# Provisional Plan — Make `Nurse` inert to the generation engine

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

**In scope:** the four engine call sites that currently treat a nurse as demand or as
movable, plus the clinic-eligibility write path and picker that let a nurse be
configured into a clinic at all.

**Out of scope, deliberately:**

- **Master rota / staging write surface.** A nurse's room is set by choosing
  "Pre-assigned room" on the cell, which already exists and already works; Phase 2's
  `_PRE_OCCUPYING_TYPES` already claims it and already releases it when the nurse is
  on leave. No new session type, no doctor-type branch in the pair validator.
- **A nurse cell left as `requires_room`.** Once nurses leave `_D_ROOM_TYPES`, no pass
  rooms such a slot, and Phase 12's existing `unresolved_room` check names the nurse,
  day and period on the draft. That is the whole warning path, and it costs nothing:
  decided over a Phase 0 warning or an API-level block because the admin is going to
  fix it on the draft anyway, and a second warning in a second place is noise.
- **Duty.** `DutyGrid` already offers Partner/Salaried only. A nurse duty row written
  directly against the API would apply a role, but nothing in the product can produce
  one; not worth a Phase 0 check.
- **Seed counter rows, leave, entitlement, WFH, supervision, leave planning, the
  grids' display grouping.** All already correct for an inert nurse.

## Design Decisions

**D1. One named predicate, not five type comparisons.** `is_inert(context, doctor_id)`
and `INERT_TYPES = (DoctorType.NURSE,)` go in `phases/_shared.py`, next to the other
cross-phase helpers, and every site consults it. The property "the engine never writes
to this doctor's slot" is now a real concept with a real name, so a sixth staff type
that shares it is a one-tuple edit rather than a hunt.

**D2. `Nurse` stays in `phase4._PROTECTED_TYPES` rather than being replaced by the
inert check there.** The two predicates coincide at that call site today but mean
different things — `_PROTECTED_TYPES` is "seniority/role protection in the preferred-
room step", inert is "the engine never touches this doctor". Collapsing them would tie
AHP's protection to nurse's inertness. The comment on that constant currently says the
pair is kept together "so it cannot drift apart by omission"; that claim stops being
true with this ticket and must be rewritten, not left.

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
`ClinicCounter`/`SystemCounter` rows are all still valid; the counters simply stay at
zero, as `seed_system_counters.py` already says they do.

---

## Task 1: Engine — the inert predicate and its four call sites

**A. State of the world.** Nothing has been done. `Nurse` is currently rule-identical
to `AHP` in the engine. This task makes it inert and is the whole behavioural change;
Task 2 closes the clinic-configuration surface that would otherwise let a nurse back
into Phase 5.

**B. Files and deliverables.**

| File | Deliverable |
|---|---|
| `backend/app/engine/phases/_shared.py` | New `INERT_TYPES = (DoctorType.NURSE,)` and `is_inert(context, doctor_id) -> bool`, with a docstring stating the three properties above and that inert doctors stay in the grid so their rooms stay occupied. |
| `backend/app/engine/phases/phase7_9a.py` | Remove `DoctorType.NURSE` from `_D_ROOM_TYPES`; update the constant's comment and the module docstring's "Trainee/AHP" gloss. No other change — nurses are not in `_DISPLACEABLE_TYPES`, so Passes 1, 2 and 3 already ignore them as victims and as Pass 3 subjects. |
| `backend/app/engine/phases/phase4.py` | In `_consolidate_duty_rooms`, after the existing duty-occupant guard, skip when the occupant is inert (narrate, `continue`). Rewrite the `_PROTECTED_TYPES` comment per D2. Leave `_protection` itself alone. |
| `backend/app/engine/phases/_log_phase4.py` | New `ConsolidationNarrator.blocked_by_inert_occupant(occupant_id, occupant_code)`, shaped like `blocked_by_duty_occupant`: action `consolidate_room_skipped`, rationale ending in a `rat.decided(...)` saying the nurse's room is fixed by the master rota and the engine never moves one, so consolidation is abandoned and both stay put. Check line ~247's prose (`"protected (not Partner/AHP/Nurse ...)"`) still reads true — it describes `_protection`, which is unchanged. |
| `backend/app/engine/phases/phase5.py` | In `_eligible_doctors`, exclude inert doctors, appending `(code, "nurses are never assigned clinics")` to `excluded`. Place it immediately after the `doctor is None or not doctor.active` check — it is a property of the doctor, not of the slot, so it belongs with the other doctor-level filter and before the slot lookups. |
| `backend/app/engine/phases/_log_phase5.py` | In `displaceability()`, return `(False, "protected: Nurse — the engine never moves a nurse")` for an inert occupant, immediately after the `slot is None` check. |

**C. Instructions.**

- Do not filter nurses out of `context.doctors` or out of Phase 2. Property 3 depends
  on their slots existing and holding their rooms.
- Tests to change: `tests/test_engine/test_phase7_9a.py::…` (the nurse test at ~line
  507 currently asserts a nurse *joins* the Pass 2 D-room candidate pool — invert it:
  a nurse with a `requires_room` slot is never a Pass 2 subject and is left roomless).
  `tests/test_engine/test_phase4.py`'s protected-type parametrize at ~line 319 keeps
  passing unchanged and should stay.
- Tests to add: (a) Phase 4 consolidation does not bump a nurse out of the duty
  doctor's room, and the duty doctor is left unconsolidated; (b) Phase 5 never selects
  a nurse for a clinic even when one is in `doctor_eligibilities`, and the exclusion
  reason appears in the log; (c) Phase 5 does not displace a nurse to free an eligible
  clinic room; (d) a whole-pipeline test that a nurse's `PRE_ASSIGNED` room is
  byte-identical before and after a full run in a week that also has duty, clinics and
  trainee D-room demand — this is the test that actually pins the ticket.
- Run `uv run pytest tests/test_engine/` only.

## Task 2: Clinic eligibility — close the configuration surface

**A. State of the world.** Task 1 is complete: Phase 5 now skips nurses as candidates.
This task stops a nurse being configured into a clinic in the first place, so the skip
is a backstop rather than a silent disagreement with stored data (D3).

**B. Files and deliverables.**

| File | Deliverable |
|---|---|
| `backend/app/api/routers/clinic_types.py` | New `_reject_nurse_doctors(db, payload)` modelled line-for-line on `_reject_sr_rooms` (same 400, same singular/plural detail phrasing, same "needs the DB to resolve id -> type" docstring note). Call it beside `_reject_sr_rooms` in both `create_clinic_type` and `update_clinic_type`. |
| `backend/app/api/audit_descriptions.py` | Nothing new — no new route. Confirm only. |
| `frontend/src/components/ClinicTypeFormDialog.tsx` | Filter nurses out of the list the picker groups from, so the "Nurses" optgroup and its "All nurses" option vanish. Update the existing comment at ~line 63 ("Trainees, AHPs and nurses are excluded and must be added individually") — it stops being true for nurses. An *already-stored* nurse row still renders in the added-list with its Remove button; do not hide it, or a clinic type carrying one could never be saved again. |
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
  predicate as their single definition, D2 (why `Nurse` stays in `_PROTECTED_TYPES`
  anyway), and the fact that an unroomed nurse surfaces only as Phase 12's existing
  `unresolved_room` warning.
- `documentation/phase_pipeline.md` — the Phase 7–9A "Trainee/AHP shorthand" paragraph
  at ~line 148 names Nurse in the D-room demand set; remove it. Add the consolidation
  skip to the Phase 4 second-pass bullet list and the candidate exclusion to Phase 5.
- `backend/app/models/enums.py` — the `DoctorType` docstring makes the same
  rule-identical claim; rewrite.
- Delete `documentation/nurse_inert_provisional_plan.md` and the implementation plan
  it becomes.
