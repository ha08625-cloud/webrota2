# Plan

Correct Phase 7-9A Pass 1 to match (and in one confirmed place, improve on)
the original GAS phase 7 behaviour. The current Python port only recognises
displacement victims who occupy the *same* D room in both AM and PM. The fix
introduces two priority tiers of victim -- Partner/Salaried doctors holding
*different* D rooms across AM and PM (Priority 1) ahead of those holding the
same D room all day (Priority 2) -- simplifies the tie-break to a single
live weighted-score level, and replaces the displaced doctor's
preference-list room search with a fixed C/W/SR pool search.

# Scope

`backend/app/engine/phases/phase7_9a.py`, Pass 1 only: `_pass1_full_day`,
`_find_full_day_displacement`, `_is_displaceable_full_day`, and a new
Pass-1-specific receiving-room helper. The module docstring is updated as
part of this work.

Explicitly out of scope: Pass 2, Pass 3, `_best_available_room` (which Pass
2 calls at its line-253 displacement site and whose behaviour must not
change), `DecisionLogEntry`'s schema, and all counter storage. No
migrations. No API or frontend changes.

Test file: `backend/tests/test_engine/test_phase7_9a.py` -- new tests, one
rename/rewrite, and re-verification of three existing tests (details in
Task 4).

# Design Decisions

1. **Single-level tie-break: `(priority_tier, weighted_score, code)`.** The
   GAS system had a first tier of "times moved this current week" only
   because reading the room-move counters after every move caused
   multi-minute timeouts, so counters were batch-read once per week and the
   this-week count patched over the staleness. In this system
   `SystemCounterType.ROOM_MOVE` is read and incremented live in memory
   (`counters.increment_system` runs immediately after each displacement,
   and `_room_move_sort_key` computes `weighted_system_score` at selection
   time), so the weighted score already reflects every move made earlier in
   the run. The this-week tier is obsolete and is not ported. No new
   counter state is introduced. (User-confirmed.)

2. **Candidate discovery is per-doctor, not per-room.** Iterate
   Partner/Salaried doctors and ask what D room each holds in AM and PM via
   `grid.get_doctor_room()`. A doctor qualifies only if both lookups return
   a `RoomType.D` room and the existing eligibility checks pass (not on
   leave, no role in either session). Priority 1: the two D rooms differ.
   Priority 2: same D room. Anyone without a D room in both sessions is not
   a candidate at all.

3. **Receiving-room search is the fixed C/W/SR pool only, no preference
   list.** Pass 1 relocates the displaced doctor to the first room (by id,
   matching the existing fallback ordering) of type C, W, or SR that is
   free in *both* AM and PM -- one room for the whole day, never two rooms
   combined across periods. SR remains in the pool. Because Pass 2 still
   uses `_best_available_room` with its preference-then-fallback behaviour,
   that function is left untouched and Pass 1 gets its own small helper.

4. **Doctor-first, then room.** Since the receiving room no longer depends
   on the chosen doctor's preferences, victim selection and receiving-room
   search are independent; the existing "pick candidate, then find their
   room" structure is kept. A corollary: if no pool room is free in both
   sessions, no candidate can be displaced, so there is no per-candidate
   retry loop.

5. **Consolidation check after a Priority 1 displacement (improvement
   beyond GAS, user-confirmed).** Displacing a Priority 1 victim vacates
   two D rooms: `am_room` (their AM room) and `pm_room` (their PM room).
   Before splitting the trainee across them, check whether either room is
   about to become free for the full day: if `grid.is_room_free(week, day,
   PM, am_room)` is true right now, then after the victim moves out,
   `am_room` is free all day -- assign the trainee to `am_room` for both
   sessions. Otherwise apply the same test to `pm_room`
   (`is_room_free(..., AM, pm_room)`). Only if neither consolidates does
   the trainee take `am_room` in AM and `pm_room` in PM. Check `am_room`
   first for determinism. Priority 2 victims skip this branch entirely
   (one room, trivially consolidated).

6. **Logging.** When the trainee ends the day in a single room (Priority 2,
   or Priority 1 consolidated), keep one `displace_room` entry with
   `period=None`, as today; in the consolidated case the message names both
   vacated room codes since `DecisionLogEntry` carries only one `room_id`.
   When the trainee is genuinely split, write two per-period
   `displace_room` entries in the style of Pass 2's existing per-period
   logging, each carrying that period's D room id; `ROOM_MOVE` is still
   incremented exactly once, and at least one of the two messages states
   this so a log reader does not infer two moves. Selection messages state
   the deciding stage inline (e.g. "priority tier 1, tie broken on weighted
   room-move score"), per the DecisionLog verbosity convention in
   architecture.md.

# Task 1: Candidate discovery and selection

A: State of the world -- nothing implemented yet. Pass 1 currently finds
victims by scanning D rooms for a single occupant spanning both sessions
(`_find_full_day_displacement` iterating `d_room_ids` with
`get_room_occupant`). This task replaces that discovery mechanism.

B: Files: `backend/app/engine/phases/phase7_9a.py`.
Deliverable: `_find_full_day_displacement` rewritten to return
`tuple[int, int, int] | None` -- `(doctor_id, am_room_id, pm_room_id)` --
where `am_room_id == pm_room_id` in the Priority 2 case. The `d_room_ids`
parameter is no longer needed by this function; drop it from its signature
(the caller still uses `d_room_ids` for the free-room-first step, which is
unchanged).

C: Instructions
- Iterate `context.doctors` (already ordered by code) filtered to
  `doctor.doctor_type in _DISPLACEABLE_TYPES`.
- For each doctor: `am_room = grid.get_doctor_room(gen_week, day,
  Period.AM, doctor.id)`, `pm_room` likewise for `Period.PM`. Skip if
  either is `None` or `context.room_by_id[room].room_type != RoomType.D`.
- Apply the existing `_is_displaceable_full_day` checks (doctor type, both
  slots exist, neither on leave, no role in either session).
  `_is_displaceable_full_day` itself needs no behavioural change; keep it
  and call it from the new loop.
- Tier: `1` if `am_room != pm_room`, else `2`.
- Collect `(tier, doctor_id, am_room, pm_room)` candidates; sort by
  `(tier, weighted_score, code)` using the existing `_room_move_sort_key`
  for the last two components; return the first as
  `(doctor_id, am_room, pm_room)`, or `None` if no candidates.

# Task 2: Pass-1 receiving-room helper

A: State of the world -- Task 1 complete. Pass 1 currently relocates the
displaced doctor via `_best_available_room` (preference list minus D rooms,
then C/W/SR fallback). `_best_available_room` is also called by Pass 2 and
must not change.

B: Files: `backend/app/engine/phases/phase7_9a.py`.
Deliverable: a new helper, e.g. `_pass1_receiving_room(context, grid,
gen_week, day) -> int | None`, plus `_pass1_full_day` no longer calling
`_best_available_room`. Note the new helper takes no `doctor_id` --
preferences are irrelevant, so the search is victim-independent by design.

C: Instructions
- Build `sorted(r.id for r in context.rooms if r.room_type in
  _ROOM_MOVE_FALLBACK_TYPES)` and return the first id free in both
  `Period.AM` and `Period.PM` (reuse `_first_free_room_both`), else `None`.
- Do not modify `_best_available_room` or its docstring.

# Task 3: Wire into `_pass1_full_day` -- consolidation, assignment, logging

A: State of the world -- Tasks 1-2 complete. `_pass1_full_day` still
assumes a single `d_room_id` throughout its displacement branch.

B: Files: `backend/app/engine/phases/phase7_9a.py`.
Deliverable: the displacement branch of `_pass1_full_day` handling all
three outcomes -- Priority 2 (same room), Priority 1 consolidated (single
room after the check in Design Decision 5), Priority 1 split (two rooms) --
with correct grid assignments, exactly one `ROOM_MOVE` increment, and
logging per Design Decision 6. The free-room-first step at the top of the
loop (`_first_free_room_both` over `d_room_ids`) is unchanged.

C: Instructions
- Unpack `(displaced_id, am_room, pm_room)` from Task 1's return value.
- Call the Task 2 helper; if `None`, emit the existing `no_full_day_room`
  "could not relocate" warning and continue (no partial assignment).
- Determine the trainee's rooms:
  - if `am_room == pm_room`: full-day in `am_room` (Priority 2 path,
    identical to today's behaviour).
  - elif `grid.is_room_free(gen_week, day, Period.PM, am_room)`: full-day
    in `am_room` (consolidated).
  - elif `grid.is_room_free(gen_week, day, Period.AM, pm_room)`: full-day
    in `pm_room` (consolidated).
  - else: `am_room` in AM, `pm_room` in PM (split).
  - Perform these checks *before* any `assign_room` call, while the victim
    still occupies both rooms -- "free in the other session now" is exactly
    "free all day after the victim leaves".
- Move the displaced doctor first: `assign_room(..., AM, displaced_id,
  new_room)` and the PM equivalent (`assign_room` re-points the occupancy
  indexes, freeing their old rooms). Then assign the trainee per the
  branch above. Increment `ROOM_MOVE` once.
- Logging:
  - single-room outcomes: one `displace_room` entry, `period=None`,
    `room_id` = the trainee's room, `related_room_id` = `new_room`. In the
    consolidated case the message must name both vacated room codes and
    state the consolidation (e.g. "vacated D1/D2; trainee consolidated
    into D1"). State the priority tier and tie-break stage in the message.
  - split outcome: two `displace_room` entries, one per period, each with
    that period's D room as `room_id`, `related_room_id` = `new_room`,
    same `doctor_id`/`related_doctor_id` on both; at least one message
    notes "room-move counter incremented once for the day".

# Task 4: Tests

A: State of the world -- Tasks 1-3 complete. Existing Pass 1 tests were
written against the same-room-only behaviour.

B: Files: `backend/tests/test_engine/test_phase7_9a.py`.
Deliverable: the suite below, all green, with no changes to Pass 2/Pass 3
tests.

C: Instructions

New tests (fixtures follow the existing `make_template` /
`_pre_assigned` / `_requires_room` patterns; block the relevant D rooms'
opposite sessions with extra pre-assigned doctors where a scenario needs
consolidation to be impossible):

1. **Priority 1 split**: victim in D1-AM and D2-PM; D1-PM and D2-AM each
   occupied by other doctors (so no consolidation and no free-both D room);
   one free C room. Assert: trainee gets D1 in AM and D2 in PM; victim in
   the C room both sessions; `ROOM_MOVE == 1`; exactly two `displace_room`
   entries, periods AM and PM, correct per-period `room_id`s; no warnings.
2. **Priority 1 consolidated into am_room**: victim in D1-AM and D2-PM;
   D1-PM free; D2-AM occupied. Assert: trainee in D1 both sessions; one
   `period=None` entry; message mentions both D1 and D2.
3. **Priority 1 consolidated into pm_room**: mirror of (2) -- D1-PM
   occupied, D2-AM free. Assert trainee in D2 both sessions.
4. **Priority 1 beats Priority 2 on tier despite worse weighted score**:
   a Priority 1 victim with a high `ROOM_MOVE` raw count and a Priority 2
   victim with zero. Assert the Priority 1 victim is displaced.
5. **Priority 1 with no receiving room**: all C/W/SR rooms occupied in at
   least one session. Assert: `no_full_day_room` warning; trainee
   unassigned in both sessions; victim untouched; `ROOM_MOVE` not
   incremented; no `displace_room` entries.
6. **Preference list ignored in Pass 1**: victim's preference list names
   W1 (or an SR room); C1 is also free. Assert the victim lands in C1
   (first free pool room by id), not their preferred room -- this is the
   behavioural proof that the preference step is gone.

Existing tests:

- `test_displaces_full_day_occupant_once` and
  `test_tiebreak_lowest_room_move_score_wins`: both fixtures pre-assign
  the victim to one D room in both sessions, so they are Priority 2
  candidates under the new discovery -- must pass unchanged. Re-run only.
- `test_fallback_to_non_preferred_cw_sr_room_when_preferred_unavailable`:
  passes as written (C1 occupied, W1 free, victim lands in W1 either way)
  but its name and docstring describe a preference-exhaustion rationale
  that no longer exists. Rename to reflect "first free pool room" (its
  scenario is now redundant with new test 6 above -- either fold it into
  test 6 or keep both with the rename; do not keep the old name).
- `TestPass2SingleSession::test_partial_full_day_failure_still_resolves_per_session`:
  **no change expected.** The fixture gives `am_occupant` a D room in AM
  only (no PM slot exists), so `get_doctor_room(..., PM, ...)` returns
  `None` and they are not a candidate under the new rule, exactly as they
  were not under the old `occ_am == occ_pm` rule. Pass 1 still warns, Pass
  2 still resolves per-session. Verify it passes byte-for-byte unchanged;
  if it fails, stop and re-check Task 1's candidacy rule rather than
  editing the test.

# Task 5: Docstring and documentation

A: State of the world -- Tasks 1-4 complete. The module docstring and the
user's architecture documents still describe the old Pass 1.

B: Files: `backend/app/engine/phases/phase7_9a.py` (docstring only, in this
task). The remaining items are the user's documents -- list them, do not
edit them.

C: Instructions
- Rewrite the module docstring's Pass 1 paragraph and the "Displacing a
  Partner/Salaried doctor" paragraph: Pass 1's victim pool is now
  two-tiered (split-D-room doctors first), the trainee may be consolidated
  or split per Design Decision 5, and Pass 1's receiving-room search is
  pool-only with no preference step (the preference-then-fallback sentence
  now applies to Pass 2 only).
- Flag for the user's documentation updates (not part of the code change):
  - architecture.md, Phases 7-9A bullet: "The two displacement passes get
    the C/W/SR free-room fallback when relocating a displaced doctor" is
    now misleading -- Pass 1 is pool-*only* (no preference step), Pass 2
    retains preference-then-fallback.
  - phase-pipeline.md, Phase 7-9A section: add the two-tier victim
    priority, the single-level live-counter tie-break (and why the GAS
    this-week tier was dropped), and the consolidation improvement over
    GAS.
