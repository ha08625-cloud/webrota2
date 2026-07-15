"""Phase 9C -- trainee supervision assignment.

Runs after Phase 9B (rooms are final by then; room type drives eligibility)
and before Phase 12. For every session with at least one trainee requiring
supervision, assigns a supervisor: the SR-room occupant if eligible,
otherwise the eligible Partner/Salaried doctor with the lowest weighted
SUPERVISION score (alphabetical tiebreak). Emits a warning, and leaves the
session unassigned, when no eligible supervisor exists.

Implementation plan decisions this module encodes:
  1. Single supervisor pool -- no duty-helper fallback. A duty helper holds
     role=CLINIC, so `is_eligible_supervisor`'s `role is None` criterion
     excludes them for free; no ClinicTypeInfo.category plumbing needed.
  2. The SR-priority doctor's SUPERVISION counter IS incremented, same as a
     pool-selected doctor -- the counter means "times supervised", full
     stop, unlike the original GAS behaviour which favoured SR occupants.
  3. `is_supervising` is the only persisted output. The trainee count is
     deliberately NOT persisted -- see `count_supervisable_trainees`.
  4. Trainee counting rule has no room criterion: an off-site (C/W-roomed)
     trainee still counts, even though eligible supervisors are by
     definition on-site (D/SR). This matches GAS and is intended.
  5. `count_supervisable_trainees` and `is_eligible_supervisor` are the
     single shared predicates reused by Phase 12 Check 4, so the assignment
     rule and the validation rule cannot drift apart.

Both predicates are module-level public functions for that reason -- do not
inline their logic into `phase12.py`.
"""
from __future__ import annotations

from ...models.enums import Day, DoctorType, MasterSessionType, Period, RoomType, SystemCounterType
from ..datatypes import (
    CounterState,
    DecisionLog,
    GenerationContext,
    RotaGrid,
    SessionSlot,
    ValidationIssue,
)

PHASE = "phase9c"

_DAYS = (Day.MONDAY, Day.TUESDAY, Day.WEDNESDAY, Day.THURSDAY, Day.FRIDAY)
_PERIODS = (Period.AM, Period.PM)
_EXCLUDED_TEMPLATE_TYPES = frozenset({
    MasterSessionType.NO_SURGERY, MasterSessionType.ADMIN_TIME,
})
_SUPERVISOR_TYPES = (DoctorType.PARTNER, DoctorType.SALARIED)
_SUPERVISOR_ROOM_TYPES = (RoomType.D, RoomType.SR)


def count_supervisable_trainees(
    context: GenerationContext, grid: RotaGrid, week: int, day: Day, period: Period
) -> int:
    """Number of trainees in this session who need supervision.

    A trainee counts iff their slot exists, doctor_type == TRAINEE, not on
    leave, not WFH, and template_type is not NO_SURGERY/ADMIN_TIME. No room
    criterion (Decision 4, confirmed): holding a role, or sitting in a C/W
    room, does not remove the need for supervision.
    """
    count = 0
    for slot in grid.sessions_for_slot(week, day, period):
        doctor = context.doctor_by_id.get(slot.doctor_id)
        if doctor is None or doctor.doctor_type != DoctorType.TRAINEE:
            continue
        if slot.is_on_leave or slot.is_wfh:
            continue
        if slot.template_type in _EXCLUDED_TEMPLATE_TYPES:
            continue
        count += 1
    return count


def is_eligible_supervisor(context: GenerationContext, grid: RotaGrid, slot: SessionSlot) -> bool:
    """True iff `slot` may supervise: Partner/Salaried, unclaimed by any
    role (this excludes duty doctors, clinics, and -- per Decision 1 --
    duty helpers, since a duty helper holds role=CLINIC), not on leave, not
    WFH, not NO_SURGERY/ADMIN_TIME, and on-site in a D or SR room.
    """
    doctor = context.doctor_by_id.get(slot.doctor_id)
    if doctor is None or doctor.doctor_type not in _SUPERVISOR_TYPES:
        return False
    if slot.role is not None:
        return False
    if slot.is_on_leave or slot.is_wfh:
        return False
    if slot.template_type in _EXCLUDED_TEMPLATE_TYPES:
        return False
    if slot.assigned_room_id is None:
        return False
    room = context.room_by_id.get(slot.assigned_room_id)
    if room is None or room.room_type not in _SUPERVISOR_ROOM_TYPES:
        return False
    return True


def run_phase9c(
    context: GenerationContext, grid: RotaGrid, counters: CounterState, log: DecisionLog
) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    num_weeks = max((gw for gw, _day in context.week_dates.keys()), default=0)
    # Fixed deterministic order; the schema does not constrain SR to one
    # room even though the seed currently has exactly one.
    sr_rooms = sorted(context.rooms_by_type.get(RoomType.SR, ()), key=lambda r: r.code)

    for gen_week in range(1, num_weeks + 1):
        for day in _DAYS:
            for period in _PERIODS:
                n = count_supervisable_trainees(context, grid, gen_week, day, period)
                if n == 0:
                    continue

                if _assign_sr_priority(context, grid, counters, sr_rooms, gen_week, day, period, log):
                    continue

                pool = [
                    slot for slot in grid.sessions_for_slot(gen_week, day, period)
                    if is_eligible_supervisor(context, grid, slot)
                ]
                if not pool:
                    issues.append(ValidationIssue(
                        severity="warning", phase=PHASE, check="supervision_unassignable",
                        week=gen_week, day=day, period=period,
                        message=(
                            f"No eligible supervisor available on {day.value} {period.value} "
                            f"(week {gen_week}) for {n} trainee(s) requiring supervision."
                        ),
                    ))
                    continue

                pool.sort(key=lambda slot: (
                    counters.weighted_system_score(
                        slot.doctor_id, SystemCounterType.SUPERVISION,
                        context.spw_by_id.get(slot.doctor_id, 0.0),
                    ),
                    context.doctor_by_id[slot.doctor_id].code,
                ))
                chosen = pool[0]
                chosen.is_supervising = True
                counters.increment_system(chosen.doctor_id, SystemCounterType.SUPERVISION)

    return issues


def _assign_sr_priority(
    context: GenerationContext,
    grid: RotaGrid,
    counters: CounterState,
    sr_rooms,
    gen_week: int,
    day: Day,
    period: Period,
    log: DecisionLog,
) -> bool:
    """Assign the SR occupant if eligible. Returns True if assigned."""
    for room in sr_rooms:
        occupant_id = grid.get_room_occupant(gen_week, day, period, room.id)
        if occupant_id is None:
            continue
        slot = grid.get(occupant_id, gen_week, day, period)
        if slot is None:
            continue  # defensive: occupancy index and grid disagree
        if is_eligible_supervisor(context, grid, slot):
            slot.is_supervising = True
            counters.increment_system(occupant_id, SystemCounterType.SUPERVISION)
            return True
    return False