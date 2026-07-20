# Implementation Plan: Duty Doctor Room Assignment (Phase 4)

## Scope

Correct the GAS duty-room-assignment behaviour in `phase4.py`
(phase-pipeline.md incorrectly parsed the GAS behaviour for Phase 4):

- Force every duty doctor (primary and secondary) into a D room: preferred
  D room first, then a D8->D1 fallback sweep.
- Displace an expendable occupant of the preferred room if needed; in the
  fallback sweep, displace a Salaried occupant if no D room is free.
- Immediately relocate an evicted doctor: Salaried via the shared
  preferred-then-C/W/SR search, Trainee via D rooms only.
- Increment the evicted doctor's ROOM_MOVE counter for every eviction.
- Abandon WFH on a duty slot (clear `is_wfh`) and room the doctor normally.
- Emit warnings for the failure modes GAS's manual "D?" marker papered
  over silently.
- Extract the single-session relocation search shared with `phase7_9a.py`
  rather than duplicating it.

Out of scope: moving Phase 4's position in the pipeline (confirmed it stays
before Phase 5); any behaviour change to Phase 5, 7-9A, 9B, 9C, or 12.

## Assumptions carried into this revision (user to veto if wrong)

- "Lowest room move counter" means the weighted score
  (`raw_count / sessions_per_week`), tie-broken on doctor code — consistent
  with every other counter comparison in the engine.
- The free-then-evict fallback sweep applies to both entry paths: no
  preferred D room configured, and preferred D room blocked by a protected
  occupant.
- Evicted-Trainee relocation order: their own preferred rooms that are
  D-type, in preference order, then free D rooms by code ascending.
- "WFH abandoned" means `is_wfh` is set to False on the slot, so the
  persisted draft shows a normal working session and Phase 12 Check 4 does
  not flag the duty role.

## Design Decisions

1. **Self-check first.** If the duty doctor's slot already has
   `assigned_room_id` pointing at any D room, leave the room alone and
   apply the role only. Subsumes GAS's preferred-room-specific
   self-occupancy rule with a broader, simpler check.
2. **Self-occupancy of a non-D room.** If the duty doctor is PRE_ASSIGNED
   into a non-D room, they go through the normal flow and are moved into a
   D room; `grid.assign_room` re-points the occupancy indexes, so their old
   room is freed automatically. This case gets its own decision-log entry
   and test. See Decision 12 for what happens when the search then fails.
3. **WFH duty slots.** Phase 0 deliberately permits duty on a WFH slot
   (the doctor comes in). Phase 4 sets `is_wfh = False` on that slot,
   records the override in the decision log, and rooms the doctor exactly
   like any other duty slot. This is the engine's first mutation of
   `is_wfh`. Consequences, verified against the code:
   - Phase 12 Check 4 (`role_on_incompatible_slot`) keys on the `is_wfh`
     **flag**, not on `template_type`, so clearing the flag does suppress
     it. Confirmed at `phase12.py` `_check_role_on_incompatible_slot`.
   - **Correction to revision 2:** Phase 12's unresolved-room check does
     *not* "treat it as a normal slot". That check filters on
     `template_type == REQUIRES_ROOM` first, and a WFH-origin slot keeps
     `template_type == WFH` forever, so the slot is invisible to that
     check whether or not `is_wfh` is cleared. This matters for
     Decision 12c.
   - Phase 5 and Phase 9C both read `is_wfh` and both run after Phase 4,
     so they will now correctly see the doctor as on-site in principle.
     The duty `role` excludes them from clinic assignment (Phase 5) and
     from supervising (Phase 9C's `is_eligible_supervisor` returns False
     on any role-holding slot), so no behaviour actually changes there.
4. **Preferred D room** = the first D-type room in
   `context.preferred_rooms_by_doctor[doctor_id]` (not necessarily list
   position 0).
5. **Occupant lookup** via the existing `grid.get_room_occupant(...)`
   index. At this point in the pipeline the only possible occupants are
   `PRE_ASSIGNED`/`ADMIN_TIME`-with-room slots (Phase 2) and any duty
   doctor already placed earlier in this same Phase 4 run.
   `REQUIRES_ROOM` slots are never occupants here.
6. **Protected occupants** (never displaced): doctor_type `Partner` or
   `AHP`, or any slot already holding a role (`slot.role is not None`)
   regardless of doctor_type — the role guard prevents secondary duty
   evicting primary duty (or vice versa) in the same session, which the
   sorted processing order (primary before secondary per session, per the
   existing `sorted(...)` key in `run_phase4`) makes the only role-holding
   case reachable here.
7. **Expendable occupants of the preferred room**: `Salaried` and
   `Trainee` — the only doctor_types left once Partner/AHP are excluded.
   **Expendability is by doctor_type only, deliberately.** A Salaried
   doctor holding an `ADMIN_TIME`-with-room slot is therefore evictable
   and may be relocated into a clinical room during their admin session.
   This is a conscious choice, not an oversight: it matches Phase 7-9A's
   `_is_displaceable_single`, which also ignores `template_type` and
   guards only on doctor_type, leave, and role. Do not add a
   `template_type` guard here without changing 7-9A to match.
8. **Eviction + relocation, split by evictee type.** Free the evicted
   doctor's room, place the duty doctor there, then immediately relocate
   the evictee, single-session only:
   - **Salaried**: the shared search — their own preferred rooms excluding
     D-type, then first free C/W/SR room (Task 1's extracted helper,
     identical to Phase 7-9A Pass 2 behaviour).
   - **Trainee**: D rooms only — their preferred D-type rooms in
     preference order, then free D rooms **by code ascending**. Never
     C/W/SR. The ascending order here versus the descending sweep of
     Decision 11a is deliberate, not an inconsistency: the sweep
     reproduces GAS's D8->D1 duty search, while relocation follows the
     engine's usual ascending convention. Do not "harmonise" them.
     Note the fragility this buys: if no other D room is free, a
     pre-assigned Trainee is left roomless where the old plan would have
     parked them in C/W/SR. Accepted per user decision.
9. **ROOM_MOVE counter.** Every eviction (preferred-room path and fallback
   sweep alike) increments the evictee's `ROOM_MOVE` system counter, live,
   exactly as Phase 7-9A does — **including when the subsequent relocation
   fails and the evictee is left roomless.** They were moved out of a room
   either way; the counter records the disruption, not the destination.
   `run_phase4` gains a `CounterState` parameter; `generate.py`'s call site
   changes accordingly.
10. **Eviction is unconditional — a deliberate divergence from Pass 2.**
    Phase 7-9A Pass 2 searches for the victim's receiving room *before*
    committing, and abandons the whole displacement if none exists (the
    trainee simply does not get the room). Phase 4 does the opposite:
    duty coverage is mandatory, so the duty doctor takes the D room
    regardless of whether the evictee can be rehoused, mirroring GAS's
    manual "D?" marker. An implementer copying the Pass 2 shape will get
    this wrong.

    Because of this, the grid-mutation order differs from Pass 2:
    - Relocation room **found**: `grid.assign_room(evictee, new_room)`
      first — this re-points the occupancy indexes and frees the D room —
      then `grid.assign_room(duty_doctor, d_room)`. Same as Pass 2.
    - Relocation room **not found**: `grid.free_room(evictee)` explicitly,
      then `grid.assign_room(duty_doctor, d_room)`, then emit the warning
      of Decision 11. Increment ROOM_MOVE in both branches.
11. **Relocation failure.** If the evictee cannot be relocated, their slot
    is left roomless (mirrors GAS's "D?") and Phase 4 emits a warning
    `ValidationIssue`. This is final for the evictee: the slot is
    `PRE_ASSIGNED` or `ADMIN_TIME`, which Phase 7-9A Pass 3 filters out
    (`template_type != REQUIRES_ROOM`), and Phase 12's unresolved-room
    check only inspects `REQUIRES_ROOM` slots — without this warning it
    would go completely unflagged.
12. **Fallback sweep** (no preferred D room configured, or the preferred
    room's occupant is protected):
    a. First *free* D room, searched by room **code descending** (D8 down
       to D1) — not by id; ids are not guaranteed to follow code order.
       Caveat: this is a string sort, so a two-digit code like `D10`
       would sort below `D2`. The same latent issue already exists
       everywhere else the engine sorts by code, so it is consistency
       rather than a new bug — but do not seed `D10`+ in tests and expect
       numeric order.
    b. If no D room is free: among D-room occupants who are **Salaried**,
       not on leave, and not holding a role, evict the one with the lowest
       weighted ROOM_MOVE score (tie: doctor code). The duty doctor takes
       their room; the evictee is relocated via the shared Salaried search
       and their ROOM_MOVE counter is incremented, under Decision 10's
       unconditional rule.
    c. **Trainees are never evicted by the sweep** — with D-only
       relocation (Decision 8), evicting a Trainee only helps when another
       D room is free, and step (a) already covered that. Consequence,
       accepted deliberately: if every D room is held by Partners, AHPs,
       role-holders, and Trainees, the sweep fails even though Trainees
       are expendable in the preferred-room path.
    d. The duty doctor themselves can never be a sweep victim: if they
       held a D room, Decision 1's self-check would already have returned.
13. **Total failure — the duty doctor cannot get a D room at all.** The
    role is still applied and Phase 4 assigns no new room, with a warning
    `ValidationIssue`. Word the warning "could not secure a D room", not
    "roomless".

    **Any room the duty doctor already holds must survive this.** Phase 4
    must never call `grid.free_room` on the duty doctor's own slot — every
    placement goes through `grid.assign_room`, which re-points indexes
    atomically, so a failed search leaves the pre-existing assignment
    exactly as it was. Concretely, three outcomes, all of which need to be
    understood before implementing:
    - **a. `REQUIRES_ROOM` slot, no room held.** Not final. Phase 7-9A
      Pass 3 does not check `slot.role`, so the doctor will usually still
      receive a non-D room via Pass 3's preference-list / SR>D>C>W
      fallback. Do not "fix" Pass 3 to skip role-holders — this rescue
      path is intended.
    - **b. `PRE_ASSIGNED`/`ADMIN_TIME` non-D slot (Decision 2's path,
      search failed).** The doctor keeps their original non-D room and
      does duty from it. Pass 3 filters this slot out on `template_type`,
      so there is no rescue and none is needed. This is only correct
      because of the never-free rule above.
    - **c. WFH-origin slot (Decision 3's path, search failed).** Final and
      genuinely roomless: `template_type` is still `WFH`, so Pass 3 skips
      it and Phase 12's unresolved-room check cannot see it either (per
      Decision 3). The Phase 4 warning is the only signal that exists for
      this case. Do not suppress or downgrade it.
14. **Shared helper.** Extract the single-session relocation search into a
    new module `backend/app/engine/room_relocation.py` (`grid_utils.py` is
    about grid reconstruction from persisted rotas, not a natural home).
    Verified against the codebase: `_best_available_room`'s **only** call
    site is Pass 2, called with `periods=(period,)`; Pass 1 full-day
    relocation uses the separate `_pass1_receiving_room` (fixed C/W/SR
    pool, no preference list, deliberately). There is no full-day call
    site to preserve — the whole function moves, and the `periods` tuple
    parameter is simplified to a single `period`.

## Documentation reminders (user-maintained, end of ticket)

The incorrect "room resolution for the duty doctor happens later in
Phases 7-9A" claim appears in three places: the `phase4.py` module
docstring (fixed in Task 2), the Phase 4 section of phase-pipeline.md, and
the Phase 4 bullet in architecture.md. The latter two also need the new
behaviour summarised (D-room forcing, evictions, ROOM_MOVE, WFH override,
and the three total-failure outcomes of Decision 13).

Also worth a line in phase-pipeline.md: Phase 4 is now a counter-mutating
phase, so the list of phases threaded with `CounterState` (currently 5,
7-9A, 9C) gains 4.

---

## Task 1: Extract shared single-session relocation helper

**A. State of the world:** `phase7_9a.py`'s `_best_available_room`
implements the preferred-rooms-excluding-D then C/W/SR-fallback search.
Its only call site is Pass 2 (`periods=(period,)`); Pass 1 uses the
separate `_pass1_receiving_room` and is untouched by this ticket. Nothing
has been built for this ticket yet.

**B. Files:**
- New: `backend/app/engine/room_relocation.py` — the extracted search as a
  public function.
- Modified: `backend/app/engine/phases/phase7_9a.py` — Pass 2 calls the
  shared helper; `_best_available_room` is deleted.
- Unchanged but must pass: `backend/tests/test_engine/test_phase7_9a.py` —
  this task is a pure refactor with no behaviour change.

**C. Instructions:** Move `_best_available_room` into the new module as
`find_relocation_room(context, grid, doctor_id, gen_week, day, period)`,
simplifying the `periods` tuple to a single period (no full-day caller
exists). Preserve exact behaviour: preferred rooms first with D-type
skipped, then free C/W/SR rooms by id order. Update Pass 2's call site.
Keep the module free of any Phase 4 knowledge — Task 2 adds its Trainee
variant alongside, not inside, this function.

## Task 2: Phase 4 duty room assignment

**A. State of the world:** Task 1's shared helper exists. `phase4.py`
currently only applies `role` and never touches rooms, counters, or
`is_wfh`; its docstring incorrectly claims room resolution happens later
in Phases 7-9A. `run_phase4(context, grid, log)` has no `CounterState`
parameter.

**B. Files:**
- Modified: `backend/app/engine/phases/phase4.py` — full room-resolution
  logic per Design Decisions 1-13; corrected module docstring; new
  `CounterState` parameter.
- Modified: `backend/app/engine/generate.py` — pass `counters` to
  `run_phase4` (line 66 of the current file).
- Modified: `backend/app/engine/room_relocation.py` — add the
  Trainee D-only relocation search (Decision 8) as a second public
  function, e.g. `find_trainee_d_room(context, grid, doctor_id, gen_week,
  day, period)`: preferred D-type rooms in preference order, then free D
  rooms by code ascending.
- Possibly modified: `backend/app/engine/datatypes.py` — only if
  `ValidationIssue`/`DecisionLogEntry` need new fields (unlikely; both are
  already generic enough).

**C. Instructions:** Implement, in order per duty row (the existing sorted
iteration is kept — primary before secondary within a session):

1. Existing no-slot and role-conflict warnings — both skip room logic
   entirely, unchanged.
2. Apply the role (unchanged).
3. WFH override (Decision 3): clear `is_wfh`, log it.
4. Self-check (Decision 1): already in a D room, stop here.
5. Preferred-room placement (Decisions 4-8, 10): protected occupant falls
   through to the sweep; expendable occupant is evicted and relocated by
   type.
6. Fallback sweep (Decision 12): free D room by code descending, then
   lowest-weighted-score Salaried eviction.
7. Total failure (Decision 13): warn, leave any existing room intact.

Hard implementation rules:
- Never call `grid.free_room` on the duty doctor's own slot. Every
  placement is `grid.assign_room`.
- `grid.free_room` on an evictee is called only in the
  relocation-failed branch of Decision 10.
- Increment ROOM_MOVE on every eviction, both branches (Decision 9).

Add `DecisionLog` entries for every room outcome, matching the message
style of `phase4.py` and `phase7_9a.py`: self-already-placed,
WFH-abandoned, preferred-room assign, preferred-room assign that also
moved the doctor out of their own non-D room, displacement + relocation,
displacement + relocation-failed, sweep free assign, sweep eviction
assign, total failure. Counter-based sweep selections should state the
deciding stage inline ("lowest weighted room-move score, tie broken on
doctor code"), per the DecisionLog convention in architecture.md.

New warning checks, both `severity="warning"`:
- evictee could not be relocated (Decision 11);
- duty doctor could not secure a D room (Decision 13), worded "could not
  secure a D room".

## Task 3: Tests

**A. State of the world:** Tasks 1 and 2 are implemented.
`backend/tests/test_engine/factories.py` exists and already provides
`make_room`, `make_doctor`, `make_duty`, `make_preferred_room`,
`make_master_session`, `make_system_counter`. Existing `test_phase4.py`
has eight tests, all assuming no room behaviour;
`test_duty_does_not_touch_existing_room` (doctor pre-assigned to D1, room
unchanged) happens to still pass under the new self-check but must be
renamed and repurposed as the self-check test rather than left as an
accidental pass. Every existing test calling `run_phase4` needs the new
`counters` argument.

**B. Files:**
- Modified: `backend/tests/test_engine/test_phase4.py`.
- Modified only if Task 1 accidentally changed behaviour:
  `backend/tests/test_engine/test_phase7_9a.py`.

**C. Instructions:** Cover at minimum:

Placement paths
- Self-check: already in a D room, room untouched (repurposed existing
  test).
- Duty doctor moved out of their own pre-assigned non-D room into a D
  room; old room reads as free afterwards.
- WFH slot: `is_wfh` cleared, room assigned, log entry present.
- Preferred D room free.
- No preferred D room configured — sweep takes the highest-coded free D
  room (seed D8 and D1 with ids in the opposite order, proving
  code-descending rather than id order).

Eviction paths
- Preferred room occupied by Partner, and by AHP — protected, falls to
  the sweep.
- Preferred room occupied by a same-session duty holder — protected by
  the role guard.
- Preferred room occupied by a Salaried doctor — evicted, relocated via
  the shared search, ROOM_MOVE incremented.
- Preferred room occupied by a Salaried doctor on an `ADMIN_TIME` slot —
  still evicted (Decision 7), pinning the by-doctor_type rule.
- Preferred room occupied by a Trainee — evicted, relocated to a free D
  room only; and the variant where no D room is free, leaving the Trainee
  roomless with a warning.
- Salaried eviction where relocation fails: evictee roomless, warning
  raised, **and ROOM_MOVE still incremented** (Decision 9) — assert the
  counter explicitly, this is the easiest rule to lose.
- Sweep with no free D room: evicts the Salaried occupant with the lowest
  weighted ROOM_MOVE score. Seed `make_system_counter` values and
  differing `sessions_per_week` to prove the weighting, plus a pair with
  identical scores to prove the doctor-code tie-break.

Total-failure paths (Decision 13, one test each)
- a. `REQUIRES_ROOM` duty doctor, every D room held by
  Partner/AHP/Trainee: warning raised, role applied, no room; then a
  pipeline-level or targeted-grid check that Phase 7-9A Pass 3
  subsequently rooms them in a non-D room.
- b. Duty doctor pre-assigned to a non-D room, no D room obtainable:
  warning raised **and the original non-D room is still theirs** — this
  is the regression test for the never-free rule.
- c. WFH-origin duty slot, no D room obtainable: warning raised,
  `is_wfh` cleared, no room, and a Phase 12 run confirms neither
  `unresolved_room` nor `role_on_incompatible_slot` fires — documenting
  that the Phase 4 warning is the only signal for this case.

Assert decision-log entries and counter increments throughout.
