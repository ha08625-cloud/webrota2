# Plan — Move Phase 9C ahead of Phase 7–9A, and make SR the supervision room

Reviewed plan (workflow step 2). The provisional plan has been corrected and
expanded following review against the code; the three open points it flagged
have been decided (see "Review decisions"). Ready to be broken into tasks.

## Scope

Three related changes to the clinical generation engine:

1. **Reorder the pipeline** so trainee supervision is assigned *before* the
   remaining rooms are allocated:
   `0 → 2 → 4 → 5 → 9C → 7–9A → 9B → 12`
   (today: `0 → 2 → 4 → 5 → 7–9A → 9B → 9C → 12`).
2. **Seat the chosen supervisor in the SR room**, replacing the current
   post-selection forced swap.
3. **Reserve SR for supervision in any session that has supervisable
   trainees**, so that (2) always succeeds. Outside those sessions SR stays
   in the ordinary room pools.

Also in scope, as a consequence of (3): SR becomes unselectable as a clinic
room (`ClinicTypeRoomEligibility`), backend and frontend.

Out of scope: the supervision selection rule itself (weighted `SUPERVISION`
counter, preference multipliers, alphabetical tiebreak) is unchanged; the
trainee-counting rule is unchanged; no data-model change other than
validation on clinic room eligibility; `superviseeCount.ts` mirrors trainee
counting, which is untouched.

## Why

- **The SR room is currently wasted in the common case.** `_swap_into_sr()`
  only ever acts on an SR room that is *occupied by someone else*
  (`if occupant_id is None: continue`). Pass 3 of 7–9A fills rooms in type
  order D > C > W > SR, so SR is typically the last room filled and is often
  still empty when 9C runs — in which case the supervisor stays in a D room
  and SR sits unused.
- **9C can currently undo Phase 9B's work.** 9B exists to eliminate AM/PM
  room swaps between Partner/Salaried doctors. 9C runs *after* it and moves a
  doctor's room for a single period, which can reintroduce exactly the mid-day
  swap 9B just removed. Running 9C before 9B removes that exposure.
  (Note: 9B will *not* be repairing supervision moves — D4 guards it off. The
  benefit of the reorder here is that 9C can no longer break 9B's guarantee,
  not that 9B now cleans up after 9C.)
- **Booking the room up front beats swapping after the fact.** Before 7–9A,
  SR is free in every session the reservation covers, so the supervisor
  simply takes it — no displaced doctor, no cascading room churn.
- **The reorder is what makes the reservation cheap.** Of the seven code
  paths that can put a non-supervisor in SR, four live in Phases 7–9A, which
  now run *after* 9C: once the supervisor holds SR, `grid.is_room_free()`
  excludes it for free. Only Phases 4 and 5 need an explicit reservation
  check. See D6.

## Review decisions

Three points the provisional plan flagged for review, now decided:

- **Mid-day room change for the supervisor — accepted, not mitigated.** A
  supervisor sits in SR for the supervising period and takes an ordinary room
  from Pass 3 for the other period, so a doctor supervising only one session
  of a day now changes room at lunchtime where today they usually would not.
  This is a genuine regression in mid-day stability and is accepted: SR is
  the supervision room, and the supervisor sits there while supervising. It
  must be stated explicitly in `phase_pipeline.md` (Task 4), because 9B is
  guarded off from repairing it (D4) and a reader will otherwise expect 9B to
  have caught it.
- **`is_selectable_supervisor` has no room criterion at all.** Not "no room,
  or a D/SR room" — none. Safe because D3 is overturned (see below): every
  selected supervisor is moved into SR regardless of what they were holding.
- **The supervisor always ends up in SR.** Stronger than the provisional
  plan's R1 mitigation (restricting Pass 3's walk to D/SR). The reservation in
  D6 guarantees SR is free at 9C's position, so 9C's booking cannot fail, and
  Pass 3 never sees a roomless supervisor. Pass 3 therefore needs no change —
  R1's mitigation is dropped as unnecessary rather than rejected.

## Design decisions

**D1 — Eligibility loses its room criterion, and splits in two.**
An eligible supervisor is `role is None`, and a role-free Partner/Salaried
doctor gets a room *only* from Pass 3 of 7–9A (verified: Phases 4 and 5 only
ever *relocate* doctors who already hold a room, and the only way a role-free
Partner/Salaried doctor holds one at 9C's new position is a `PRE_ASSIGNED`
template row). At the new position nearly every pool candidate is roomless, so
the existing D-or-SR test would empty the pool in nearly every session. The
predicate splits:

- `is_selectable_supervisor(context, grid, slot)` — used by 9C at selection
  time. Partner/Salaried; `role is None`; not on leave; not WFH;
  `template_type` not in (`NO_SURGERY`, `ADMIN_TIME`). **No room test.**
- `is_eligible_supervisor(context, grid, slot)` — unchanged, keeps its name
  and its D-or-SR room test. Used by Phase 12 Checks 4a/4b, which run at the
  end of the pipeline when rooms *are* final.

`is_eligible_supervisor` is defined as `is_selectable_supervisor(...) and
<room is D or SR>`, so the two cannot drift; the module docstring's
"do not inline these predicates" rule still holds. `is_eligible_supervisor`
has exactly two call sites, both in `phase12.py` (verified) — the edit
endpoints re-run Phase 12 rather than calling it directly — so the split is
contained.

**D2 — 9C books the SR room, and only the SR room.**
After selection, 9C assigns the chosen supervisor the first (by room code)
free SR room. Under D6 one is always free in a session with supervisable
trainees, so this is unconditional in practice; the code still handles "no
free SR room" by leaving the room alone and letting Pass 3 room the doctor
normally, and Phase 12 will then flag it. `_swap_into_sr()` and its
forced-swap branch are **deleted** — at the new pipeline position there is no
SR occupant to swap with, and displacing one would recreate the churn this
change exists to remove.

**D3 — A supervisor already holding a room is moved into SR (overturns the
provisional plan).** The provisional plan had the supervisor keep a
`PRE_ASSIGNED` room. That is incompatible with "the supervisor always ends up
in SR", and it leaves a live defect: a role-free Partner/Salaried doctor
pre-assigned to a C or W room is selectable under D1, would keep that room,
and would then trip Phase 12's `supervision_on_incompatible_slot` on every
run. 9C therefore frees whatever room the chosen supervisor holds and assigns
SR. This *is* an override of a template pin, deliberately, and it is the one
place in the pipeline where 9C overrides one — call it out in the log entry's
rationale and in `phase_pipeline.md`.

**D4 — Later phases must not move a supervisor.**
Once `is_supervising` is set, the slot's room is fixed for the rest of the run:

- 7–9A Pass 1 (`_is_displaceable_full_day`, which already rejects
  `role is not None`) and Pass 2 (`_is_displaceable_single`): also reject a
  slot with `is_supervising=True`. For Pass 1 this means rejecting the doctor
  if *either* the AM or the PM slot is supervising, since Pass 1 moves both.
  These guards are **not** belt-and-braces — Passes 1 and 2 displace D-room
  occupants, and under D3 a supervisor is in SR, so in the ordinary case they
  cannot fire; but they are the backstop if the SR reservation ever fails and
  Pass 3 seats a supervisor in a D room.
- 9B: 9B only ever rewrites **PM** room assignments (`Period.PM` is hardcoded
  in both `assign_room` calls; AM is never touched). The guard is therefore
  narrower than the provisional plan proposed: skip a swap pair where either
  doctor's **PM** slot has `is_supervising=True`. Guarding on AM as well would
  needlessly abandon swap resolutions that are harmless — DEFAULT sets PM to
  the AM room, which for an AM supervisor means moving them *into* SR for PM,
  not out of it.

**D5 — Phase 12's dependency line changes, not its checks.**
Check 4 still needs 9C to have run; it just no longer sits immediately after
it. No check logic changes.

**D6 — SR is reserved, per session, only where supervision is needed.**
For each `(week, day, period)` with `count_supervisable_trainees(...) > 0`,
one SR room is reserved and unavailable to any other doctor. Elsewhere SR
stays in the ordinary pools, so it is not left standing empty in sessions with
no trainees.

Implementation: a module-level helper in `phase9c.py`, e.g.
`reserved_sr_room_ids(context, grid) -> dict[tuple[int, Day, Period], int]`,
computed once at the start of a run and consulted by the phases that place
doctors *before* 9C. This keeps the rule in the same module as the predicates
it belongs with, matching the existing "shared predicate" convention.

The seven paths that can put a doctor in SR, and what each needs:

| # | Path | Runs | Change |
|---|------|------|--------|
| 1 | Phase 2 `PRE_ASSIGNED` template row naming SR | before 9C | Phase 0 warning (see D7) |
| 2 | Phase 4 duty-evictee relocation (`find_relocation_room`) | before 9C | reservation check |
| 3 | Phase 5 clinic room resolution (`clinic.eligible_room_ids`) | before 9C | closed by removing SR from clinic eligibility (D8) |
| 4 | Phase 5 displaced-occupant relocation (`_best_free_preferred_room`) | before 9C | reservation check |
| 5 | Pass 1 `_pass1_receiving_room` (fixed C/W/SR pool) | **after 9C** | none — SR is occupied |
| 6 | Pass 2 (`find_relocation_room`) | **after 9C** | none — SR is occupied |
| 7 | Pass 3 preference walk and D>C>W>SR fallback | **after 9C** | none — SR is occupied |

Because `find_relocation_room` is shared by paths 2 and 6, put the check
inside it once; it is a no-op for path 6.

Doctor room *preferences* need no change. A doctor who prefers SR still gets
it in any session the reservation does not cover.

**D7 — A `PRE_ASSIGNED` SR template row wins, with a Phase 0 warning.**
Phase 2 claims the room before any reservation can apply. Rather than teach
Phase 2 about supervision, add a Phase 0 warning (not an error) when a
template row pre-assigns an SR room, so the admin sees the conflict. 9C then
finds no free SR, leaves the supervisor roomless for Pass 3, and Phase 12
flags the result. This is the one hole in "the supervisor always ends up in
SR" and it is a data problem with a visible warning, not a silent failure.

**D8 — SR is not a selectable clinic room.**
Reject `ClinicTypeRoomEligibility` rows naming an SR room, in the POST/PUT
clinic-type schema validation, and filter SR out of the room picker in
`ClinicTypesPage.tsx` / `clinicTypeSchema.ts`. The system is not live, so no
data migration is needed; a seed or fixture naming SR for a clinic must be
updated. This closes path 3 without an engine change.

## Risks and open points

**R1 — Rota output will change for existing scenarios.** Supervisors will sit
in SR rather than D, and the doctor who previously got SR from Pass 3's
fallback will get something else. Several engine tests assert on concrete room
assignments and will need updating, not just the 9C ones.

**R2 — `_ineligible_lines()` and both rationale builders** describe the pool
in room terms ("in a D or SR room", "in {room} ({type}), not a D or SR room",
and the `supervision_unassignable` rationale's `rat.decided(...)` text). These
are user-facing generation-log text and must be rewritten to match the new
rule, or the log will explain a decision that is no longer being made. Note
`_ineligible_lines` deliberately restates the predicate rather than calling
it, and its docstring says the pairing is asserted by the tests — the
room-based branches at the end of it are removed, not reworded.

**R3 — SR is unavailable to the wider pool in supervised sessions.** In a
session with trainees, one fewer room is available to everyone else, which can
turn a "no free room anywhere" warning from Pass 3 into a real occurrence in a
tight week. Accepted: seating the supervisor is the higher priority, and the
warning already exists for it.

## Task 1: Engine — predicate split, 9C room booking, SR reservation

**State of the world:** Nothing done yet. This is the core change.

**Files:**
- `backend/app/engine/phases/phase9c.py` — split the predicate (D1), replace
  `_swap_into_sr()` with the SR booking (D2, D3), add
  `reserved_sr_room_ids()` (D6), rewrite the pool / ineligibility rationale
  text (R2), rewrite the module docstring (decisions 1, 2, 3, 5 and 6 in it
  all change).
- `backend/app/engine/room_relocation.py` — `find_relocation_room` skips a
  reserved SR room (D6, paths 2 and 6).
- `backend/app/engine/phases/phase5.py` — `_best_free_preferred_room` skips a
  reserved SR room (D6, path 4).
- `backend/app/engine/phases/phase0.py` — warn on a `PRE_ASSIGNED` SR
  template row (D7).
- `backend/app/engine/phases/phase12.py` — no logic change; update the
  module docstring's account of which predicate it uses and why.
- `backend/app/engine/generate.py` — move `run_phase9c(...)` above
  `run_phase7_to_9a(...)`; compute the SR reservation before Phase 4 and
  thread it to the phases that need it; update the module docstring's phase
  order (line 3 states the order explicitly).

**Instructions:** Keep `is_eligible_supervisor`'s name and signature so
`phase12.py`'s import is untouched; define it in terms of the new
`is_selectable_supervisor`. 9C's pool, warning, counter increment and log
entry are otherwise unchanged. The new booking step logs its own entry
(replacing `swap_supervisor_into_sr`) and, like the swap it replaces, touches
neither `is_supervising` nor any counter — **including `ROOM_MOVE`**, even
when D3 moves a doctor out of a pre-assigned room.

## Task 2: Engine — supervisor-immobility guards

**State of the world:** Task 1 done: 9C runs before 7–9A and seats the
supervisor in SR.

**Files:**
- `backend/app/engine/phases/phase7_9a.py` — `_is_displaceable_full_day`
  (reject if AM *or* PM is supervising) and `_is_displaceable_single` (D4).
  Pass 3 is **not** changed.
- `backend/app/engine/phases/phase9b.py` — skip a pair where either doctor's
  PM slot is supervising (D4).

## Task 3: Clinic room eligibility — SR excluded

**State of the world:** Tasks 1–2 done. This closes D6's path 3.

**Files:**
- `backend/app/api/schemas/clinic_type.py` — reject SR rooms in
  `room_eligibilities` validation.
- `backend/app/api/routers/clinic_types.py` — surface the validation error.
- `frontend/src/lib/clinicTypeSchema.ts`,
  `frontend/src/routes/ClinicTypesPage.tsx` — filter SR from the room picker;
  `mapValidationErrors.ts` if the new error needs a field mapping.
- Seed / fixture data naming an SR room for a clinic type.

## Task 4: Tests

**State of the world:** Tasks 1–3 done; the engine behaves as intended.

**Files:** `backend/tests/test_engine/test_phase9c.py` (516 lines — the
room-eligibility and SR-swap cases are the bulk of the rework; the four tests
named `*_sr_*` at lines 52–170 are all about the deleted swap and need
rewriting rather than adjusting), `test_phase12.py`, `test_phase7_9a.py`,
`test_phase9b.py`, `test_phase4.py` and `test_phase5.py` (the reservation
check), `test_generate.py`, plus the clinic-type API and frontend tests from
Task 3.

**New coverage to add:** supervisor seated in SR; supervisor with a
`PRE_ASSIGNED` non-SR room is moved into SR and no `ROOM_MOVE` counter moves;
SR is not handed to a Phase 4 evictee or a Phase 5 displaced occupant in a
session with trainees; SR *is* still available in a session without trainees;
Pass 1/2 will not displace a supervisor; 9B will not rewrite a PM-supervising
doctor's room but still resolves a pair where only the AM slot supervises;
Phase 12 still flags a supervisor who ended up in C/W; Phase 0 warns on a
`PRE_ASSIGNED` SR row; SR rejected as a clinic room.

## Task 5: Review and documentation

**State of the world:** Tasks 1–4 complete and the feature is live. This step
is review and documentation only.

**Files:**
- `documentation/phase_pipeline.md` — execution-order block (lines 10–22); the
  Phase 9C section (steps 1–5, the eligibility paragraph, the **Writes** line
  at 179 and the **Depends on** line at 180, and divergence 2, which describes
  the now-removed SR fast path); Phase 12's **Depends on** line (231); Phase 4
  and Phase 5's room-search descriptions (the SR reservation); the note at
  line 36 about Phase 9C's three divergences. Add the accepted mid-day room
  change for supervisors explicitly.
- `documentation/architecture-clinical.md` — the phases directory line (~22),
  the numbering note (~26), the Phase 4 note (~48, which cites Phase 9C's
  D-room pool as the reason evicted Trainees/Locums stay in D rooms — that
  rationale changes once eligibility has no room criterion; the D-room-only
  relocation itself is still wanted, for the "duty doctors should not claim
  therapeutically-isolated D rooms" half of the same sentence), the Phase 5
  note (~50) and the Phase 9C summary (~52).
- Delete this plan file.
