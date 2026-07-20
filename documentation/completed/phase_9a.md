# Plan

Correct Pass 3 (Partner/Salaried room resolution, formerly GAS Phase 9A) in `backend/app/engine/phases/phase7_9a.py`. The current implementation walks the doctor's own preference list and stops — leaving the slot unresolved if nothing on the list is free. The original GAS behaviour, misread during porting, is to then **force the doctor into the first available room** using a fixed fallback priority: SR rooms, then D rooms, then C rooms, then W rooms. The no-fallback behaviour was recorded as a deliberate decision in the module docstring, phase-pipeline.md, and Architecture.md; all three records are wrong and must be corrected alongside the code.

The preference-expansion behaviour described in the original GAS spec ("C" expands to C1/C2/C3, "W" to W1/W2) is **already implemented** at context load time (`context.py` expands `room_type` preference rows into concrete rooms at that preference position). No change is needed there and no task in this plan touches the context loader.

# Scope

**In scope:**
- Pass 3 fallback logic in `backend/app/engine/phases/phase7_9a.py`, plus its module docstring.
- Engine tests in `backend/tests/test_engine/test_phase7_9a.py`.
- Documentation corrections: `docs/phase-pipeline.md` and `Architecture.md`.

**Out of scope:**
- Passes 1 and 2 (their displaced-doctor relocation logic, including its C/W/SR pool and D-room exclusion, is unchanged and remains deliberately different from Pass 3's fallback).
- Context loading / preference expansion (already correct).
- Phase 9B, Phase 9C, Phase 12 (no code changes; their behaviour is affected only indirectly by Pass 3 resolving more slots, which is the point).
- Data model, API, frontend.

# Design Decisions

1. **Fallback is room-type priority, not hardcoded room codes.** Rooms are DB-driven, so the fallback order is expressed as a type sequence — `SR`, `D`, `C`, `W` — with rooms within each type ordered by room code. The concrete list "SR → D1–D8 → C1–C3 → W1–W2" is the current seed data's realisation of that rule, not the rule itself. (Note: code ordering is alphabetical; with the current seed data D1–D8 this is correct. This matches the user-facing expectation better than id ordering.)
2. **D rooms are included in the Pass 3 fallback — intentionally.** This contrasts with the Pass 1/2 displaced-doctor relocation pool, which excludes D rooms. The contrast is correct: Pass 3 runs last, after all Trainee/AHP D-room demand has been resolved, so any D room still free is genuinely surplus. Document this explicitly so it does not read as an inconsistency.
3. **SR-first is intentional despite the Phase 9C side effect.** A Partner forced into SR via fallback becomes the SR occupant, and Phase 9C gives the SR occupant first priority as trainee supervisor. This is accepted behaviour (matches GAS).
4. **No displacement in Pass 3.** Unchanged: Pass 3 only ever takes a *free* room, from the preference list first and then the fallback sequence. It never bumps another doctor.
5. **Warning semantics.** The `no_partner_salaried_room` check name is retained, but it now only fires when the preference list *and* the full fallback sequence are exhausted — i.e. every room in the practice is occupied for that session. The message is updated to say so ("no free room anywhere; slot remains unresolved").
6. **Decision log distinguishes the two outcomes.** A preference-list hit logs as before ("first free room on preference list"); a fallback hit logs a distinct message ("forced into fallback room {code}; no preferred room free"), same `action="assign_room"`. This is what makes the generation log explain why a doctor landed in an unexpected room.
7. **The historical record is corrected, not erased.** phase-pipeline.md and Architecture.md are rewritten to describe the fallback as the correct ported behaviour. The old "deliberately no fallback" wording is removed, not annotated — the docs describe the system as it is.

# Task 1: Engine change — Pass 3 fallback

**A: State of the world.** No prior tasks; this is the first and only code task. `phase7_9a.py` currently implements Pass 3 in `_pass3_partner_salaried_fallback()`: for each Partner/Salaried doctor with an unresolved `REQUIRES_ROOM` slot, it walks `context.preferred_rooms_by_doctor[doctor.id]`, assigns the first free room, and emits a `no_partner_salaried_room` warning if none is free. The module docstring (top of file, and the paragraph beginning "Displacing a Partner/Salaried doctor in Pass 2...") states Pass 3 has no fallback.

**B: Relevant files and deliverables.**
- `backend/app/engine/phases/phase7_9a.py` — modify `_pass3_partner_salaried_fallback()`; update the module docstring (both the Pass 3 bullet and the "Pass 3 gets neither" paragraph).
- `backend/tests/test_engine/test_phase7_9a.py` — replace `test_no_fallback_beyond_own_preference_list` in `TestPass3PartnerSalariedFallback`; add new fallback tests.
- Deliverable: both files updated, full engine test suite green.

**C: Instructions.**

1. In `_pass3_partner_salaried_fallback()`, after the existing preference-list walk fails (`chosen is None`), do not warn yet. Instead run the fallback search:
   - Build the fallback room sequence from `context.rooms_by_type`, iterating types in the order `RoomType.SR`, `RoomType.D`, `RoomType.C`, `RoomType.W`; within each type sort rooms by `code`. Define the type order as a module-level constant, e.g. `_PASS3_FALLBACK_TYPE_ORDER = (RoomType.SR, RoomType.D, RoomType.C, RoomType.W)`, with a comment noting the deliberate inclusion of D rooms and the deliberate contrast with `_ROOM_MOVE_FALLBACK_TYPES` (which serves Pass 1/2 displaced-doctor relocation and excludes D).
   - The fallback sequence can be built once per call of `_pass3_partner_salaried_fallback()` (it depends only on context, not on the grid), or once per run and passed in — either is fine; do not rebuild it per doctor per room check.
   - Take the first room in the sequence that is free (`grid.is_room_free(gen_week, day, period, room_id)`). Skip rooms already tried via the preference list only if you wish — re-checking them is harmless since they were not free; a simple linear walk of the fallback sequence is acceptable.
2. If the fallback finds a room: `grid.assign_room(...)` as normal, and log with `action="assign_room"` and a message clearly marking it as a forced fallback, e.g. `"Assigned fallback room {code} to {doctor.code} (pass 3, no preferred room free; forced into first free room by type priority SR > D > C > W)."`
3. If a preference-list room was found (existing path), keep the existing log message unchanged.
4. Only if both the preference list and the fallback sequence are exhausted, emit the `no_partner_salaried_room` warning with the updated message: `"No free room anywhere for {doctor.code} on {day} {period}; slot remains unresolved."`
5. Update the module docstring:
   - Pass 3 bullet: describe preference list first, then forced fallback by type priority SR → D → C → W (rooms ordered by code within type), no displacement.
   - The paragraph "Pass 3 gets neither: it is not displacement, and the plan is explicit that a Pass-3 doctor only ever tries their own preference list." — rewrite to state that Pass 3 has its own fallback (SR/D/C/W by type, D included), distinct from the Pass 1/2 displaced-doctor pool (C/W/SR, D excluded), and that the D inclusion is deliberate because Pass 3 runs after all Trainee/AHP D-room demand is settled.
6. Tests (`TestPass3PartnerSalariedFallback`):
   - Delete `test_no_fallback_beyond_own_preference_list` and replace it with a test asserting the opposite: preference room occupied, one free non-preferred room exists, doctor is assigned that room and **no** warning is emitted; decision log entry message identifies it as a fallback assignment.
   - Add a fallback-ordering test: no preferred rooms free; free rooms of multiple types available (e.g. a free W room, a free C room, a free D room, a free SR room); assert the SR room is chosen. A second case with SR occupied asserting the D room is chosen over C and W is sufficient to pin the full ordering.
   - Add a within-type ordering test: two free rooms of the same type with codes out of creation order; assert the alphabetically-first code is chosen.
   - Add an exhaustion test: every room occupied; assert `no_partner_salaried_room` is emitted with the new wording and the slot remains unresolved.
   - Verify no *other* existing test asserts the old warning fires when only the preference list is exhausted — if any does (outside the deleted test), it must be updated to reflect that the warning now requires total exhaustion.
   - Run the full engine test suite, not just this file: Phase 9B/9C/12 and `test_generate.py` tests may have fixtures where a Pass 3 slot was previously left unresolved and now gets a fallback room, changing downstream assertions. Fix any such fixtures by occupying the fallback rooms or adjusting expectations — do not weaken the new Pass 3 behaviour to keep an old fixture green.

# Task 2: Documentation corrections

**A: State of the world.** Task 1 is complete: Pass 3 now performs the SR → D → C → W fallback, tests are green. Three documents still describe the old no-fallback behaviour as deliberate.

**B: Relevant files and deliverables.**
- `docs/phase-pipeline.md` — Phase 7–9A section (Pass 3 paragraph, and the two "Displacement room-finding" paragraphs that reference Pass 3).
- `Architecture.md` — the Phases 7–9A bullet in the Pipeline section.
- Deliverable: both documents describe the fallback correctly; no remaining text claims Pass 3 is preference-list-only.

**C: Instructions.**

1. `docs/phase-pipeline.md`:
   - Rewrite the Pass 3 paragraph: preference list first; if nothing on the list is free, force into the first free room by type priority SR → D → C → W (rooms ordered by code within type); no displacement; warn only if every room is occupied. State explicitly that D rooms are included here (Pass 3 runs after all Trainee/AHP D-room demand) and that this differs from the Pass 1/2 displaced-doctor relocation pool, which excludes D.
   - In both "Displacement room-finding" paragraphs, correct the sentences claiming "Pass 3 gets neither, since it is not displacement" / "this pass deliberately does not fall back to any other free room" — Pass 3 does have a fallback; what it does not have is displacement. Keep the Pass 1 vs Pass 2 asymmetry text unchanged.
2. `Architecture.md`, Phases 7–9A bullet: replace "Pass 3 does **not** — it only ever walks the doctor's own preference list. This asymmetric scoping is deliberate, not an inconsistency" with a sentence stating Pass 3 walks the preference list then falls back to the first free room by type priority SR → D → C → W (D rooms included, unlike the displacement relocation pool), never displacing.
3. Do not add historical notes about the porting error to either document — describe current behaviour only. (Per the project's documentation guidelines: design decisions and current architecture, no changelog.)
