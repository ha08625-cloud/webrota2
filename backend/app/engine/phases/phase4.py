"""Phase 4 -- resolve pre-planned duty doctors into D rooms.

Duty is pre-planned (a `DutyAssignment` row already names the doctor), so
this phase never chooses *who* is on duty and never touches a clinic
counter. It does, however, own room resolution for the duty doctor: every
primary and secondary duty slot must end up in a D room before the phase
returns, exactly mirroring the original GAS "D?" manual-marker behaviour.
This corrects an earlier version of this module (and of
phase-pipeline.md), which incorrectly claimed room resolution for duty
doctors happened later, in Phases 7-9A.

Per duty row, in order:
  1. Apply the role.
  2. If the slot was templated WFH, abandon the WFH (clear `is_wfh`) --
     duty overrides working from home.
  3. If the doctor already holds any D room, stop -- nothing to do.
  4. Try their preferred D room: assign if free; if occupied by a
     protected doctor (Partner/AHP, or anyone already holding a role),
     fall through to the sweep; otherwise evict the occupant and relocate
     them (Salaried via the shared preference-then-C/W/SR search,
     Trainee/Locum via a D-room-only search), then take the room.
  5. Fallback sweep: prefer a D room that is free for *both* periods that
     day (code descending); if none exists, fall back to the first D room
     free in the current period only (code descending). Failing that,
     evict the lowest-weighted-room-move-score Salaried occupant of any D
     room (Trainees are never sweep victims). The all-day-first
     preference does not apply to the preferred-D-room step above -- a
     doctor's stated preference is tried as-is; consolidation into a single room for the whole day is
     handled separately, by the second pass below.
  6. Total failure: warn and leave any existing (non-D) room the doctor
     already held untouched -- this phase never frees a duty doctor's own
     room, only ever reassigns it via `grid.assign_room`.

Every eviction increments the evictee's ROOM_MOVE system counter, even
when the subsequent relocation search fails and they are left roomless --
the counter records the disruption, not the destination.

Second pass -- same-day room consolidation. Duty runs 8am-1pm or 1pm-6.30pm,
straddling the usual 8.30-11am / 2-6pm session boundary, so a duty doctor who
ends up in a different room for their non-duty session that day faces an
awkward mid-shift room change. Once every duty row has a role and (where
possible) a D room from the pass above, a second pass walks the same duty
rows and, for each, looks at the doctor's slot in the *other* period of
the same day:
  - No slot, on leave, or already in the same room: nothing to do.
  - Room free in the other period: move the duty doctor in. This is the
    doctor's own move, not an eviction, so it never touches ROOM_MOVE.
  - Room occupied by someone already on `DUTY_PRIMARY`/`DUTY_SECONDARY`
    in that slot: protected, leave both doctors where they are. This is
    a narrower protection rule than `_protection` above --
    Partner/AHP and clinic-role holders are *not* protected here, and may
    be bumped, but only ever into another free D room (never C/W/SR).
  - Otherwise, look for another D room for the occupant via
    `find_d_room_only` (their own preference order, any D room as
    fallback). Found: bump them and move the duty doctor in, neither
    doctor's ROOM_MOVE counter is touched. Not found: leave both doctors
    where they are.

Every entry this module logs carries a `rationale` replaying the search
stage by stage; that prose lives in `_log_phase4.py`, whose narrators
snapshot the room state before the grid moves.

Consolidation is opportunistic, not required: a doctor who cannot be
consolidated is left exactly as the first pass placed them, and this is
logged for information, not raised as a `ValidationIssue` -- nothing is
wrong, the second pass simply found no improvement available. Phase
7-9A can still move any of these doctors later; consolidation only
improves the odds that a duty doctor keeps one room for the whole day, it
does not guarantee it.
"""
from __future__ import annotations

from datetime import date

from ...models.enums import (
    Day,
    DoctorType,
    DutyType,
    Period,
    RoomType,
    SessionRole,
    SystemCounterType,
)
from ..datatypes import (
    CounterState,
    DecisionLog,
    GenerationContext,
    RotaGrid,
    SessionSlot,
    ValidationIssue,
)
from ..room_relocation import find_d_room_only, find_relocation_room
from . import _log_phase4 as narrate
from ._log_phase4 import PHASE
from ._shared import code as _code
from ._shared import is_room_free_all_day as _is_room_free_all_day
from ._shared import room_move_rank as _room_move_sort_key


def run_phase4(
    context: GenerationContext, grid: RotaGrid, counters: CounterState, log: DecisionLog
) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    d_room_ids_desc = sorted(
        (r.id for r in context.rooms_by_type.get(RoomType.D, ())),
        key=lambda rid: context.room_by_id[rid].code,
        reverse=True,
    )

    for (date_, period, duty_type), doctor_id in sorted(
        context.duty_map.items(), key=lambda kv: (kv[0][0], kv[0][1].value, kv[0][2].value)
    ):
        genslot = context.date_to_genslot.get(date_)
        if genslot is None:
            # Defensive only: context.duty_map is already filtered to the
            # run's date range by load_context, so this should not occur.
            continue
        gen_week, day = genslot

        code = _code(context, doctor_id)
        slot = grid.get(doctor_id, gen_week, day, period)

        if slot is None:
            issues.append(ValidationIssue(
                severity="warning", phase=PHASE, check="duty_no_session_slot",
                week=gen_week, day=day, period=period,
                message=(
                    f"Duty doctor {code} ({duty_type.value}) has no session "
                    f"slot for {date_.isoformat()} {period.value} (no "
                    f"template row for this doctor/day/period)."
                ),
            ))
            continue

        if slot.role is not None:
            # Two DutyAssignment rows (e.g. primary and secondary) landing on
            # the same doctor/slot -- the schema doesn't prevent this. Keep
            # whichever was applied first (deterministic due to the sort
            # above) and warn rather than silently overwriting.
            issues.append(ValidationIssue(
                severity="warning", phase=PHASE, check="duty_role_conflict",
                week=gen_week, day=day, period=period,
                message=(
                    f"Duty doctor {code} already has role {slot.role.value} "
                    f"for {date_.isoformat()} {period.value}; cannot also "
                    f"apply {duty_type.value} duty to the same slot."
                ),
            ))
            continue

        slot.role = (
            SessionRole.DUTY_PRIMARY if duty_type == DutyType.PRIMARY
            else SessionRole.DUTY_SECONDARY
        )
        narrate.duty_applied(log, gen_week, day, period, doctor_id, code, date_, duty_type)

        if slot.is_wfh:
            slot.is_wfh = False
            narrate.wfh_abandoned(log, gen_week, day, period, doctor_id, code, date_)

        issues.extend(_resolve_duty_room(
            context, grid, counters, log, doctor_id, code, slot,
            gen_week, day, period, date_, d_room_ids_desc,
        ))

    _consolidate_duty_rooms(context, grid, log)

    return issues


# ---------------------------------------------------------------------------
# Room resolution
# ---------------------------------------------------------------------------

def _resolve_duty_room(
    context: GenerationContext, grid: RotaGrid, counters: CounterState, log: DecisionLog,
    doctor_id: int, code: str, slot: SessionSlot,
    gen_week: int, day: Day, period: Period, date_: date, d_room_ids_desc: list[int],
) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    narr = narrate.DutyRoomNarrator(
        context, grid, counters, log, doctor_id, code,
        gen_week, day, period, date_, d_room_ids_desc,
    )

    # Self-check: already in any D room -- nothing to do.
    if slot.assigned_room_id is not None:
        if context.room_by_id[slot.assigned_room_id].room_type == RoomType.D:
            narr.already_in_d_room(slot.assigned_room_id)
            return issues

    # Preferred D room.
    preferred_d_room = None
    for room_id in context.preferred_rooms_by_doctor.get(doctor_id, ()):
        if context.room_by_id[room_id].room_type == RoomType.D:
            preferred_d_room = room_id
            break
    narr.note_preferred(preferred_d_room)

    if preferred_d_room is not None:
        occupant_id = grid.get_room_occupant(gen_week, day, period, preferred_d_room)

        if occupant_id is None:
            moved_own_room = slot.assigned_room_id is not None
            grid.assign_room(gen_week, day, period, doctor_id, preferred_d_room)
            narr.preferred_room_free(preferred_d_room, moved_own_room)
            return issues

        protected, why = _protection(context, grid, occupant_id, gen_week, day, period)
        if not protected:
            issues.extend(_evict_and_place(
                context, grid, counters, narr, doctor_id, occupant_id,
                preferred_d_room, gen_week, day, period,
                "preferred room, occupant displaced",
                narr.preferred_room_eviction(occupant_id, preferred_d_room),
            ))
            return issues
        # Protected occupant: fall through to the fallback sweep.
        narr.note_preferred_blocked(preferred_d_room, occupant_id, why)

    # Fallback sweep, pass A: first D room free for *both* periods that
    # day, code descending -- avoids setting up a mid-day room change that
    # the consolidation pass would otherwise have to fix by bumping
    # someone.
    all_day_room = next(
        (rid for rid in d_room_ids_desc if _is_room_free_all_day(grid, gen_week, day, rid)),
        None,
    )
    if all_day_room is not None:
        grid.assign_room(gen_week, day, period, doctor_id, all_day_room)
        narr.sweep_all_day_room(all_day_room)
        return issues

    # Fallback sweep, pass B: first D room free in the current period only.
    free_room = next(
        (rid for rid in d_room_ids_desc if grid.is_room_free(gen_week, day, period, rid)),
        None,
    )
    if free_room is not None:
        grid.assign_room(gen_week, day, period, doctor_id, free_room)
        narr.sweep_period_room(free_room)
        return issues

    # Fallback sweep: evict the lowest-weighted-score Salaried D-room
    # occupant. Trainees and Locums are never sweep victims -- the
    # sweep selects Salaried occupants only, so this
    # was already true for Locum by construction.
    sweep_candidates: list[tuple[int, int]] = []
    for room_id in d_room_ids_desc:
        occupant_id = grid.get_room_occupant(gen_week, day, period, room_id)
        if occupant_id is None:
            continue
        occupant = context.doctor_by_id.get(occupant_id)
        if occupant is None or occupant.doctor_type != DoctorType.SALARIED:
            continue
        occupant_slot = grid.get(occupant_id, gen_week, day, period)
        if occupant_slot is None or occupant_slot.is_on_leave or occupant_slot.role is not None:
            continue
        sweep_candidates.append((occupant_id, room_id))

    if sweep_candidates:
        sweep_candidates.sort(key=lambda c: _room_move_sort_key(context, counters, c[0]))
        evictee_id, d_room_id = sweep_candidates[0]
        issues.extend(_evict_and_place(
            context, grid, counters, narr, doctor_id, evictee_id, d_room_id,
            gen_week, day, period,
            "fallback sweep, lowest weighted room-move score, tie broken on "
            "doctor code",
            narr.sweep_eviction(sweep_candidates, evictee_id),
        ))
        return issues

    # Total failure: role stays applied, no room. Any room the doctor
    # already held (a non-D PRE_ASSIGNED/ADMIN_TIME slot) is left exactly
    # as it was -- this function never calls grid.free_room on the duty
    # doctor's own slot.
    narr.unresolved()
    issues.append(ValidationIssue(
        severity="warning", phase=PHASE, check="duty_no_d_room_available",
        week=gen_week, day=day, period=period,
        message=(
            f"{code} could not secure a D room for duty on "
            f"{date_.isoformat()} {period.value}."
        ),
    ))
    return issues


def _evict_and_place(
    context: GenerationContext, grid: RotaGrid, counters: CounterState,
    narr: narrate.DutyRoomNarrator, duty_doctor_id: int, evictee_id: int,
    d_room_id: int, gen_week: int, day: Day, period: Period,
    stage_desc: str, reason: str | None = None,
) -> list[ValidationIssue]:
    """Evict `evictee_id` from `d_room_id`, relocate them, and seat the duty
    doctor. Eviction is unconditional: the duty doctor takes the room
    regardless of whether the evictee can be rehoused.

    `reason` is the account of *why* this evictee was chosen, built by the
    narrator before the counter moved; the entry written here appends what
    became of them.
    """
    issues: list[ValidationIssue] = []
    evictee = context.doctor_by_id.get(evictee_id)
    evictee_code = _code(context, evictee_id)
    room_code = context.room_by_id[d_room_id].code

    if evictee is not None and evictee.doctor_type in (DoctorType.TRAINEE, DoctorType.LOCUM):
        new_room = find_d_room_only(context, grid, evictee_id, gen_week, day, period)
    else:
        new_room = find_relocation_room(context, grid, evictee_id, gen_week, day, period)

    counters.increment_system(evictee_id, SystemCounterType.ROOM_MOVE)

    if new_room is not None:
        grid.assign_room(gen_week, day, period, evictee_id, new_room)
        grid.assign_room(gen_week, day, period, duty_doctor_id, d_room_id)
        narr.evicted_and_rehoused(
            evictee_id, evictee_code, d_room_id, new_room, stage_desc, reason
        )
    else:
        grid.free_room(gen_week, day, period, evictee_id)
        grid.assign_room(gen_week, day, period, duty_doctor_id, d_room_id)
        issues.append(ValidationIssue(
            severity="warning", phase=PHASE, check="duty_evictee_not_relocated",
            week=gen_week, day=day, period=period,
            message=(
                f"Could not relocate {evictee_code} after displacing them "
                f"from {room_code} for duty doctor {narr.duty_code} on "
                f"{narr.when}; {evictee_code} is left "
                f"without a room."
            ),
        ))
        narr.evicted_without_room(
            evictee_id, evictee_code, d_room_id, stage_desc, reason
        )

    return issues


def _protection(
    context: GenerationContext, grid: RotaGrid, occupant_id: int,
    gen_week: int, day: Day, period: Period,
) -> tuple[bool, str]:
    """`(protected, why)` -- Partner/AHP, or any doctor already holding a
    role (duty or clinic) in this slot, is protected. The role guard is what
    stops primary duty evicting secondary duty, or vice versa, within the
    same session. `why` is only meaningful when `protected` is True.
    """
    occupant = context.doctor_by_id.get(occupant_id)
    if occupant is not None and occupant.doctor_type in (DoctorType.PARTNER, DoctorType.AHP):
        return True, f"protected: {occupant.doctor_type.value}"
    occupant_slot = grid.get(occupant_id, gen_week, day, period)
    if occupant_slot is not None and occupant_slot.role is not None:
        return True, f"protected: already on {occupant_slot.role.value} this session"
    return False, "not protected"


def _other_period(period: Period) -> Period:
    return Period.PM if period == Period.AM else Period.AM


# ---------------------------------------------------------------------------
# Second pass: same-day room consolidation
# ---------------------------------------------------------------------------

def _consolidate_duty_rooms(
    context: GenerationContext, grid: RotaGrid, log: DecisionLog,
) -> None:
    """For each duty row, try to move the duty doctor's other-period slot
    into the same D room they hold for their duty session, so they do not
    have to change rooms mid-day. Runs after every duty row in the run has
    already been given a role and (where possible) a room by the first
    pass, so a doctor's own duty status is always final by the time they
    might be considered for a bump here.

    Never touches ROOM_MOVE: neither the duty doctor's own move nor a
    bumped occupant's move is an eviction in the Phase 4 sense -- both are
    opportunistic and the counter exists to record disruption from being
    displaced by someone else's duty requirement, not from tidying a
    doctor's own day.
    """
    for (date_, period, duty_type), doctor_id in sorted(
        context.duty_map.items(), key=lambda kv: (kv[0][0], kv[0][1].value, kv[0][2].value)
    ):
        genslot = context.date_to_genslot.get(date_)
        if genslot is None:
            continue
        gen_week, day = genslot

        code = _code(context, doctor_id)
        slot = grid.get(doctor_id, gen_week, day, period)
        if slot is None or slot.role is None or slot.assigned_room_id is None:
            continue
        duty_room = context.room_by_id[slot.assigned_room_id]
        if duty_room.room_type != RoomType.D:
            continue

        other_period = _other_period(period)
        other_slot = grid.get(doctor_id, gen_week, day, other_period)
        if other_slot is None or other_slot.is_on_leave:
            continue
        if other_slot.assigned_room_id == duty_room.id:
            continue

        narr = narrate.ConsolidationNarrator(
            context, log, doctor_id, code, gen_week, day, period,
            other_period, date_, duty_type, duty_room,
        )
        occupant_id = grid.get_room_occupant(gen_week, day, other_period, duty_room.id)

        if occupant_id is None:
            grid.assign_room(gen_week, day, other_period, doctor_id, duty_room.id)
            narr.moved_into_free_room()
            continue

        occupant_code = _code(context, occupant_id)
        occupant_slot = grid.get(occupant_id, gen_week, day, other_period)

        if occupant_slot is not None and occupant_slot.role in (
            SessionRole.DUTY_PRIMARY, SessionRole.DUTY_SECONDARY,
        ):
            narr.blocked_by_duty_occupant(
                occupant_id, occupant_code, occupant_slot.role
            )
            continue

        bump_room = find_d_room_only(context, grid, occupant_id, gen_week, day, other_period)
        if bump_room is None:
            narr.occupant_has_nowhere_to_go(occupant_id, occupant_code)
            continue

        grid.assign_room(gen_week, day, other_period, occupant_id, bump_room)
        grid.assign_room(gen_week, day, other_period, doctor_id, duty_room.id)
        narr.moved_with_bump(occupant_id, occupant_code, bump_room)
