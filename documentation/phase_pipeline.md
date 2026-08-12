# Phase Pipeline

**Scope:** What each phase does, its conceptual inputs and outputs, execution order, and outstanding tasks.  
**See also:** [domain-model.md](domain-model.md) for type and rule definitions; [M2_implementation_plan.md](M2_implementation_plan.md) for the Python file-by-file design. (`algorithms.md` has been retired: its implemented-phase content is superseded by the code and tests, and its Phase 9C supervision spec has itself been superseded by the Phase 9C implementation below, per the Phase 9C plan's confirmed decisions.)

**Status:** This document originally described the GAS pipeline as a platform-agnostic reference. M2 (the Python generation engine) is now built and has diverged from the original phase numbering in several places — phases were merged, renumbered, or deferred. This revision describes the pipeline as actually implemented in `backend/app/engine/`, with the original GAS phase numbers kept only where they still map cleanly. For exact function names and module paths, see the "Python implementation" line under each phase.

---

## Execution Order

```
Phase 0     -> Pre-flight validation (blocking - aborts if hard errors found)
Phase 2     -> Build the rota grid from the master template; load counters
Phase 4     -> Apply pre-planned duty doctors (primary + secondary, one phase)
               and resolve their D-room, including same-day consolidation
Phase 5     -> Assign clinics (schools, colleges, care homes, duty helpers - uniformly)
Phase 7-9A  -> Resolve remaining rooms: full-day Trainee/AHP displacement, then
               single-session Trainee/AHP displacement, then Partner/Salaried
               fallback (no displacement) - three passes, one module
Phase 9B    -> Eliminate same-day room swaps between Partners/Salaried
Phase 9C    -> Assign trainee supervision
Phase 12    -> Validate the completed rota (read-only; 6 checks)

Not applicable to the Python architecture:
Phase 10    -> Rota formatting (frontend/API concern, M3/M4)
Phase 11    -> Room-centric rota view (frontend/API concern, M3/M4)
```

Renumbering from the original GAS pipeline:
- **Phase 1** (read config/setup) is not a separate phase in Python. Config validation lives in Phase 0; reference data (doctors, rooms, clinic types, leave, duty, the master template) is loaded once by `context.load_context()`, which every phase reads from.
- **Phase 3** (apply leave) is not a separate phase. Leave is folded into Phase 2: each `SessionSlot` gets an `is_on_leave` flag when the grid is built, and every phase that selects or displaces a doctor checks that flag directly rather than reading an `ON LEAVE` sentinel value from a cell.
- **Phase 4A/4B** (primary/secondary duty) are one phase (`phase4.py`), since `DutyAssignment.duty_type` already distinguishes them - there was never a reason to run two passes.
- **Phase 6** (duty helpers) no longer exists as a phase. A duty helper is an ordinary `ClinicType` row; Phase 5 handles it exactly like any other clinic, keyed by `clinic_priority`.
- **Phases 7, 8, 9A** are one module (`phase7_9a.py`) with three internal passes, since they share the same D-room pool, the same `ROOM_MOVE` counter, and largely the same helper logic.
- **Phase 9C** was ported with three deliberate divergences from the original GAS design - see the Phase 9C section below.
- **Phases 10, 11** are out of scope for the generation engine - see each phase's section below for why.

Every phase 0-12 operates on one `RotaGrid` (the in-memory rota) and one `CounterState` (the in-memory counter working copy) built once at the start of a run. Nothing is written to the database until the whole pipeline completes; a single transaction wraps everything, so a Phase 0 error or an unhandled exception mid-pipeline leaves the database untouched.

---

## Phase 0 - Pre-flight Validation

**Purpose:** Block generation before any grid is built if the input data contains hard errors.

**Reads:** `GenerationContext` (leave, duty, active template, doctors), `RotaConfig`.  
**Writes:** Nothing - strictly read-only.  
**Depends on:** Nothing (runs before Phase 2 builds the grid).  
**Python implementation:** `run_phase0(context, config)` in `phase0.py`.

**Checks (all severity="error" - any one aborts the run):**
1. Exactly one active `MasterRotaTemplate` exists. Zero and more-than-one are both treated as the same error - the fix in either case is to correct the template data, not something a generation run can resolve.
2. `RotaConfig.start_date` is a Monday.
3. `RotaConfig.num_weeks` is 1, 2, or 4.
4. `RotaConfig.template_start_week` is between 1 and 4.
5. No duty doctor is on leave for any of their assigned duty sessions.
6. Every doctor referenced by the active template is active (one finding per doctor, not per slot, even if they appear in many template rows).

---

## Phase 2 - Build the Grid, Load Counters

**Purpose:** Produce the initial in-memory rota by walking the active master template for the configured weeks, and load the current counter values.

**Reads:** `GenerationContext` (active template, leave, week/date mapping), `RotaConfig`, existing `ClinicCounter`/`SystemCounter` rows.  
**Writes:** Nothing to the database. Returns a populated `RotaGrid` and `CounterState`.  
**Depends on:** Phase 0 (must have passed with no errors).  
**Python implementation:** `run_phase2(context, config, db)` in `phase2.py`. Takes a `db` session directly (a deviation from the M2 plan's own orchestrator sketch, which omitted it - Phase 2's own description requires DB access to load counters, so the sketch was simplified and this fixes the inconsistency).

For each generation week, the template week is resolved via `template_week(gen_week, template_start_week)` (a 1-4 rotation), and one `SessionSlot` is created per (doctor, day, period) that has a template row. `is_on_leave` and `is_wfh` are set on each slot at this point. Room occupancy is initialised only for `PRE_ASSIGNED` and `ADMIN_TIME`-with-room slots; `REQUIRES_ROOM` slots are always created unassigned, to be resolved by Phases 5 and 7-9A. A doctor/day/period with no template row simply gets no slot - not treated as an error.

Counters are loaded as a flat working copy: `ClinicCounter` keyed `(doctor_id, clinic_type_id)` (shared across all of a clinic type's schedule slots - see architecture.md's M1 section for why an earlier per-slot design was reversed before M2 began), `SystemCounter` keyed `(doctor_id, counter_type)`.

---

## Phase 4 - Duty Doctors

**Purpose:** Apply pre-planned duty doctors (primary and secondary) to their existing slots, and resolve their room for the duty session.

**Reads:** `GenerationContext.duty_map`, `GenerationContext.preferred_rooms_by_doctor`, the grid built by Phase 2.  
**Writes:** `role` (`DUTY_PRIMARY`/`DUTY_SECONDARY`) on the duty slot; `assigned_room_id` on the duty slot and, where an eviction or a consolidation move happens, on the affected other doctor's slot too; increments an evicted occupant's `ROOM_MOVE` system counter (never the duty doctor's own move, and never a consolidation-bumped occupant's).  
**Depends on:** Phase 2.  
**Python implementation:** `run_phase4(context, grid, counters, log)` in `phase4.py`.

Duty is pre-planned data (a `DutyAssignment` row already names the doctor) - this phase never selects who is on duty and never touches a clinic counter. It does, however, own room resolution for the duty doctor: every primary and secondary duty slot must end up in a D room before the phase returns, mirroring the original GAS "D?" manual-marker behaviour. (This corrects this document's earlier claim that duty room resolution happened later, in Phase 7-9A - it has always happened here; `phase4.py`'s own module docstring flagged the discrepancy.)

Two data-quality situations are handled as warnings rather than crashes: a duty doctor with no matching session slot (no template row for that doctor/day/period), and two `DutyAssignment` rows landing on the same doctor/slot (the schema doesn't prevent this, since the unique constraint is on `(date, period, duty_type)`, not on doctor). If the slot was templated WFH, duty overrides it and `is_wfh` is cleared.

**Room resolution, per duty row, first pass:** already in a D room -> done. Otherwise try the doctor's preferred D room: free -> take it; occupied by a protected doctor (Partner/AHP, or anyone already holding a role) -> fall through to the sweep; occupied by anyone else -> evict and relocate them (Salaried via the shared preference-then-C/W/SR search; Trainee/Locum via a D-room-only search, Design Decision 8), then take the room. Eviction is unconditional - the duty doctor takes the room even if the evictee cannot be rehoused (Design Decision 10), and the evictee's `ROOM_MOVE` counter increments either way.

**Fallback sweep** (no preferred D room, or it was protected): prefer a D room free for both AM and PM that day, code descending; if none exists, the first D room free in the current period only, code descending. Failing that, evict the lowest-weighted-`ROOM_MOVE`-score Salaried occupant of any D room - Trainees and Locums are never sweep victims (Design Decision 12c). Total failure leaves the doctor's role applied but roomless, and any existing non-D room they already held is untouched. The all-day-free preference applies only to this sweep, not to the preferred-D-room step above - a doctor's stated preference is tried as-is, and full-day consolidation is handled separately by the second pass below.

**Second pass - same-day room consolidation.** Duty runs a shifted shift pattern (8am-1pm / 1pm-6.30pm) that straddles the normal session boundary, so a duty doctor who lands in a different room for their non-duty session that day faces an awkward mid-shift room change. Once every duty row above has a role and (where possible) a room, a second pass walks the same duty rows and tries to move each duty doctor into their duty room for the day's other session too:
- No slot, on leave, or already in the same room that session -> nothing to do.
- Room free -> move the duty doctor in.
- Room occupied by another doctor already on `DUTY_PRIMARY`/`DUTY_SECONDARY` that session -> protected, leave both doctors where they are. This protection rule is narrower than the preferred-room step's `_is_protected_occupant` above - Partner/AHP and clinic-role holders are *not* protected here, and may be bumped.
- Otherwise -> look for another D room for the occupant via `find_d_room_only` (their own preference order, any D room as fallback); found -> bump them and move the duty doctor in; not found -> leave both doctors where they are.

Both the duty doctor's own move and a bumped occupant's move are opportunistic, not evictions, so neither touches `ROOM_MOVE`. A doctor who cannot be consolidated is left exactly as the first pass placed them, and this is logged for information rather than raised as a `ValidationIssue` - nothing is wrong, the second pass simply found no improvement available. Phase 7-9A can still move any of these doctors later, so consolidation improves the odds of a duty doctor keeping one room for the whole day without guaranteeing it.

**Duty coverage expectations** (validated later by Phase 12 Check 1, not enforced here): exactly 1 primary duty doctor per session, every weekday. Exactly 1 secondary duty doctor per session on Monday only (0 elsewhere). Note this is a correction from the original GAS-era wording of "2 primary on Monday" - `DutyAssignment`'s unique constraint on `(date, period, duty_type)` structurally forbids more than one primary row per session, on any day. The "2" in the original domain description refers to Monday typically being staffed by two different people across its two sessions (AM and PM), not two simultaneous primary-duty doctors in one session - confirmed with the user after CI caught the contradiction directly (a second primary `DutyAssignment` for the same date/period fails at the database level).

---

## Phase 5 - Clinic Assignment

**Purpose:** Assign a doctor to every enabled clinic type's schedule slot, using fair counter-based selection, and resolve rooms for clinics that require a specific room.

**Reads:** `GenerationContext.clinic_types` (enabled only, ordered by `clinic_priority` ascending), the grid, the counter state.  
**Writes:** `clinic_type_id` and `role=CLINIC` on the selected slot; `assigned_room_id` if `room_required`; increments the doctor's shared clinic counter.  
**Depends on:** Phase 4 (duty doctors must already hold their role, so clinic candidates correctly exclude them).  
**Python implementation:** `run_phase5(context, grid, counters)` in `phase5.py`.

Iteration order is clinic type (priority ascending) -> schedule slot (weekday/period ascending) -> generation week - this matters because counter selection for a later iteration depends on increments made by an earlier one. Duty helpers are not a separate mechanism; they are an ordinary `ClinicType` row and go through exactly this same loop.

**Eligibility** for a given clinic/day/period: the doctor must be in the clinic's `doctor_eligibilities`, active, have a session slot at that time that is not on leave, not WFH, not `NO_SURGERY`/`ADMIN_TIME`, and not already holding a role (duty or an earlier-tier clinic).

**Selection** among eligible doctors: lowest `doctor_priority` first, then lowest weighted counter score, then alphabetical by code. The weighted score is `raw_count / sessions_per_week`, so part-time doctors accumulate assignments proportionally to their working week; the same formula is used everywhere a weighted counter is compared (clinic selection here, `ROOM_MOVE` displacement candidates in Phase 7-9A, and `SUPERVISION` selection in Phase 9C).

**Room resolution** (only if `room_required`): already-eligible room -> free eligible room -> displace an occupant of an eligible room who isn't on leave/duty/protected by a higher-priority clinic, moving them to their best free preferred room (excluding D-type rooms if the room being freed is itself a D room) -> warning and leave the doctor in their current room if none of that works. This uses only the displaced doctor's own preference list - no fallback to any-free-room-of-a-type, unlike the fuller displacement algorithm used in Phase 7-9A (see below). Room resolution success or failure does not affect whether the clinic counter is incremented - the counter tracks the clinic assignment, not the room outcome.

---

## Phase 7-9A - Remaining Room Assignment

**Purpose:** Resolve every `REQUIRES_ROOM` slot still unassigned after Phase 5.

**Reads:** The grid, the counter state, `GenerationContext.preferred_rooms_by_doctor`.  
**Writes:** `assigned_room_id` on resolved slots; increments the displaced doctor's `ROOM_MOVE` counter (once per full-day displacement, not once per session).  
**Depends on:** Phase 5.  
**Python implementation:** `run_phase7_to_9a(context, grid, counters)` in `phase7_9a.py`. Three passes, run to completion in order across the whole grid before the next pass begins:

Pass 1 (full-day Trainee/AHP, was GAS Phase 7): for a Trainee/AHP needing the same D room for both AM and PM of a day: prefer a room already free in both sessions; failing that, find a full-day Partner/Salaried victim to displace. Victims are ranked in two priority tiers ahead of any tie-break: Priority 1 is a doctor holding a different D room in AM and PM (displacing them frees two D rooms for one move); Priority 2 is a doctor holding the same D room all day. Within a tier, ties are broken on live weighted ROOM_MOVE score, then doctor code — a single-level tie-break, unlike the original GAS system's extra "times moved this week" tier, which existed only to avoid re-reading batch-fetched counters mid-run and is obsolete now that ROOM_MOVE is read and incremented live. The displaced doctor is relocated from a fixed C/W/SR pool only — Pass 1 never consults their own preference list, unlike Pass 2 below. When a Priority 1 victim is displaced, both of their vacated D rooms are checked for same-day consolidation (an improvement over the original GAS behaviour, user-confirmed): if either room is already free in the other session once the victim leaves, the trainee takes that one room for the full day instead of being split across both.

Displacement room-finding: Pass 2 follows the full "Room Preference Assignment" algorithm from algorithms.md for the displaced Partner/Salaried doctor — walk their own preference list first (excluding D rooms), then fall back to any free room of an eligible non-D type (C, W, SR); if that also fails, warn and leave them unmoved. Pass 1 skips the preference-list step entirely and goes straight to the C/W/SR pool (first free room by id, free in both AM and PM) — this asymmetry between Pass 1 and Pass 2 is deliberate, not an inconsistency. Pass 3 has its own, separate fallback (see below) — SR/D/C/W by type priority, D rooms included — which is not the same pool as Pass 1/2's.

**Pass 2 (single-session Trainee/AHP, was GAS Phase 8):** the same logic, per remaining individual session - this covers slots Pass 1 couldn't resolve as a full day (e.g. only one of the two sessions has a displaceable occupant) as well as slots that only ever needed a single session.

**Pass 3 (Partner/Salaried fallback, was GAS Phase 9A):** no displacement. Walk the doctor's own preference list first and take the first free room. If nothing on their own list is free, force the doctor into the first free room by type priority SR > D > C > W (rooms ordered by code within a type) — Pass 3's own fallback pool, distinct from the Pass 1/2 displaced-doctor pool (C/W/SR, D excluded) below. D rooms are deliberately included here: Pass 3 runs last, after Passes 1 and 2 have already settled all Trainee/AHP D-room demand, so any D room still free at this point is genuine surplus. Only if the preference list and the full fallback sequence are both exhausted does the slot remain unresolved and a warning fire.

**Displacement room-finding** (Pass 1/2 only, for the *displaced* Partner/Salaried doctor - not the Trainee/AHP moving into the freed D room, and not Pass 3): walk the displaced doctor's own preference list in order and take the first free room (excluding D rooms, since they were just displaced out of one); if nothing in their list is free, fall back to any free room of an eligible non-D type (C, W, SR); if that also fails, warn and leave them unmoved.

**Known gap:** a doctor on leave still gets a `REQUIRES_ROOM` slot from Phase 2 (the template doesn't know they're on leave), but this phase correctly skips them entirely - they never get a room and it is not treated as a failure. Phase 12 Check 3 must exclude on-leave slots for the same reason (see below).

---

## Phase 9B - Eliminate Room Swaps

**Purpose:** Detect and resolve cases where two Partner/Salaried doctors have swapped rooms between AM and PM on the same day.

**Reads:** The grid, `GenerationContext.preferred_rooms_by_doctor`.  
**Writes:** PM `assigned_room_id` only, for doctors in a resolved swap pair. AM is never touched.  
**Depends on:** Phase 7-9A (all room assignments must be resolved before a swap can be meaningfully detected).  
**Python implementation:** `run_phase9b(context, grid)` in `phase9b.py`. Never emits a `ValidationIssue` - resolution is fully deterministic for every detected swap.

**Swap definition:** Doctor A has room X in AM and room Y in PM; Doctor B has room Y in AM and room X in PM, on the same day. Only Partner/Salaried doctors are considered; a pair is skipped entirely if either doctor has leave, a `NO_SURGERY` session, or an unresolved session that day.

Since only PM can change, resolution is a binary choice: **DEFAULT** (both doctors keep their own AM room for PM too - undoes the swap) or **CONFIRM** (leave PM exactly as already computed - the swap stands).

**"Preference match"** means the room appears anywhere in the doctor's `DoctorPreferredRoom` list - not restricted to their #1 preference or to a currently-free room (confirmed with the user).

**Resolution**, checked in this order, first match wins:
1. Only Doctor A prefers their own current AM room -> DEFAULT.
2. Only Doctor B prefers their own current AM room -> DEFAULT.
3. Only Doctor A prefers the other room (Doctor B's AM room) -> CONFIRM.
4. Only Doctor B prefers the other room (Doctor A's AM room) -> CONFIRM.
5. Anything else (including the GAS-era "both prefer the same room; Partner wins" rule) -> DEFAULT.

The GAS-era "both prefer the same room; Partner wins" row was dropped during the Python port as unreachable under strict top-to-bottom evaluation - full rationale recorded in architecture.md's M2 design decisions.

---

## Phase 9C - Trainee Supervision

**Purpose:** Assign a supervising Partner/Salaried doctor to every session with at least one trainee requiring supervision.

**Reads:** The grid, the counter state, `GenerationContext` (doctor types, room types).  
**Writes:** `is_supervising=True` on the selected slot; increments the selected doctor's `SUPERVISION` system counter; may also swap two doctors' room assignments for the session (see step 5 below) - this is the one point after Phase 9B where a room assignment changes. Emits a `supervision_unassignable` warning when no eligible supervisor exists for a session.  
**Depends on:** Phase 9B (rooms must be resolved before eligibility, and current occupancy, can be evaluated; Phase 9C may itself further adjust room assignments via the SR swap).  
**Python implementation:** `run_phase9c(context, grid, counters)` in `phase9c.py`. Exposes two shared, module-level public predicates - `count_supervisable_trainees` and `is_eligible_supervisor` - reused verbatim by Phase 12 Check 4, so the assignment rule and the validation rule cannot drift apart.

The port from the original GAS design (absorbed from the now-retired `algorithms.md`) diverges in three confirmed places:

1. **Single supervisor pool - the GAS duty-helper fallback pool is dropped.** Duty helpers are deliberately kept away from supervising in practice (it interferes with duty-helper work), so there is no secondary pool. A duty helper holds `role=CLINIC`, so the single pool's `role is None` criterion excludes them for free - no `ClinicTypeInfo.category` plumbing was needed.
2. **No SR-priority fast path.** GAS (and an earlier iteration of this port) auto-assigned the SR-room occupant ahead of the pool comparison, whether or not they were the fairest choice by counter. That fast path has been removed: selection is always by weighted `SUPERVISION` score across the whole D/SR pool, so a doctor already sitting in SR competes on the same footing as one sitting in D.
3. **The trainee count is not persisted.** `is_supervising: bool` is the only persisted output - `is_on_leave` is derived from `leave_entries` at read time, so a persisted count would go stale whenever leave is added after generation (or an edit flips a trainee's slot to `NO_SURGERY`). The frontend derives the count client-side for the badge (see `superviseeCount.ts`), mirroring the same rule.

**Trainee counting rule** (`count_supervisable_trainees`): a trainee counts toward "needs supervision" iff their slot exists, `doctor_type == TRAINEE`, not on leave, not WFH, and `template_type` is not `NO_SURGERY`/`ADMIN_TIME`. **No room criterion:** a trainee holding a C or W room still counts, even though eligible supervisors are by definition on-site in D/SR rooms - this matches GAS and is the intended model, not an oversight.

**Supervisor eligibility** (`is_eligible_supervisor`): Partner or Salaried; `role is None` (excludes duty doctors, clinics, and duty helpers); not on leave; not WFH; `template_type` not in (`NO_SURGERY`, `ADMIN_TIME`); has an `assigned_room_id`, and that room's type is D or SR.

**Per session, in order:**

1. Count supervisable trainees. Zero -> skip the session entirely.
2. Build the pool of every eligible-supervisor slot in the session (D or SR room, no SR-first shortcut).
3. Empty pool -> `supervision_unassignable` warning, no assignment (Phase 12 Check 4 also independently reports the session).
4. Otherwise select by lowest weighted `SUPERVISION` score (`raw_count / sessions_per_week`; `spw=0` scores infinity, never selected), scaled by the doctor's `supervision_preference` multiplier, alphabetical tiebreak by doctor code - the same selection pattern as Phase 5. Sets `is_supervising=True` and increments the selected doctor's `SUPERVISION` counter.
5. **SR swap:** if the selected supervisor is not already sitting in an SR room, and an SR room (rooms ordered by `code` for determinism - the schema does not constrain SR to exactly one room even though the seed currently has one) is occupied by a different doctor, the two doctors' room assignments are swapped - the supervisor takes the SR room, the displaced doctor takes the supervisor's vacated room. Excluded edge case: if the selected supervisor is already sitting in an SR room, no swap happens. If no SR room is occupied by anyone else, no swap happens. The swap is a pure room move: it does not touch `is_supervising` or the `SUPERVISION` counter of either doctor beyond what step 4 already set.

**Supervision preference (pool selection only):** each doctor has a `supervision_preference` (`none`/`less`/`normal`/`more`, default `normal`) that multiplies their weighted `SUPERVISION` score before the pool comparison in step 4 - `{NONE: 1_000_000, LESS: 1.5, NORMAL: 1.0, MORE: 0.66}`, hardcoded in `phase9c.py`. Lower score still wins, so a higher multiplier deprioritises. Applies uniformly to every pool candidate now that there is no SR-priority fast path to exempt from it. One scoping point remains deliberate:

- **The multiplier deprioritises, it does not exclude.** A `none`-preference doctor can still be selected from the pool if they are the sole eligible doctor that session - step 3's "only eligible doctor" case has no competitor to lose to. Supervision must still happen even when the only available doctor dislikes it.

The multiplier never changes what the `SUPERVISION` counter counts, only who gets picked; the Counters page continues to show the plain unweighted (`raw / spw`) score, same shared display component as `ROOM_MOVE`. When the multiplier changes the pool winner from what the raw score would have picked, the generation log message is suffixed `(preference-adjusted)`.

**Manual-edit escape hatch:** `is_supervising` is included in the session PATCH (`SessionPatchIn`), applied verbatim with no eligibility check - consistent with the rest of the editing API's apply-then-warn model. Phase 12 Check 4 prong 2 (`supervision_on_incompatible_slot`) surfaces misuse on the re-run every edit endpoint already triggers. Edits never touch the `SUPERVISION` system counter, matching the existing rule that counters are written only at generation time.

**Rotas with no supervision recorded:** `RotaSession.is_supervising` has a `server_default` of false, so a row that was never set reads as unsupervised and `/issues` reports `supervision_missing` for it - correct, since such a rota genuinely has no supervision recorded, not an artifact to suppress.

---

## Phase 10 - Formatting

**Status: not applicable to the Python architecture.** Visual formatting (column widths, cell colours, borders) was a GAS spreadsheet concept. In the web app this is entirely a frontend rendering concern (M4) - the generation engine has no equivalent phase and never will.

---

## Phase 11 - Room Rota

**Status: not applicable as a generation-engine phase.** The room-centric view is a read/query concern, not something the generation engine produces - it will be a computed API view or frontend transformation over `RotaSession` rows (M3/M4), not a phase that mutates the grid.

---

## Phase 12 - Rota Validation

**Purpose:** Read-only pass that checks the completed rota and reports findings. Every finding is a warning - nothing in Phase 12 aborts generation (Phase 0 is the only phase whose findings can be errors).

**Reads:** The grid, `GenerationContext` (clinic types, doctors).  
**Writes:** Nothing - returns a list of `ValidationIssue`.  
**Depends on:** Phase 9C (Check 4 needs supervision assignment to have run; every other check only needs Phase 9B's room resolution, but Phase 9C runs first regardless since it sits between 9B and 12 in the pipeline).  
**Python implementation:** `run_phase12(context, grid)` in `phase12.py`. Also invoked, independently of a fresh generation run, by `grid_utils.run_phase12_for_rota()` to re-validate a rebuilt grid on every editing endpoint and `/issues` call.

| Check | Rule | Status |
|---|---|---|
| 1. Duty coverage | Exactly 1 primary duty doctor per session, every weekday; exactly 1 secondary per session on Monday only, 0 elsewhere | Implemented (`duty_coverage_primary`/`duty_coverage_secondary`) |
| 2. Clinic coverage | Every enabled clinic type's schedule slot has exactly 1 assignment, every week - subsumes duty-helper coverage, since a duty helper is an ordinary `ClinicType` | Implemented (`clinic_coverage`) |
| 3. Unresolved rooms | No `REQUIRES_ROOM` slot may have `assigned_room_id is None`, **excluding on-leave and WFH slots** (neither needs a room - see the Phase 7-9A known gap above; the warning re-surfaces if WFH is toggled off) | Implemented (`unresolved_room`) |
| — Role on incompatible slot | Any role (duty or clinic) on a `NO_SURGERY`/`ADMIN_TIME`/on-leave/WFH slot - keeps forced edits honest, since the editing endpoints have no eligibility checks of their own | Implemented (`role_on_incompatible_slot`, added M3.7) |
| 4a. Supervision missing | Every session with `count_supervisable_trainees >= 1` has at least one slot that is both `is_supervising=True` and currently `is_eligible_supervisor` - a flag on an ineligible slot does not satisfy this | Implemented (`supervision_missing`) |
| 4b. Supervision on incompatible slot | Any `is_supervising=True` slot that fails `is_eligible_supervisor`, regardless of whether trainees are present - mirrors role_on_incompatible_slot | Implemented (`supervision_on_incompatible_slot`) |

A session edited into a bad state can trigger both 4a and 4b at once (the flagged supervisor is now invalid, and no valid supervisor remains) - correct, not a duplicate finding.

Correctness of these checks against real clinic data cannot be fully verified until clinic types exist via M3 (API) and M4 (frontend), per the M2 plan's own "Done when" criteria - M2's tests use inline-built fixtures, not seeded production-shaped data.