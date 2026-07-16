# Plan

## Scope

`backend/app/engine/phases/phase7_9a.py`, Pass 1 only (`_pass1_full_day` and its
helpers: `_find_full_day_displacement`, `_is_displaceable_full_day`,
`_best_available_room`, `_room_move_sort_key`). Pass 2 and Pass 3 are not
touched except for one existing Pass 2 test whose premise is invalidated by
this fix (see Testing Impact).

This corrects Pass 1 to match the original GAS "phase 7" behaviour, which the
Python port only partially implemented: it currently only recognises
Trainee/AHP displacement candidates who sit in the *same* D room all day, and
never considers -- or even collects as candidates -- Partner/Salaried doctors
who hold *different* D rooms across AM and PM.

## Design Decisions

1. **Tie-break simplifies to one level, not two.** The GAS "moved least this
   current week" tier existed only because GAS batched counter reads once per
   week to avoid timeouts. This system reads/writes `SystemCounterType.ROOM_MOVE`
   live, and the counter is already incremented immediately after each
   displacement within a run. So a freshly-computed `weighted_system_score` at
   selection time already reflects every prior displacement made earlier in
   the same run/week -- there is nothing left for a separate "this week"
   counter to capture. Final sort key: `(priority_tier, weighted_score, code)`.
   No new counter state is introduced.

2. **Priority tier is computed per-doctor, not per-room.** The current code
   iterates D rooms and looks for a single occupant spanning both sessions.
   The fix iterates displaceable-type doctors and asks "what D room do they
   hold in AM, and in PM" via `grid.get_doctor_room()`. Tier 1: both are D
   rooms and they differ. Tier 2: both are D rooms and they're the same room.
   Anyone not holding a D room in both sessions is not a candidate at all
   (matches your Step B eligibility -- ineligible unless in a D room both AM
   and PM).

3. **Receiving room search drops the preference-list step entirely for Pass
   1.** Per your point 4, this phase only ever checks the fixed C/W/SR
   fallback pool for a room free in *both* AM and PM (per your point 5 -- one
   room valid in both sessions, not two different rooms combined across
   periods). SR stays in the pool per your point 3.

4. **Doctor-first, then room** (not room-first, then doctor). Since the
   receiving room no longer depends on preferences, it doesn't depend on
   which doctor was chosen either -- both orderings produce the same result,
   so the existing "pick candidate, then search for their room" structure is
   kept rather than restructured into a global room check.

5. **Logging for the split-room case (flagged for your confirmation).** When
   a Priority 1 doctor is displaced, the trainee receives two different room
   IDs for one day. Rather than extend `DecisionLogEntry` with a second room
   field, this plan logs two per-period `assign_room`/`displace_room` entries
   for that case (mirroring Pass 2's existing per-period logging), and keeps
   the current single full-day entry (`period=None`) only for the
   same-room case. Say the word if you'd rather add a second room field
   instead and keep one entry per day regardless.

## Task 1: Rewrite candidate discovery and selection

A: State of the world -- Pass 1 currently finds displacement candidates by
scanning D rooms for occupants spanning both AM and PM in the *same* room.
Nothing has been built yet for this fix.

B: Files: `backend/app/engine/phases/phase7_9a.py`.
Deliverables: `_find_full_day_displacement` (or a replacement) returns the
selected doctor plus their AM room id and PM room id (which may differ),
having considered both priority tiers and applied the single-level
weighted-score/alphabetical tie-break within each tier.

C: Instructions
- Replace the room-first iteration with a doctor-first iteration over
  `context.doctors` filtered to `DoctorType.PARTNER`/`DoctorType.SALARIED`.
- For each, look up `grid.get_doctor_room(week, day, Period.AM, doctor_id)`
  and the PM equivalent. Skip if either is `None` or not a `RoomType.D` room.
- Reuse the existing eligibility checks (not on leave, no role, in either
  session) -- these already match your Step B conditions for DUTY/CLINIC/leave
  exclusion.
- Tier 1 if AM room != PM room, tier 2 if equal.
- Sort candidates by `(tier, weighted_system_score, code)`; select the first.
- Return `(doctor_id, am_room_id, pm_room_id)`.

## Task 2: Rewrite the receiving-room search for Pass 1

A: State of the world -- `_best_available_room` currently tries the displaced
doctor's preference list (excluding D rooms) before falling back to any free
C/W/SR room. Task 1 is assumed complete.

B: Files: `backend/app/engine/phases/phase7_9a.py`.
Deliverables: a Pass-1-specific receiving-room search with no preference-list
step.

C: Instructions
- Add a Pass-1-only helper (or a flag/parameter distinguishing it from any
  future Pass 2/3 use of `_best_available_room` -- confirm `_best_available_room`
  is not relied on elsewhere with its current behaviour before changing its
  signature) that checks only `_ROOM_MOVE_FALLBACK_TYPES` (C, W, SR), sorted by
  id, for a room free in both AM and PM.
- If none found, no displacement happens for this trainee/AHP this day --
  same warning path as today (`no_full_day_room`).

## Task 3: Wire candidate + room search into `_pass1_full_day`, handle split rooms

A: State of the world -- Tasks 1-2 provide the pieces; `_pass1_full_day`
currently assumes a single `d_room_id` for both periods throughout.

B: Files: `backend/app/engine/phases/phase7_9a.py`.
Deliverables: full-day assignment correctly places the trainee/AHP into
`am_room_id` for AM and `pm_room_id` for PM (identical in the tier-2 case,
different in tier-1), displaces the chosen doctor into the single receiving
room for both sessions, increments `ROOM_MOVE` once, and logs per the design
decision above (one full-day entry when rooms match, two per-period entries
when they differ).

C: Instructions
- Update the `grid.assign_room(...)` calls for both the trainee/AHP and the
  displaced doctor to use the two room variables from Task 1 rather than a
  single `d_room_id`.
- Branch the logging: same room -> existing single `period=None` entry
  (update message to note tier where useful); different rooms -> two entries,
  one per period, each carrying that period's specific room id, in the style
  of Pass 2's existing `displace_room`/`assign_room` log calls.

## Testing Impact

- New tests needed: Priority 1 displacement (different D rooms AM/PM) with a
  free C/W/SR receiving room; Priority 1 vs Priority 2 tie-break ordering
  (Priority 1 wins even with a worse weighted score, since tier is checked
  first); Priority 1 with no receiving room available (warns, no partial
  assignment).
- `test_displaces_full_day_occupant_once` and
  `test_tiebreak_lowest_room_move_score_wins` -- both same-D-room-all-day
  (tier 2) scenarios, should still pass unchanged in outcome, but worth
  re-running against the rewritten candidate search to confirm no regression.
- `test_fallback_to_non_preferred_cw_sr_room_when_preferred_unavailable` --
  this test's name and setup are specifically about preference-list fallback,
  which Pass 1 no longer has. This test needs to be rewritten or removed; the
  "C1 occupied so displaced doctor goes to W1" scenario is still valid, but
  the *reason* changes from "preference exhausted" to "first free room in the
  fallback pool" -- worth renaming to reflect that.
- `TestPass2SingleSession::test_partial_full_day_failure_still_resolves_per_session`
  -- as agreed, this test's premise (different-D-room-AM/PM is a genuine Pass
  1 failure) is invalidated. With the fix, this scenario is no longer a
  failure at all: the AM occupant becomes a Tier 1 candidate immediately
  (their PM slot is empty/free, meeting the "D room both AM and PM" test
  trivially since there's no PM occupant to conflict with -- actually check:
  this fixture only pre-assigns `am_occupant` to `d_room` in AM, with PM
  slot for `am_occupant` not created at all, so `grid.get_doctor_room(...,
  PM, ...)` returns `None` for them -- meaning they do NOT qualify as a
  Tier 1 candidate either, since Task 1's rule requires a D room in *both*
  sessions). This needs verifying against the actual fixture once Task 1 is
  implemented -- flagging this now because the outcome (whether Pass 1 now
  fully resolves this case, or still falls through to Pass 2 as before) is
  not yet certain and needs to be checked against real candidate data rather
  than assumed.

## Open items for Fable / implementation review

- Confirm whether `_best_available_room` should be split into a Pass-1
  variant and left untouched for future Pass 2/3 work, or whether Pass 2/3
  are expected to be revisited soon enough that a shared, parameterised
  version is worth building now.
- Confirm the logging design decision (two per-period entries vs extending
  the log schema) before implementation.