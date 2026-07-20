# Plan

Restore the original GAS "phase 8" three-tier displacement priority in Pass 2 of the room-resolution phase (`backend/app/engine/phases/phase7_9a.py`). When Pass 2 must bump a Partner/Salaried doctor out of a D room to house a Trainee/AHP, candidates are ranked first by how disruptive the move is to the rest of their day (three tiers), then by the existing weighted room-move fairness score, then by doctor code.

# Scope

- In scope: Pass 2 candidate ranking (`_find_single_session_displacement`), a new priority helper, the DecisionLog message for the Pass 2 displacement pick, and engine tests.
- Out of scope: Pass 1 and Pass 3 corrections (separate ticket), Phase 5 displacement, any API/frontend/data-model change. No migration. No counter schema change.
- Pass 2's candidate *filter* is already correct (it deliberately does not exclude full-day trainees, so it picks up anything Pass 1 could not resolve) — no change there.

# Design Decisions

1. **Priority 1 definition is "no full-day room setup to fragment", not the GAS wording "only working one session".** The other-period slot counts as Priority 1 if it is absent (`None`), on leave, or has `assigned_room_id is None`. A doctor working the other session roomlessly (e.g. PM duty with no room, admin time with no template room, or a REQUIRES_ROOM slot Pass 3 has not yet filled) is Priority 1. Confirmed by user.
2. **The GAS "moved this week" tier is deliberately dropped.** It existed only as a performance workaround because GAS could not afford to re-read counters after every move. This engine increments `ROOM_MOVE` in `CounterState` immediately on every displacement, so the weighted score is live at every selection. Confirmed by user.
3. **A doctor may be bumped twice in one day (AM then PM).** After an AM bump their AM room differs from their D room, so their PM slot reclassifies from Priority 3 to Priority 2 and can be selected again — the tier logic prefers re-bumping an already-fragmented doctor over fragmenting a second intact one. This is a consequence of decisions 1 and 2, accepted as consistent with the "no full-day setup to fragment" principle. Their incremented weighted score deprioritises them within tier 2. Note: relocation to a C/W room does **not** remove them from candidacy for the other period — only their still-occupied D-room session makes them a candidate, and that session remains in the D room until (unless) it is itself bumped.
4. **Priority is a property of the (doctor, D-room) pair, not the doctor alone.** Tier 2 vs 3 depends on whether the other slot's room matches the specific D room being considered. Consequence: the tier now also influences *which D room* the trainee receives — the trainee gets the room whose occupant is cheapest to move.
5. **Sort key is the tuple `(priority_tier, weighted_room_move_score, doctor_code)`**, composed by prepending the tier to the existing `_room_move_sort_key` result. Python tuple sorting gives tier grouping with fairness fallback for free; sorting remains fully deterministic.
6. **DecisionLog message must state the deciding stage inline**, per the existing convention in architecture.md for counter-based selections (e.g. "selected on priority tier 1, tie broken on weighted room-move score"). The current "lowest weighted room-move score" wording is replaced.
7. **Pass 1 is untouched and needs no tiering.** Its displacement filter requires `occ_am == occ_pm`, so it can only ever move what Pass 2 would call a Priority 3 doctor, and it relocates them as a unified full day. Verified against the current code.

# Task 1: Engine changes

**A. State of the world.** `backend/app/engine/phases/phase7_9a.py` runs three passes to resolve remaining `REQUIRES_ROOM` slots. Pass 2 (`_pass2_single_session`) currently selects its displacement victim in `_find_single_session_displacement` by sorting `(occupant_id, room_id)` candidate pairs on `_room_move_sort_key` (weighted ROOM_MOVE score, then doctor code) only. Nothing has been completed yet for this ticket.

**B. Files and deliverables.**
- `backend/app/engine/phases/phase7_9a.py` — the only file to modify. Deliverables: a new module-level helper `_displacement_priority()`, an updated sort in `_find_single_session_displacement`, an updated DecisionLog message in `_pass2_single_session`, and an updated module docstring paragraph describing Pass 2's selection order.
- Read-only reference: `backend/app/engine/datatypes.py` (`RotaGrid.get`, `SessionSlot` fields, `CounterState.weighted_system_score`).

**C. Instructions.**

1. Add the helper below the Pass 2 section (signature and semantics exactly as follows):

```python
def _displacement_priority(
    grid: RotaGrid, doctor_id: int, gen_week: int, day: Day,
    period: Period, d_room_id: int,
) -> int:
    """Tier 1 = other session has no room setup to fragment; 2 = other
    session is in a different room anyway; 3 = same D room all day."""
    other = Period.PM if period == Period.AM else Period.AM
    other_slot = grid.get(doctor_id, gen_week, day, other)
    if other_slot is None or other_slot.is_on_leave or other_slot.assigned_room_id is None:
        return 1
    if other_slot.assigned_room_id != d_room_id:
        return 2
    return 3
```

The `is_on_leave` check is defensive ordering: a leave slot should never carry an `assigned_room_id` (Phase 2 skips the room claim for on-leave PRE_ASSIGNED slots), but leave must classify as tier 1 regardless.

2. In `_find_single_session_displacement`, replace the sort:

```python
candidates.sort(key=lambda c: (
    _displacement_priority(grid, c[0], gen_week, day, period, c[1]),
    *_room_move_sort_key(context, counters, c[0]),
))
```

Note the key now needs `c[1]` (the room), not just `c[0]` (the occupant). Do not change the candidate-collection loop, `_is_displaceable_single`, or anything in Pass 1 or Pass 3.

3. In `_pass2_single_session`, the displacement branch must compute the winning candidate's tier (call `_displacement_priority` once more on the returned pair, or have `_find_single_session_displacement` return the tier alongside — returning `(displaced_id, d_room_id, tier)` is preferred to avoid recomputation) and change the log message tail from `"(pass 2, lowest weighted room-move score)."` to `"(pass 2, selected on priority tier {tier}, tie broken on weighted room-move score)."` Keep every other field of the `log.add` call unchanged.

4. Update the module docstring's Pass 2 paragraph to state the selection order: priority tier (1 = other session roomless/absent/on-leave, 2 = different room in the other session, 3 = same D room all day), then weighted ROOM_MOVE score, then doctor code. Add one sentence recording design decision 3 (a doctor bumped in AM reclassifies to tier 2 for PM and may be bumped again).

# Task 2: Engine tests

**A. State of the world.** Task 1 is complete: Pass 2 now ranks displacement candidates by `(tier, weighted score, code)` and logs the tier. The existing suite in `backend/tests/test_engine/test_phase7_9a.py` covers Pass 1/2/3 behaviour and may assert the old log wording or rely on fairness-only victim selection.

**B. Files and deliverables.**
- `backend/tests/test_engine/test_phase7_9a.py` — new tests plus any repairs to existing assertions broken by the new ordering or log message.
- Read-only reference: `backend/tests/test_engine/factories.py` (grid/context builders), `backend/app/engine/phases/phase7_9a.py`.

**C. Instructions.**

Use the existing factory patterns in the file for building contexts and grids. Add tests covering, at minimum:

1. **Tier ordering wins over fairness.** Two D rooms occupied: room X by a tier 3 doctor with a low (favourable) weighted ROOM_MOVE score, room Y by a tier 1 doctor with a high score. The tier 1 doctor is displaced and the trainee receives room Y — asserting both the victim choice and design decision 4 (tier steers room selection).
2. **Tier 2 beats tier 3.** Same structure with a tier 2 occupant (other session assigned to a different room) vs a tier 3 occupant (same D room both sessions).
3. **Fairness breaks ties within a tier.** Two tier 1 occupants; the lower weighted score is displaced. A further case with equal scores asserting alphabetical doctor-code tiebreak.
4. **Tier 1 classification cases.** Other slot absent (no template row), other slot on leave, and other slot `REQUIRES_ROOM` but not yet assigned (the pre-Pass-3 partner case) each classify as tier 1 — most economically tested directly against `_displacement_priority`, plus one end-to-end case through `_pass2_single_session`.
5. **Double-bump behaviour (design decision 3).** A day with one intact full-day tier 3 doctor in D room X and a second intact full-day tier 3 doctor in D room Y, and two single-session trainees (one AM, one PM) when only displacement can house them. Assert that after the AM bump of one doctor, the PM pass selects that *same* doctor (now tier 2) rather than the untouched tier 3 doctor, and that their ROOM_MOVE counter incremented twice. This test pins the accepted behaviour so any future change to it is deliberate.
6. **Log message.** The Pass 2 displacement DecisionLog entry contains "priority tier" and the correct tier number.

Then run the full engine suite and repair any existing test whose expected victim or log wording changed — expectation updates only; do not weaken assertions.
