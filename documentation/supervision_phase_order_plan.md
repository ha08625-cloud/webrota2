# Plan — Run Phase 9C before room allocation and seat the supervisor in SR

Provisional plan (workflow step 1). Rewritten to match the intended design;
all open points from the first review round are now decided. Not yet expanded
into an implementation plan.

## Intent (as stated by the user)

1. Phases 0–5 run exactly as they do today.
2. Phase 9C then runs, before Phases 7–9A.
3. `is_eligible_supervisor` means: Partner/Salaried, `role is None`, not on
   leave, not WFH, `template_type` not in (`NO_SURGERY`, `ADMIN_TIME`) —
   **and no room test at all**.
4. The chosen supervisor is placed in the SR room; any doctor already in SR
   is displaced to *no room* (role holders excepted — see D3).
5. The supervisor is then protected from all later room moves, so they end
   the run in SR.

## Scope

`0 → 2 → 4 → 5 → 9C → 7–9A → 9B → 12` (today: `… → 7–9A → 9B → 9C → 12`).

In scope: `generate.py` phase order; `phase9c.py` eligibility predicate and
room placement; supervisor-immobility guards in `phase7_9a.py` and
`phase9b.py`; re-rooming the displaced SR occupant (D5); removing SR from the
preferred-room pickers (D9); tests; documentation.

Out of scope: the supervision selection rule itself (weighted `SUPERVISION`
counter, preference multipliers, alphabetical tiebreak); the trainee-counting
rule; the rota data model and rota API; `superviseeCount.ts` (mirrors trainee
counting, which is untouched). The only frontend/API work is D9.

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
- **Deciding supervision before rooms are allocated is the point.** Once
  supervision is settled first, room allocation serves it (supervisor in SR,
  immobile) instead of constraining it. SR becomes the supervision room by
  design, which is also why it stops being a doctor preference (D9).

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

**D2 — 9C seats the supervisor in SR.**
After selection:

1. If the supervisor already holds the SR room, stop.
2. If SR is held by another doctor **who holds a role**, stop — see D3. The
   supervisor keeps whatever room they have (usually none) and Pass 3 rooms
   them normally.
3. Otherwise `grid.free_room(...)` any occupant (D4), then
   `grid.free_room(...)` the supervisor's own current room if they have one
   and `grid.assign_room(...)` them into SR.

Implementation note: `RotaGrid.assign_room` frees the *assigning* doctor's
previous room but does **not** evict an existing occupant of the target room —
assigning over an occupied room leaves the occupant's `_doctor_room` entry and
`slot.assigned_room_id` stale. The occupant must be freed explicitly first.

`_swap_into_sr()` and its swap semantics (occupant takes the supervisor's
vacated room) are deleted. The new step logs one entry, `seat_supervisor_in_sr`,
naming the displaced doctor when there is one, and a distinct entry when it
stands down under D3 so the log explains why the supervisor is not in SR.

**D3 — A role-holding SR occupant is not displaced.**
If the SR occupant holds a duty or clinic role (`slot.role is not None`), 9C
leaves them alone and the supervisor is not seated in SR that session. This
protects two guarantees the later phases cannot restore: Phase 5 guarantees a
`room_required` clinic sits in one of that clinic's `eligible_room_ids`, and
Phase 4 guarantees a duty doctor's room — Pass 3 knows about neither, so it
would rehouse them from their own preference list and nothing would re-check
it. Rule 5 still applies to the supervisor in this case (the guards key on
`is_supervising`, not on the room), it just has nothing meaningful to protect.

**D4 — A displaced occupant is left with no room, and gains a ROOM_MOVE.**
The occupant is freed outright rather than swapped into the supervisor's old
room; D5 is what gets them a new one. Their `ROOM_MOVE` system counter is
incremented at the point of displacement, matching Phase 4, which counts every
eviction "even when the subsequent relocation search fails and they are left
roomless — the counter records the disruption, not the destination". This also
pushes them down later room-move tie-breaks. (The old `_swap_into_sr` touched
no counter; this is a deliberate change.)

**D5 — `displaced_by_supervision` makes 7–9A re-room the displaced doctor.**
A transient, non-persisted field on `SessionSlot` (`displaced_by_supervision:
bool = False`), set by 9C on the displaced slot. Without it the displaced
doctor is often never re-roomed at all — see R1. The three 7–9A candidate
filters and Phase 12 Check 3 all currently test
`slot.template_type == MasterSessionType.REQUIRES_ROOM`; each becomes
"REQUIRES_ROOM **or** `displaced_by_supervision`". Best expressed as one
shared helper (e.g. `needs_room(slot)`) so the four call sites cannot drift.

The field is deliberately not persisted: it is a within-run signal between two
phases, and `RotaSession` has no business recording it.

**D6 — The supervisor goes to SR even if a template pinned them elsewhere.**
A `PRE_ASSIGNED` template room on the supervisor's slot is overridden — "they
must end up in SR" is taken literally, and it would be incoherent to override a
pin on a displaced occupant but not on the supervisor.

**D7 — SR room selection.** `context.rooms_by_type[RoomType.SR]` sorted by
code; the first entry is "the SR room". The seed has exactly one, but the
schema does not constrain it. If the practice has **no** SR room configured,
9C logs that and leaves the supervisor roomless; Pass 3 rooms them normally.

**D8 — Later phases must not move a supervisor.**
Once `is_supervising` is set, the slot's room is fixed for the rest of the run:

- 7–9A Pass 1 `_is_displaceable_full_day` (~line 431) and Pass 2
  `_is_displaceable_single` (~line 696): reject a slot with
  `is_supervising=True`.
- 7–9A Pass 3: no change needed — it only touches slots with
  `assigned_room_id is None`. A supervisor seated in SR is skipped; a
  supervisor left roomless under D3 or D7 is roomed here by design.
- 9B: skip any swap pair where either doctor is supervising in either period
  of that day. 9B rewrites the PM room to match AM, which would pull an
  SR-seated supervisor out of SR.

Under D2 the Pass 1/2 guards are belt-and-braces — those passes only displace
D-room holders, and a supervisor holds SR or nothing — but they are cheap and
make the invariant true independently of the room policy. The 9B guard is a
live exposure: a supervisor in SR (PM) opposite a doctor holding SR in AM is
exactly the shape 9B looks for.

**D9 — SR can no longer be chosen as a room preference.**
SR is now the supervision room, so it is removed from both preferred-room
pickers: the specific-room list must exclude rooms of type SR, and the
room-type list must exclude `RoomType.SR`. Enforced in the API
(`PUT /doctors/{id}/preferred-rooms`, rejecting an SR room id or an SR room
type with a 422) as well as hidden in `DoctorFormDialog.tsx`, so the rule holds
against a direct API call.

Existing data is left as it is: LFM, HP and LB keep SR as their alternate room
in `setup.csv` and in any seeded database, and simply never win SR in a
supervised session. No migration, no seed edit.

That does need care at the seam, though. The endpoint is replace-all, so the
dialog re-submits every row it loaded; if it loads an existing SR row and the
API rejects SR, those three doctors become unsaveable. So the dialog must drop
SR rows on load as well as hide SR from the two pickers — editing one of those
doctors then quietly removes their SR preference, which is the intended
direction of travel. Filtering only the pickers is not enough.

Note this restricts *preferences* only. SR stays in the displaced-doctor
fallback pools (`find_relocation_room`'s C/W/SR, Pass 1's receiving pool,
Pass 3's D>C>W>SR sequence) — in an unsupervised session SR is an ordinary
free room and there is no reason to waste it.

**D10 — Phase 12 gains no supervisor-in-SR check.** Checks 4a/4b keep calling
`is_eligible_supervisor`, which no longer tests rooms; nothing validates that a
supervisor sits in SR. Considered and rejected as not worth the check.

## Risks and open points

**R1 — Why D5 exists.** 7–9A re-rooms a slot only if
`slot.template_type == MasterSessionType.REQUIRES_ROOM`; that filter is in all
three candidate functions (`_full_day_candidates`,
`_single_session_candidates`, `_pass3_partner_salaried_fallback`), and Phase 12's
`_check_unresolved_rooms` filters the same way. Without D5, a displaced
occupant whose slot is `PRE_ASSIGNED` or `ADMIN_TIME`-with-room is silently
left roomless for the whole run, with no warning. In the seeded master rota SB
(Partner) is `PRE_ASSIGNED` to SR on **Friday PM in all four weeks**, so this
fires on real data. D5 must land in the same change as D2, not after it.

**R2 — Pool and rationale text is written in room terms.**
`_ineligible_lines()` ("has no room this session", "in {room} ({type}), not a D
or SR room") and `_pool_rationale()` ("Eligible pool (Partner/Salaried,
role-free, in a D or SR room)") describe a rule that will no longer exist.
These are user-facing generation-log strings and must be rewritten, or the log
will explain a decision that is not being made. The room-based branches in
`_ineligible_lines` are deleted outright.

**R3 — Rota output changes for every existing scenario.** Supervisors now sit
in SR; the doctor who used to get SR from Pass 3's fallback gets something
else; a displaced occupant's `ROOM_MOVE` counter shifts under D4. Engine tests
that assert concrete room assignments will need updating well beyond the 9C
ones.

**R4 — D3 and D9 pull against each other in one narrow case.** A clinic whose
`eligible_room_ids` contains SR can hold SR against the supervisor every week
(D3), and no preference rule prevents that, since clinic eligible-room lists
are configured separately from doctor preferences and D9 does not touch them.
If that turns out to happen in practice, the fix is to remove SR from that
clinic's eligible rooms in setup — worth mentioning to the user rather than
coding around.

## Task 1: Engine — eligibility rule and SR seating

**State of the world:** Nothing done yet. This is the core change.

**Files:**
- `backend/app/engine/phases/phase9c.py` — drop the room test from
  `is_eligible_supervisor` and delete `_SUPERVISOR_ROOM_TYPES` (D1); replace
  `_swap_into_sr()` with SR seating, the D3 stand-down, displacement and the
  `ROOM_MOVE` increment (D2, D3, D4, D6, D7); set `displaced_by_supervision`
  (D5); rewrite the pool and ineligibility rationale text (R2); rewrite the
  module docstring, whose decisions 2, 3, 5 and 6 all describe the old
  room-based rule.
- `backend/app/engine/datatypes.py` — the transient
  `displaced_by_supervision` field on `SessionSlot` (D5).
- `backend/app/engine/generate.py` — move `run_phase9c(...)` above
  `run_phase7_to_9a(...)`; update the module docstring's phase order.

**Instructions:** Keep `is_eligible_supervisor`'s name and signature so
`phase12.py`'s import is untouched. 9C's pool, warning, SUPERVISION increment
and `assign_supervisor` log entry are otherwise unchanged; the seating step
touches neither `is_supervising` nor the SUPERVISION counter. `run_phase9c`
already takes `counters`, so the `ROOM_MOVE` increment needs no signature
change.

## Task 2: Engine — supervisor immobility and re-rooming the displaced

**State of the world:** Task 1 done: 9C runs before 7–9A, seats the supervisor
in SR and marks the doctor it displaced.

**Files:**
- `backend/app/engine/phases/phase7_9a.py` — the shared `needs_room(slot)`
  helper across the three candidate filters (D5); Pass 1 and Pass 2 victim
  guards (D8).
- `backend/app/engine/phases/phase9b.py` — skip pairs involving a supervising
  doctor (D8).
- `backend/app/engine/phases/phase12.py` — Check 3's filter uses the same
  `needs_room` rule (D5). No other check changes (D10).

## Task 3: SR is no longer a room preference

**State of the world:** Tasks 1–2 done; the engine behaves as intended. This
task is independent of them and could be done in either order.

**Files:**
- `backend/app/api/routers/doctors.py` / `backend/app/api/schemas/doctor.py` —
  reject an SR room id or `RoomType.SR` in `PUT
  /doctors/{id}/preferred-rooms` (D9).
- `frontend/src/components/DoctorFormDialog.tsx` — filter SR out of both the
  "Add specific room" and "Add room type" pickers, **and** drop SR rows when
  seeding `rows` from `detail.preferred_rooms`, or the replace-all PUT will
  422 on the three doctors who already have SR (D9).

**Instructions:** No migration and no `setup.csv` edit — existing SR rows stay
(D9). Do not touch the displaced-doctor fallback pools in
`room_relocation.py` or `phase7_9a.py`; SR remains a valid fallback room.

## Task 4: Tests

**State of the world:** Tasks 1–3 done.

**Files:** `backend/tests/test_engine/test_phase9c.py` (516 lines — the
room-eligibility and SR-swap cases are the bulk of the rework),
`test_phase12.py`, `test_phase7_9a.py`, `test_phase9b.py`, `test_generate.py`;
`backend/tests/test_api/` doctors tests; `DoctorFormDialog.test.tsx`.

**New coverage to add:** supervisor seated in an empty SR; SR held by a
role-free doctor → displaced, `ROOM_MOVE` incremented, re-roomed by 7–9A
(D4, D5); SR held by a clinic or duty doctor → no displacement, supervisor
left for Pass 3 (D3); supervisor with a `PRE_ASSIGNED` room is still moved to
SR (D6); a roomless Partner/Salaried doctor is a valid candidate (D1 — the
case the old rule excluded); no SR room configured (D7); Pass 1/2 will not
displace a supervisor, and 9B will not move a supervisor's PM room (D8); the
seeded SB Friday-PM `PRE_ASSIGNED` SR slot ends with a room (R1 regression);
the API rejects an SR room id and an SR room type, and the dialog offers
neither (D9).

## Task 5: Review and documentation

**State of the world:** Tasks 1–4 complete and the feature is live. This step
is review and documentation only.

**Files:**
- `documentation/phase_pipeline.md` — execution-order block; the Phase 9C
  section (steps 1–5, the eligibility paragraph, the "Depends on" line, and
  divergence 2, which describes the now-removed SR fast path); the 7–9A and 9B
  supervisor guards and the `displaced_by_supervision` hand-off; Phase 12's
  "Depends on" line.
- `documentation/architecture-clinical.md` — the phases directory line (~22),
  the numbering note (~26), the Phase 4 note (~48, which cites Phase 9C's
  D-room pool as the reason evicted trainees stay in D rooms — that rationale
  disappears with the room criterion), and the Phase 9C summary (~52). Record
  SR's new status as the supervision room, including D9.
- Delete this plan file.
