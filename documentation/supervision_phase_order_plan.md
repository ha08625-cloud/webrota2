# Plan — Move Phase 9C ahead of Phase 7–9A, and make SR the supervision room

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
  Our doctors don't like supervising for the entire day, so this is the preference
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

## Review corrections (recorded during the Task 2–5 expansion)

Four points in the original task list turned out to be wrong or incomplete
once the code was read. The tasks below reflect the corrected version; these
notes exist so the change is visible rather than silent.

- **`mapValidationErrors.ts` needs no change.** Task 3 listed it as a
  maybe. It isn't: `ClinicTypeFormDialog.handleSubmit`'s `onError` already
  renders any string `detail` (400/409) as the top-of-form `formError`, and
  the SR check that needs a DB lookup is a 400 with a string detail. The
  Pydantic half (a literal `room_type: "SR"`) does produce a 422, but its
  `loc` is nested (`body.room_eligibilities.N.room_type`), which
  `mapValidationErrors` deliberately routes to `formErrors` — that is the
  intended behaviour, not a gap. See Task 3.
- **There is no seed or fixture naming SR for a clinic type.** Task 3's
  last bullet has nothing to act on: there is no clinic-type seed module at
  all (`backend/seed/` is rooms, doctors, master rota, system counters,
  users), and the API fixtures use C1/D1. What Task 3 *does* need is the
  opposite — the API conftest has no SR room, so one has to be added to test
  the rejection.
- **Task 3 cannot be done in the Pydantic schema alone.** `RoomEligIn` sees
  a bare `room_id: int` and has no DB session, so it cannot know that room
  is an SR room. Only the `room_type: SR` half is a schema validator; the
  `room_id` half is a router check. The original task's split
  ("schema: reject; router: surface the error") implied a validator that
  cannot exist.
- **D4's Pass 1/2 guards fire in a narrower case than D4 states.** D4 says
  they are the backstop "if the SR reservation ever fails and Pass 3 seats a
  supervisor in a D room". Pass 3 cannot be that case: Pass 3 runs *after*
  Passes 1 and 2, so nothing Pass 3 places is ever visible to them. The one
  reachable case is a supervisor holding a **PRE_ASSIGNED D room** whose SR
  booking failed because a PRE_ASSIGNED template row already holds the only
  SR room (D7's hole). The guards are still worth having — that case is
  real, and the cost is two lines — but the task records the true reason.

One thing to decide before Task 3 (see Task 3, step 5): **existing
`ClinicTypeRoomEligibility` rows naming an SR room are not touched by D8.**
D8 stops new ones being created; it does nothing about rows already in a dev
or Railway database. The engine has no SR filter of its own, so such a row
still lets Phase 5 hand SR to a clinic, and 9C then finds no free SR and
leaves the supervisor for Pass 3 — a silent degradation with no warning
anywhere. "The system is not live" covers the *data*, not the *code path*.

---

## Task 1: Engine — predicate split, 9C room booking, SR reservation

**Status: COMPLETE** — commit `c704bee`, "Run Phase 9C before the room
passes and seat supervisors in SR".

Delivered as specified: the predicate split (`is_selectable_supervisor` /
`is_eligible_supervisor`), `_book_sr_room` replacing `_swap_into_sr`,
`reserved_sr_room_ids` threaded from `generate()` into Phases 4 and 5, the
Phase 0 PRE_ASSIGNED-SR warning, the pipeline reorder, and the rewritten 9C
decision-log prose.

Two things to know before starting Task 2:

- The commit deliberately leaves **8 engine tests failing** (they assert the
  deleted swap and the old room-based rationale text). Task 4 fixes them;
  they are enumerated there. Do not treat them as a Task 2 regression.
- `reserved_sr_room_ids` is passed to Phases 4 and 5 as an **optional**
  parameter defaulting to `None` ("nothing reserved"), so every existing
  direct-call test of those phases still compiles unchanged.

---

## Task 2: Engine — supervisor immobility in Phases 7–9A and 9B

**State of the world:** Task 1 is done and committed. 9C now runs after
Phase 5 and before Phases 7–9A, and seats each session's supervisor in an SR
room. Nothing yet stops the later phases moving that supervisor back out.
This task adds those guards. It is engine-only — no new tests here (Task 4
owns all test work), and the 8 pre-existing failures listed in Task 4 are
expected to still fail when you finish.

**Files:**
- `backend/app/engine/phases/phase7_9a.py`
- `backend/app/engine/phases/phase9b.py`

### 2.1 — `phase7_9a.py::_is_displaceable_full_day` (~line 289)

Add, after the existing `role is not None` check:

```python
if am_slot.is_supervising or pm_slot.is_supervising:
    return False
```

Both periods, because Pass 1 moves both. Give the function a short docstring
(it currently has none) recording *why* the check is here and when it can
actually fire — see the fourth review correction above: the reachable case
is a supervisor holding a PRE_ASSIGNED D room whose SR booking failed under
D7, not a Pass 3 placement. Note also that the D-room test in
`_find_full_day_displacement` already excludes a supervisor who *did* get SR,
so this guard is not the ordinary path.

### 2.2 — `phase7_9a.py::_is_displaceable_single` (~line 457)

Same, for the one period this pass moves:

```python
if slot is None or slot.is_on_leave or slot.role is not None or slot.is_supervising:
    return False
```

Docstring as above. One case to state explicitly, because it looks like a
bug and is not: a doctor supervising in AM (so sitting in SR for AM) and
holding an ordinary D room in PM **is still displaceable in PM**. The guard
is per-period by design — their PM slot is not supervising, and the mid-day
room change was accepted in "Review decisions".

### 2.3 — `phase7_9a.py` module docstring

The Pass 1 and Pass 2 paragraphs describe who can be displaced. Add that a
supervising slot is excluded, and add a line to the paragraph on Pass 3's
D-inclusive fallback noting that Phase 9C now runs before this module, so
the SR room in a supervised session is already occupied and Pass 3's SR
fallback entry is a no-op there. Pass 3 itself is **not** changed.

### 2.4 — `phase9b.py`: exclude a PM-supervising doctor from the swap pool

Implement the D4 guard in `_eligible_doctors_for_day` rather than in
`_resolve_swaps_for_day`'s pair loop:

```python
if pm_slot.is_supervising:
    continue
```

alongside the existing leave / NO_SURGERY / unresolved-room filters. One
edit covers both sides of every pair, and the pair is then never *detected*,
so no `resolve_swap` log entry is written describing a swap that was never
considered — cleaner than logging a pair and then declining to act on it.

**Guard PM only. Do not add an AM guard.** The reasoning, which belongs in
the module docstring:

- This phase only ever writes PM (`Period.PM` is hardcoded in both
  `assign_room` calls), so an AM supervisor's SR seat cannot be overwritten
  here in the first place.
- The case that looks unsafe — A supervises in AM, holds SR in AM, and
  DEFAULT copies A's AM room into PM, putting A in SR for PM — cannot
  double-book. For A to be in a swap pair at all, the partner B must hold
  A's AM room (SR) in PM. If the PM session needs a supervisor, B *is* that
  PM supervisor and the PM guard above has already removed B from the pool,
  so the pair is never formed. If the PM session needs no supervisor, SR is
  genuinely free in PM once B vacates it, and A moving into it is correct.
- Guarding AM as well would abandon those harmless resolutions for nothing.

Also update the module docstring's opening paragraphs to record that 9C now
runs before this phase, so the swap pairs it sees can include a doctor who
was seated in SR by supervision rather than by a room pass.

**Explicitly out of scope for this task:** Pass 3 of 7–9A; anything in
`phase9c.py`, `phase4.py`, `phase5.py` or `room_relocation.py` (Task 1
finished those); and any test file.

---

## Task 3: Clinic room eligibility — SR excluded

**State of the world:** Tasks 1–2 done. The engine is correct. This closes
D6's path 3 — Phase 5 assigning SR to a clinic out of
`clinic.eligible_room_ids` — at the data-entry layer, so the engine needs no
change for it. Backend and frontend, plus one decision recorded below.

**Files:**
- `backend/app/api/schemas/clinic_type.py`
- `backend/app/api/routers/clinic_types.py`
- `frontend/src/components/ClinicTypeFormDialog.tsx`
- `frontend/src/lib/clinicTypeSchema.ts` (read it; the likely answer is
  "no change" — see step 3)
- `backend/tests/test_api/conftest.py` (add an SR room to the fixture — Task
  4 needs it)

### 3.1 — Schema: reject a literal `room_type: "SR"`

In `RoomEligIn._exactly_one` (or a second `model_validator`), reject
`room_type == RoomType.SR`:

> `"SR is reserved for trainee supervision and cannot be a clinic room"`

This is a 422 with a nested `loc`. That is fine — see the first review
correction.

### 3.2 — Router: reject a `room_id` that points at an SR room

Pydantic cannot do this one: `RoomEligIn` has an `int` and no DB session.
Add a module-level helper in `clinic_types.py`:

```python
def _reject_sr_rooms(db: Session, payload: ClinicTypeIn) -> None:
    """SR is held for trainee supervision (Phase 9C books it) and is not a
    selectable clinic room. The room_type half of this rule lives in
    RoomEligIn; this half needs the DB to resolve room_id -> room_type."""
```

Look up the named room ids in one `select(Room.id, Room.code).where(Room.id.in_(...), Room.room_type == RoomType.SR)`
and raise `HTTPException(400, "Room {code} is a supervision room and cannot be a clinic room")`
naming the offending room codes. Call it as the **first** statement of both
`create_clinic_type` and `replace_clinic_type`, before `_integrity_guard` /
`_apply` — nothing should be written or flushed before the payload is
rejected. `PATCH` does not touch eligibilities, so it needs nothing.

400 (not 422) because the dialog renders a string `detail` directly as the
top-of-form error; a 422 here would have to carry a synthetic FastAPI-shaped
body for no gain.

Add the rule to the router's module docstring alongside the existing notes
on the replace-children pattern and `clinic_priority`.

### 3.3 — Frontend: filter SR out of both room pickers

In `ClinicTypeFormDialog.tsx`:

- The **"Add specific room"** `<select>` (~line 377): add
  `.filter((r) => r.room_type !== "SR")` to the existing not-already-added
  filter.
- The **"Add room type"** `<select>` (~line 398): filter `rt !== "SR"` out of
  the local `ROOM_TYPES` constant (line 22). Do **not** change the constant
  itself — it is a plain `RoomType[]` and the identical one in
  `DoctorFormDialog.tsx` must keep SR, since a doctor may still prefer SR.

**Do not narrow `roomTypeEnum` in `clinicTypeSchema.ts`.** That enum also
parses `formValuesFromClinicType`'s output when editing an existing clinic
type; dropping "SR" would make an existing SR row unparseable and break the
edit dialog for exactly the legacy data step 5 is about. The picker filter is
the right layer — it prevents creating one while still round-tripping one
that exists.

### 3.4 — API fixture

`backend/tests/test_api/conftest.py` builds C1 and D1 only. Add an SR room
(`code="SR"`, `room_type=RoomType.SR`) to the `seeded` fixture and expose it
as `"room_sr"`, so Task 4 can assert the rejection. Check whether any
existing assertion counts rooms before adding it.

### 3.5 — Decide: legacy rows naming SR (open point, do not skip)

D8 says "the system is not live, so no data migration is needed". That is
true of the *data* and false of the *code path*: nothing in the engine
ignores a `ClinicTypeRoomEligibility` row naming SR, so one already sitting
in a dev or Railway database still lets Phase 5 hand SR to a clinic before 9C
runs. 9C then finds no free SR, leaves the supervisor for Pass 3, and the
only trace is Phase 12's supervision finding — no warning names the cause.

**Recommended:** add a Phase 0 warning (not an error), sibling to the
PRE_ASSIGNED-SR warning Task 1 added in `phase0.py`, for any enabled
`ClinicTypeInfo` whose `eligible_room_ids` include an SR room, naming the
clinic type. It is ~10 lines, it matches the D7 precedent exactly ("a data
problem with a visible warning, not a silent failure"), and it covers rows
created before this change as well as any created directly against the API.

The alternative — filtering SR out of `eligible_room_ids` in
`load_context()` — is rejected: it makes the engine silently disagree with
the stored data, which is the failure mode the decision log exists to
prevent.

If the Phase 0 warning is adopted, add it to this task's file list
(`backend/app/engine/phases/phase0.py`) and to Task 4's new coverage.

---

## Task 4: Tests

**State of the world:** Tasks 1–3 done; the engine and API behave as
intended. Every test in this task is either a repair of a test that asserts
the deleted behaviour or new coverage for behaviour Tasks 1–3 introduced.

Start by running `uv run pytest tests/test_engine -q` and confirming you see
the same **8 failures** listed below and no others. If the count differs,
something in Tasks 2–3 regressed and that is the first thing to find.

### 4.1 — The 8 known failures, and what each becomes

**`tests/test_engine/test_phase9c.py::TestSrSwap` (4 failures, lines 46–205).**
The whole class is about the deleted `_swap_into_sr` and its
`swap_supervisor_into_sr` log action. Rename the class to `TestSrBooking`,
rewrite its docstring (there is no swap; the supervisor is *booked* into a
free SR room), and rework each test:

- `test_only_candidate_already_in_sr_no_swap_entry` (currently **passing** —
  keep it passing): rename to `..._no_booking_entry`. `_book_sr_room`'s
  first early return covers it.
- `test_sr_unoccupied_no_swap` → the opposite assertion. At 9C's new
  position an unoccupied SR is the *normal* case: assert the supervisor ends
  up in `sr_room.id`, not `d_room.id`, and that one `book_sr_room` entry was
  written.
- `test_ineligible_sr_occupant_falls_through_and_is_swapped_out` → there is
  no swap-out any more. With a PRE_ASSIGNED trainee holding the only SR
  room, 9C books nothing: assert the supervisor keeps their D room, the
  trainee keeps SR, and **no** booking entry is logged. This is D7's hole,
  so also assert Phase 0 warns (or cover that separately in 4.2).
- `test_pool_winner_not_in_sr_swaps_with_sr_occupant` → with SR held by
  another PRE_ASSIGNED Partner, same as above: pool selection still works,
  no booking happens, the occupant is not displaced. Keep the counter-driven
  pool setup, which is what this test is really pinning.
- `test_none_preference_sr_occupant_no_longer_auto_assigned` → drop the
  PRE_ASSIGNED SR occupant, or keep it and assert no displacement. The point
  of the test is that the `NONE` multiplier still deprioritises; keep that
  assertion and delete the swap assertions.

**`tests/test_engine/test_phase9c.py::TestDecisionLogRationale` (3 failures,
lines 390–516).** These assert the old room-based prose. Read the new text
in `_log_phase9c.py` and update the expected strings:

- `test_pool_line_shows_the_opening_balance_before_the_multiplier` and
  `test_pool_lines_show_the_counter_and_the_preference_multiplier` — the pool
  lines no longer carry `in D1`. Assert on the score arithmetic, which is
  what these tests exist for.
- `test_names_partner_salaried_doctors_kept_out_of_the_pool` — "in C1 (C),
  not a D or SR room" is gone, because a C-room Partner is now *in* the pool.
  Rewrite the fixture so the excluded doctor is excluded for a reason that
  still exists (a `role`, leave, WFH, or `ADMIN_TIME`) and assert the
  matching `_ineligible_lines()` text.

**`tests/test_engine/test_generate.py::TestGenerationLogPersistence::test_full_pipeline_persists_log_entries_in_sequence_order`
(1 failure).** This one is **not** a prose or swap problem, and the error is
misleading — `sqlalchemy.exc.NoResultFound` from `_write_counters`. Cause:
the test creates `ROOM_MOVE` counter rows only. Under the old room-criterion
pool no supervisor was selectable, so `SUPERVISION` was never incremented;
now one is, and `_write_counters` requires a pre-existing `SystemCounter`
row for every key it writes. Fix the fixture — `make_system_counter(...,
SystemCounterType.SUPERVISION, raw_count=0)` for each of the three doctors
(`POST /doctors` creates a row for every `SystemCounterType`, so the fixture
was the thing out of step with production, not the engine). Do **not**
"fix" this by making `_write_counters` tolerant of a missing row.

### 4.2 — New coverage

Per file, matching the plan's original list with the reasons now attached:

`test_phase9c.py`
- Supervisor with no room at all is seated in SR (the ordinary case at 9C's
  new position — the pool is roomless).
- Supervisor holding a PRE_ASSIGNED **C or W** room is moved into SR, the old
  room is freed, and **no `ROOM_MOVE` counter moves** (assert the counter
  explicitly; this is D3's deliberate override of a template pin).
- Two SR rooms exist: the first by `code` is taken, deterministically.
- `reserved_sr_room_ids` unit test: a session with a supervisable trainee
  appears, one without does not, and the value is the first SR room id.
  Cover "no SR room in the practice" → `{}`.

`test_phase4.py` / `test_phase5.py`
- A Phase 4 evictee is **not** relocated into SR in a session with a
  supervisable trainee, and **is** in a session without one. Same shape for a
  Phase 5 displaced occupant via `_best_free_preferred_room`, including the
  "doctor prefers SR" case, which must still get SR in an unsupervised
  session (this is the D6 sentence "Doctor room preferences need no change").
- Both phases take `reserved_sr` as an optional argument, so pass it
  explicitly rather than going through `generate()`.

`test_phase7_9a.py`
- Pass 1 will not displace a doctor whose AM **or** PM slot is supervising.
- Pass 2 will not displace a supervising slot, **and will** displace the PM
  slot of an AM-supervising doctor (2.2's deliberate asymmetry — assert it,
  or the next reader will "fix" it).

`test_phase9b.py`
- A pair where one doctor's PM slot supervises is not resolved and logs no
  `resolve_swap` entry.
- A pair where only the **AM** slot supervises **is** still resolved — this
  is the assertion that stops someone adding the AM guard 2.4 rejects.

`test_phase12.py`
- A supervisor who ended up in a C or W room is still flagged
  (`supervision_on_incompatible_slot`) — `is_eligible_supervisor` keeps its
  room test, and this is the test that proves the split did not erase it.
- A supervisor in SR is not flagged.

`test_phase0.py`
- A PRE_ASSIGNED SR template row produces a **warning**, not an error, and
  does not abort the run.
- If Task 3.5's Phase 0 clinic warning is adopted: an enabled clinic type
  with SR eligibility warns.

`test_generate.py`
- Beyond the fixture repair: one end-to-end case with a trainee, asserting
  the supervisor holds SR in the persisted rota and that the phase order in
  the persisted decision log has `phase9c` entries **before** `phase7_9a`
  entries. That ordering is the whole point of this plan and nothing else
  pins it.

`backend/tests/test_api/test_clinic_types.py`
- `POST` and `PUT` with `room_type: "SR"` → 422.
- `POST` and `PUT` with `room_id` = the SR room → 400, detail naming the room
  code.
- A payload mixing a valid C room and the SR room is rejected whole — assert
  nothing was created/modified (the check runs before `_apply`).

`frontend/src/components/ClinicTypeFormDialog.test.tsx`
- The "Add specific room" and "Add room type" selects offer no SR option
  (`setUpServer` needs a rooms list containing an SR room — the default is
  D1 only).
- Editing a clinic type that already has an SR eligibility row still renders
  the row and still submits it unchanged — this is the regression test for
  the "do not narrow `roomTypeEnum`" decision in 3.3.

---

## Task 5: Review and documentation

**State of the world:** Tasks 1–4 complete, the suite is green and the
feature is live. Documentation only — no code changes. If you find yourself
wanting one, stop and raise it instead.

Read `documentation/architecture.md` first for the documentation conventions
(design decisions and data flows, no duplication of what the code says).

### 5.1 — `documentation/phase_pipeline.md`

Line numbers are as of this plan's last revision; verify before editing.

- **Execution-order block (lines 12–22).** `Phase 9C` moves above
  `Phase 7-9A`; update its one-line description to mention the SR booking.
- **Line 36** ("Phase 9C was ported with three deliberate divergences").
  Divergence 2 was "no SR-priority fast path", which described a pool that
  no longer has a room criterion for a fast path to key on. Rewrite it —
  either as "the pool has no room criterion at all, and the supervisor is
  seated in SR afterwards" or drop it and renumber to two divergences. Say
  which you chose and why.
- **Phase 4 section (line 79) and Phase 5 section (line 108).** Both room
  searches now skip a reserved SR room in a session with supervisable
  trainees. State the rule and point at `phase9c.reserved_sr_room_ids` as
  its single definition.
- **Phase 7–9A section (line 127).** Passes 1 and 2 will not displace a
  supervising slot; Pass 3 is unchanged but now runs after 9C, so SR is
  already taken in supervised sessions.
- **Phase 9B section (line 150).** The PM-supervising exclusion, and the
  reason AM is deliberately not guarded (2.4).
- **Phase 9C section (line 176).** The biggest edit:
  - **Writes** line (~179) — no longer "may swap two doctors' room
    assignments"; it books a free SR room and frees whatever the supervisor
    held, including a PRE_ASSIGNED room.
  - **Depends on** line (~180) — Phase 5, not Phase 9B. Rooms are
    deliberately *not* final coming in.
  - The eligibility paragraph — two predicates now, with the split's reason.
  - Steps 1–5 — step 2's "D or SR room" pool goes; step 5 becomes the
    booking, with its two no-ops and the D7 hole.
  - Add the accepted **mid-day room change for supervisors** explicitly, as
    a user-visible consequence ("Review decisions", bullet 1). This is the
    one change a reader of the rota will actually notice, and nothing else in
    the documentation mentions it.
- **Phase 12 Depends on line (~231).** Check 4 still needs 9C to have run; it
  is no longer the phase immediately before.

### 5.2 — `documentation/architecture-clinical.md`

- **Phases directory line (~22)** and the **numbering note (~26)** — phase
  order.
- **Phase 4 note (~48).** It currently justifies D-room-only relocation of an
  evicted Trainee/Locum by "this preserves the single D-room-eligible pool
  that Phase 9C's supervision selection depends on". That rationale is gone —
  eligibility has no room criterion. Keep the behaviour and keep the other
  half of the sentence (duty doctors should not claim therapeutically
  isolated D rooms), and delete the supervision-pool clause rather than
  rewriting it into something weaker.
- **Phase 5 note (~50)** — the SR reservation.
- **Phase 9C summary (~52)** — rewrite. The current text is entirely about
  the D/SR pool and the swap into an occupied SR room.
- Add the SR-is-not-a-clinic-room rule somewhere a reader of the clinic-type
  model will find it, and record why it is enforced at the API rather than in
  the engine (the engine stays honest about stored data; the decision log
  exists to explain what it did, not to hide it).

### 5.3 — Close out

- Sanity-check that nothing else in `documentation/` still describes the
  swap: `grep -rn "swap_supervisor_into_sr\|SR swap\|D or SR" documentation/`.
- Delete `documentation/supervision_phase_order_plan.md`.
