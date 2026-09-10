# Plan — Move Phase 9C ahead of Phase 7–9A, and seat the supervisor in SR

Provisional plan (workflow step 1). Not yet reviewed or expanded into an
implementation plan.

## Scope

Two related changes to the clinical generation engine:

1. **Reorder the pipeline** so trainee supervision is assigned *before* the
   remaining rooms are allocated:
   `0 → 2 → 4 → 5 → 9C → 7–9A → 9B → 12`
   (today: `0 → 2 → 4 → 5 → 7–9A → 9B → 9C → 12`).
2. **Seat the chosen supervisor in the SR room when it is free**, replacing
   the current post-selection forced swap.

Out of scope: the supervision selection rule itself (weighted `SUPERVISION`
counter, preference multipliers, alphabetical tiebreak) is unchanged; the
trainee-counting rule is unchanged; no data-model or API change; no frontend
change (`superviseeCount.ts` mirrors trainee counting, which is untouched).

## Why

- **The SR room is currently wasted in the common case.** `_swap_into_sr()`
  only ever acts on an SR room that is *occupied by someone else*
  (`if occupant_id is None: continue`). Pass 3 of 7–9A fills rooms in type
  order D > C > W > SR, so SR is typically the last room filled and is often
  still empty when 9C runs — in which case the supervisor stays in a D room
  and SR sits unused. Seating the supervisor there is the obvious fix.
- **9C can currently undo Phase 9B's work.** 9B exists to eliminate AM/PM
  room swaps between Partner/Salaried doctors. 9C runs *after* it and moves a
  doctor's room for a single period, which can reintroduce exactly the mid-day
  swap 9B just removed. Running 9C before 7–9A puts 9B back downstream, where
  it can clean up after the supervision move.
- **Booking the room up front beats swapping after the fact.** Before 7–9A,
  SR is almost always free, so the supervisor can simply take it — no
  displaced doctor, no cascading room churn.

## Design decisions

**D1 — Eligibility loses its room criterion, and splits in two.**
An eligible supervisor is `role is None`, and a role-free Partner/Salaried
doctor gets a room *only* from Pass 3 of 7–9A. So at the new position every
pool candidate is roomless, and the existing D-or-SR test would empty the pool
in nearly every session. The predicate therefore splits:

- `is_selectable_supervisor(context, grid, slot)` — used by 9C at selection
  time. Partner/Salaried; `role is None`; not on leave; not WFH;
  `template_type` not in (`NO_SURGERY`, `ADMIN_TIME`). **No room test.**
- `is_eligible_supervisor(context, grid, slot)` — unchanged, keeps its name
  and its D-or-SR room test. Used by Phase 12 Checks 4a/4b, which run at the
  end of the pipeline when rooms *are* final.

`is_eligible_supervisor` is defined as `is_selectable_supervisor(...) and
<room is D or SR>`, so the two cannot drift; the module docstring's
"do not inline these predicates" rule still holds.

The consequence is deliberate and worth stating: a supervisor who ends up
off-site (a C or W room) is no longer prevented at selection time; it is
*reported* by Phase 12's `supervision_on_incompatible_slot`. See R1 below.

**D2 — 9C books the SR room, and only the SR room.**
After selection, if the chosen supervisor has no room yet and an SR room is
free, 9C assigns it. Otherwise 9C leaves the room alone and Pass 3 rooms them
normally. `_swap_into_sr()` and its forced-swap branch are **deleted** — at
the new pipeline position there is rarely an SR occupant to swap with, and
displacing one would recreate the churn this change exists to remove.

Chosen over "reserve a D room when SR is taken" because SR is never contested
by Passes 1/2 (which raid D rooms for Trainee/AHP demand), so an SR-seated
supervisor needs no protection from them at all.

**D3 — A supervisor already holding a room keeps it.**
9C only books SR for a supervisor whose `assigned_room_id is None`. The only
way a role-free candidate holds a room at that point is a `PRE_ASSIGNED`
template row pinning them there; overriding a template pin is out of scope.

**D4 — Later phases must not move a supervisor.**
Once `is_supervising` is set, the slot's room is fixed for the rest of the run:

- 7–9A Pass 1 (`_find_full_day_displacement`, the `role is not None` guard at
  ~line 443) and Pass 2 (~line 704): also skip a slot with
  `is_supervising=True`.
- 9B: skip a swap pair where either doctor is supervising in either period of
  that day — 9B rewrites the PM room to match AM, which would pull an
  SR-seated supervisor out of SR.

Under D2 the Pass 1/2 guard is belt-and-braces (a supervisor holds SR or no
room, and Passes 1/2 only displace D-room holders), but it is cheap and keeps
the invariant true if the room policy is ever widened. The 9B guard is a live
exposure, not a theoretical one.

**D5 — Phase 12's dependency line changes, not its checks.**
Check 4 still needs 9C to have run; it just no longer sits immediately after
it. No check logic changes.

## Risks and open points

**R1 — Pass 3 can still seat a supervisor off-site.** Pass 3 walks the
doctor's *preference list first*, then falls back D > C > W > SR. A supervisor
who missed SR (already taken) and whose top preference is a C or W room will
be seated off-site and then flagged by Phase 12 — a warning where today the
room test would have quietly picked someone else.

Proposed mitigation, **flagged for review rather than assumed**: in Pass 3,
for a slot with `is_supervising=True`, restrict both the preference walk and
the fallback to D and SR rooms. Small and local, but it is a behaviour change
to a phase this ticket otherwise only guards, so it should be an explicit
decision rather than a silent one.

**R2 — Rota output will change for existing scenarios.** Supervisors will
generally sit in SR rather than D, and the doctor who previously got SR from
Pass 3's fallback will get something else. Several engine tests assert on
concrete room assignments and will need updating, not just the 9C ones.

**R3 — `_ineligible_lines()` and both rationale builders** describe the pool
in room terms ("in a D or SR room", "in {room} ({type}), not a D or SR room").
These are user-facing generation-log text and must be rewritten to match the
new rule, or the log will explain a decision that is no longer being made.

## Task 1: Engine — predicate split and 9C room booking

**State of the world:** Nothing done yet. This is the core change.

**Files:**
- `backend/app/engine/phases/phase9c.py` — split the predicate (D1), replace
  `_swap_into_sr()` with the free-SR booking (D2, D3), rewrite the pool /
  ineligibility rationale text (R3).
- `backend/app/engine/phases/phase12.py` — no logic change; update the
  module docstring's account of which predicate it uses and why.
- `backend/app/engine/generate.py` — move `run_phase9c(...)` above
  `run_phase7_to_9a(...)`; update the module docstring's phase order.

**Instructions:** Keep `is_eligible_supervisor`'s name and signature so
`phase12.py`'s import is untouched; define it in terms of the new
`is_selectable_supervisor`. 9C's pool, warning, counter increment and log
entry are otherwise unchanged. The new booking step logs its own entry
(replacing `swap_supervisor_into_sr`) and, like the swap it replaces, touches
neither `is_supervising` nor any counter — including `ROOM_MOVE`.

## Task 2: Engine — supervisor-immobility guards

**State of the world:** Task 1 done: 9C runs before 7–9A and may seat a
supervisor in SR.

**Files:**
- `backend/app/engine/phases/phase7_9a.py` — Pass 1 and Pass 2 victim guards
  (D4); Pass 3 room restriction *if* R1's mitigation is accepted at review.
- `backend/app/engine/phases/phase9b.py` — skip pairs involving a supervising
  doctor (D4).

## Task 3: Tests

**State of the world:** Tasks 1–2 done; the engine behaves as intended.

**Files:** `backend/tests/test_engine/test_phase9c.py` (516 lines — the
room-eligibility and SR-swap cases are the bulk of the rework),
`test_phase12.py`, `test_phase7_9a.py`, `test_phase9b.py`, `test_generate.py`.

**New coverage to add:** supervisor seated in a free SR; SR already occupied →
supervisor left for Pass 3, no swap; supervisor with a `PRE_ASSIGNED` room
keeps it; Pass 1/2 will not displace a supervisor; 9B will not move a
supervisor's PM room; Phase 12 still flags a supervisor who ended up in C/W.

## Task 4: Review and documentation

**State of the world:** Tasks 1–3 complete and the feature is live. This step
is review and documentation only.

**Files:**
- `documentation/phase_pipeline.md` — execution-order block; the Phase 9C
  section (steps 1–5, the eligibility paragraph, the "Depends on" line, and
  divergence 2, which describes the now-removed SR fast path); Phase 12's
  "Depends on" line.
- `documentation/architecture-clinical.md` — the phases directory line (~22),
  the numbering note (~26), the Phase 4 note (~48, which cites Phase 9C's
  D-room pool as the reason evicted trainees stay in D rooms — that rationale
  changes once eligibility has no room criterion), and the Phase 9C summary
  (~52).
- Delete this plan file.
