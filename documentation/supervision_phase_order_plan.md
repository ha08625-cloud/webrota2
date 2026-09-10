# Plan — Run Phase 9C before room allocation and seat the supervisor in SR

Provisional plan (workflow step 1). Rewritten to match the intended design.
Not yet reviewed or expanded into an implementation plan.

## Intent (as stated by the user)

1. Phases 0–5 run exactly as they do today.
2. Phase 9C then runs, before Phases 7–9A.
3. `is_eligible_supervisor` means: Partner/Salaried, `role is None`, not on
   leave, not WFH, `template_type` not in (`NO_SURGERY`, `ADMIN_TIME`) —
   **and no room test at all**.
4. The chosen supervisor is placed in the SR room; any doctor already in SR
   is displaced to *no room*.
5. The supervisor is then protected from all later room moves, so they are
   guaranteed to end the run in SR.

## Scope

`0 → 2 → 4 → 5 → 9C → 7–9A → 9B → 12` (today: `… → 7–9A → 9B → 9C → 12`).

In scope: `generate.py` phase order; `phase9c.py` eligibility predicate and
room placement; supervisor-immobility guards in `phase7_9a.py` and
`phase9b.py`; the re-rooming of the displaced SR occupant (see R1); tests;
documentation.

Out of scope: the supervision selection rule itself (weighted `SUPERVISION`
counter, preference multipliers, alphabetical tiebreak); the trainee-counting
rule; data model, API and frontend (`superviseeCount.ts` mirrors trainee
counting, which is untouched).

## Why

- **SR is currently wasted in the common case.** `_swap_into_sr()` only acts
  on an SR room *occupied by someone else* (`if occupant_id is None:
  continue`). Pass 3 of 7–9A fills rooms D > C > W > SR, so SR is usually the
  last room filled and often still empty when 9C runs today — the supervisor
  then stays in a D room and SR sits unused.
- **9C can currently undo Phase 9B.** 9B exists to remove AM/PM room swaps
  between Partner/Salaried doctors. 9C runs after it and moves a doctor's room
  for a single period, which can reintroduce the very swap 9B removed. Moving
  9C earlier puts 9B back downstream where it can clean up.
- **Choosing the supervisor before rooms are allocated is the point.** Once
  supervision is decided first, room allocation can be made to serve it
  (supervisor in SR, immobile) instead of constraining it.

## Design decisions

**D1 — One predicate, no room test.**
`is_eligible_supervisor(context, grid, slot)` keeps its name and signature and
drops the room criterion entirely: Partner/Salaried, `role is None`, not on
leave, not WFH, `template_type` not in (`NO_SURGERY`, `ADMIN_TIME`).
`_SUPERVISOR_ROOM_TYPES` is deleted. No second predicate, no split — Phase 12
Checks 4a/4b keep importing the same function and see the same rule.

This is required by the reorder, not merely tidy: a role-free Partner/Salaried
doctor gets a room only from Pass 3 of 7–9A, so at 9C's new position almost
every candidate is roomless and the old D-or-SR test would empty the pool in
nearly every session.

**D2 — 9C always seats the supervisor in SR, displacing the occupant.**
After selection, unconditionally:

1. If the supervisor already holds the SR room, stop.
2. If another doctor holds SR, `grid.free_room(...)` them — they are left with
   no room (see R1 for what re-rooms them).
3. `grid.free_room(...)` the supervisor's own current room, if any, then
   `grid.assign_room(...)` them into SR.

Implementation note: `RotaGrid.assign_room` frees the *assigning* doctor's
previous room but does **not** evict an existing occupant of the target room —
assigning over an occupied room leaves the occupant's `_doctor_room` entry and
`slot.assigned_room_id` stale. The occupant must be freed explicitly first.

`_swap_into_sr()` and its swap semantics (occupant takes the supervisor's
vacated room) are deleted. The new step logs one entry, `seat_supervisor_in_sr`,
naming the displaced doctor when there is one.

**D3 — The supervisor goes to SR even if a template pinned them elsewhere.**
"They must end up in SR" is taken literally: a `PRE_ASSIGNED` template room on
the supervisor's slot is overridden. This is the same class of override as
displacing a pinned SR occupant under D2, so treating the two asymmetrically
would be incoherent. *Flagged for confirmation at review* — it is a change from
the previous draft, which let a pinned supervisor keep its room.

**D4 — SR room selection.** `context.rooms_by_type[RoomType.SR]` sorted by
code; the first entry is "the SR room". The seed has exactly one, but the
schema does not constrain it. If the practice has **no** SR room configured,
9C logs that fact and leaves the supervisor roomless; Pass 3 rooms them
normally and rule 5 no longer applies (nothing to protect).

**D5 — Later phases must not move a supervisor.**
Once `is_supervising` is set, the slot's room is fixed for the rest of the run:

- 7–9A Pass 1 `_is_displaceable_full_day` (~line 431) and Pass 2
  `_is_displaceable_single` (~line 696): reject a slot with
  `is_supervising=True`.
- 7–9A Pass 3: no change needed — it only touches slots with
  `assigned_room_id is None`, and a supervisor holds SR.
- 9B: skip any swap pair where either doctor is supervising in either period
  of that day. 9B rewrites the PM room to match AM, which would pull an
  SR-seated supervisor out of SR.

Under D2 the Pass 1/2 guards are belt-and-braces — those passes only displace
D-room holders and a supervisor holds SR — but they are cheap and make the
invariant true independently of the room policy. The 9B guard is a live
exposure: a supervisor in SR (PM) opposite a doctor holding SR in AM is exactly
the shape 9B looks for.

**D6 — The displaced occupant's ROOM_MOVE counter is incremented.**
Phase 4 increments `ROOM_MOVE` on every eviction, "even when the subsequent
relocation search fails and they are left roomless — the counter records the
disruption, not the destination". A 9C displacement is the same kind of event,
so it should be counted the same way, and doing so keeps the displaced doctor
lower in later room-move tie-breaks. (The old `_swap_into_sr` did not touch any
counter; this is a deliberate change.) *Flagged for confirmation at review.*

**D7 — Phase 12 checks: no code change, but a weaker rule.**
Checks 4a/4b keep calling `is_eligible_supervisor`, which no longer tests
rooms, so they can no longer catch a supervisor sitting somewhere unsuitable.
Recommended addition (*flagged for review*): a new read-only check that every
`is_supervising` slot holds an SR room — cheap, and it is the only thing that
validates the invariant rules 4 and 5 are there to create, including after a
manual edit moves a supervisor's room.

## Risks and open points

**R1 — The displaced occupant may never get a room back. This is the one that
needs a decision before implementation.**

7–9A re-rooms a slot only if `slot.template_type == MasterSessionType.
REQUIRES_ROOM` — that filter is in all three candidate functions
(`_full_day_candidates`, `_single_session_candidates`,
`_pass3_partner_salaried_fallback`). Phase 12's `_check_unresolved_rooms`
filters the same way. So a displaced occupant whose slot is `PRE_ASSIGNED` or
`ADMIN_TIME`-with-room is **silently left roomless for the rest of the run**,
with no warning.

This is not hypothetical. In the seeded master rota, SB (Partner) is
`PRE_ASSIGNED` to SR on **Friday PM in all four weeks**. Any Friday PM with a
supervisable trainee where SB is not the chosen supervisor would evict SB from
SR and leave them with no room at all.

Options:

- **R1-a (recommended).** Add a transient (non-persisted, default `False`)
  `displaced_by_supervision` field to `SessionSlot`, set by 9C on the displaced
  slot, and widen the three 7–9A candidate filters (and Phase 12 Check 3) from
  `template_type == REQUIRES_ROOM` to `REQUIRES_ROOM or
  displaced_by_supervision`. Keeps the user's "displaced to no room" semantics
  exactly, and lets normal room allocation rehouse them one phase later.
- **R1-b.** 9C relocates the occupant itself via the shared
  `find_relocation_room` (preference list, then C/W/SR), leaving them roomless
  only if that search fails. Self-contained, mirrors Phase 4/5 eviction
  behaviour — but it is not literally "displaced to no room", and it re-rooms
  them before Passes 1/2 have expressed their D-room demand.
- **R1-c.** Do nothing; accept silent roomless slots. Not recommended: it
  breaks the seeded rota every Friday PM.

**R2 — A displaced clinic doctor can lose their eligible room.** Phase 5
guarantees a `room_required` clinic sits in one of that clinic's
`eligible_room_ids`. If the SR occupant holds a clinic role and SR is on that
clinic's eligible list, displacing them breaks the guarantee: Pass 3 knows
nothing about clinic eligible-room lists and will rehouse them from their own
preference list, and nothing re-checks it. Same for a Phase 4 duty doctor who
ended up in SR. Eligible-room lists are user-configured (not seeded), so the
exposure depends on the practice's setup. Options: accept and note it in the
log; or exclude role-holding occupants from displacement (which weakens rule 4
and would leave the supervisor out of SR in those sessions). *Needs a decision.*

**R3 — Pool and rationale text is written in room terms.**
`_ineligible_lines()` ("has no room this session", "in {room} ({type}), not a D
or SR room") and `_pool_rationale()` ("Eligible pool (Partner/Salaried,
role-free, in a D or SR room)") describe a rule that will no longer exist.
These are user-facing generation-log strings and must be rewritten, or the log
will explain a decision that is not being made. The room-based branches in
`_ineligible_lines` are deleted outright.

**R4 — Rota output changes for every existing scenario.** Supervisors now sit
in SR; the doctor who used to get SR from Pass 3's fallback gets something
else; a displaced SR occupant's `ROOM_MOVE` counter shifts under D6. Engine
tests that assert concrete room assignments will need updating well beyond the
9C tests.

**R5 — SR is a stated preference for three doctors** (LFM, HP, LB list SR as
their alternate room in `setup.csv`). They will now lose it to whoever is
supervising. Expected, not a defect, but worth confirming with the user since
it is a visible change to those three doctors' rotas.

## Task 1: Engine — eligibility rule and SR seating

**State of the world:** Nothing done yet. This is the core change.

**Files:**
- `backend/app/engine/phases/phase9c.py` — drop the room test from
  `is_eligible_supervisor` and delete `_SUPERVISOR_ROOM_TYPES` (D1); replace
  `_swap_into_sr()` with unconditional SR seating plus displacement (D2, D3,
  D4, D6); rewrite the pool and ineligibility rationale text (R3); rewrite the
  module docstring, including decisions 2, 3, 5 and 6, which all describe the
  old room-based rule.
- `backend/app/engine/generate.py` — move `run_phase9c(...)` above
  `run_phase7_to_9a(...)`; update the module docstring's phase order.
- `backend/app/engine/datatypes.py` — the `displaced_by_supervision` transient
  field, if R1-a is accepted.

**Instructions:** Keep `is_eligible_supervisor`'s name and signature so
`phase12.py`'s import is untouched. 9C's pool, warning, counter increment and
`assign_supervisor` log entry are otherwise unchanged. The seating step logs
its own entry and does not touch `is_supervising` or the SUPERVISION counter;
whether it touches `ROOM_MOVE` is D6.

## Task 2: Engine — supervisor immobility and re-rooming the displaced

**State of the world:** Task 1 done: 9C runs before 7–9A and seats the
supervisor in SR.

**Files:**
- `backend/app/engine/phases/phase7_9a.py` — Pass 1 and Pass 2 victim guards
  (D5); the widened candidate filters, if R1-a is accepted.
- `backend/app/engine/phases/phase9b.py` — skip pairs involving a supervising
  doctor (D5).
- `backend/app/engine/phases/phase12.py` — Check 3's filter under R1-a; the
  new supervisor-in-SR check under D7.

## Task 3: Tests

**State of the world:** Tasks 1–2 done; the engine behaves as intended.

**Files:** `backend/tests/test_engine/test_phase9c.py` (516 lines — the
room-eligibility and SR-swap cases are the bulk of the rework),
`test_phase12.py`, `test_phase7_9a.py`, `test_phase9b.py`, `test_generate.py`.

**New coverage to add:** supervisor seated in an empty SR; SR occupied by
another doctor → occupant displaced and (per R1) re-roomed by 7–9A; supervisor
with a `PRE_ASSIGNED` room is still moved to SR (D3); a roomless
Partner/Salaried doctor is a valid candidate (D1, the case the old rule
excluded); no SR room configured → supervisor left for Pass 3 (D4); Pass 1/2
will not displace a supervisor; 9B will not move a supervisor's PM room;
Phase 12 flags a supervising slot that is not in SR (D7); a supervision-driven
displacement of the seeded SB Friday-PM `PRE_ASSIGNED` SR slot leaves SB with a
room (R1 regression test).

## Task 4: Review and documentation

**State of the world:** Tasks 1–3 complete and the feature is live. This step
is review and documentation only.

**Files:**
- `documentation/phase_pipeline.md` — execution-order block; the Phase 9C
  section (steps 1–5, the eligibility paragraph, the "Depends on" line, and
  divergence 2, which describes the now-removed SR fast path); Phase 7–9A's
  and 9B's supervisor guards; Phase 12's "Depends on" line.
- `documentation/architecture-clinical.md` — the phases directory line (~22),
  the numbering note (~26), the Phase 4 note (~48, which cites Phase 9C's
  D-room pool as the reason evicted trainees stay in D rooms — that rationale
  disappears with the room criterion), and the Phase 9C summary (~52).
- Delete this plan file.
