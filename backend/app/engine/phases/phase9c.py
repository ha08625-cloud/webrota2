"""Phase 9C -- trainee supervision assignment.

Runs after Phase 9B (rooms are final coming in; room type drives initial
eligibility) and before Phase 12. For every session with at least one
trainee requiring supervision, assigns a supervisor from the single
eligible pool (Partner/Salaried, in a D or SR room, unclaimed) by lowest
weighted SUPERVISION score. If the selected supervisor is not already
sitting in an SR room, and an SR room is occupied by someone else, the
supervisor is then swapped into that SR room -- this is the one place in
the pipeline where Phase 9C itself writes a room assignment, rather than
only reading the room state Phase 9B left behind. Emits a warning, and
leaves the session unassigned, when no eligible supervisor exists.

Implementation plan decisions this module encodes:
  1. Single supervisor pool -- no duty-helper fallback. A duty helper holds
     role=CLINIC, so `is_eligible_supervisor`'s `role is None` criterion
     excludes them for free; no ClinicTypeInfo.category plumbing needed.
  2. No SR-priority fast path. Selection is always by weighted SUPERVISION
     score across the whole eligible pool -- a doctor already sitting in
     SR competes on the same footing as a doctor sitting in D, rather than
     being auto-assigned ahead of the pool comparison.
  3. Post-selection SR swap. Once the supervisor is chosen, if an SR room
     is occupied by a different doctor, the chosen supervisor is swapped
     into it and the displaced doctor takes the supervisor's vacated room.
     Excluded edge case: if the chosen supervisor is already sitting in an
     SR room, no swap happens. The swap is a pure room move -- it does not
     touch `is_supervising` or the SUPERVISION counter of either doctor
     beyond what selection already set.
  4. `is_supervising` is the only persisted output. The trainee count is
     deliberately NOT persisted -- see `count_supervisable_trainees`.
  5. Trainee counting rule has no room criterion: an off-site (C/W-roomed)
     trainee still counts, even though eligible supervisors are by
     definition on-site (D/SR). This matches GAS and is intended.
  6. `count_supervisable_trainees` and `is_eligible_supervisor` are the
     single shared predicates reused by Phase 12 Check 4, so the assignment
     rule and the validation rule cannot drift apart.

Both predicates are module-level public functions for that reason -- do not
inline their logic into `phase12.py`.
"""
from __future__ import annotations

from ...models.enums import (
    Day,
    DoctorType,
    MasterSessionType,
    Period,
    RoomType,
    SupervisionPreference,
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

PHASE = "phase9c"

_DAYS = (Day.MONDAY, Day.TUESDAY, Day.WEDNESDAY, Day.THURSDAY, Day.FRIDAY)
_PERIODS = (Period.AM, Period.PM)
_EXCLUDED_TEMPLATE_TYPES = frozenset({
    MasterSessionType.NO_SURGERY, MasterSessionType.ADMIN_TIME,
})
_SUPERVISOR_TYPES = (DoctorType.PARTNER, DoctorType.SALARIED)
_SUPERVISOR_ROOM_TYPES = (RoomType.D, RoomType.SR)

# Deprioritises (does not exclude) pool candidates by supervision
# preference. NONE uses a large finite multiplier rather than math.inf so
# that relative ordering between multiple "none"-preference doctors is
# preserved when they are the only candidates left -- math.inf would
# collapse them all to the alphabetical tiebreak regardless of their
# actual supervision history. Applies to every pool candidate now that
# there is no SR-priority fast path to exempt.
_PREFERENCE_MULTIPLIERS = {
    SupervisionPreference.NONE: 1_000_000,
    SupervisionPreference.LESS: 1.5,
    SupervisionPreference.NORMAL: 1.0,
    SupervisionPreference.MORE: 0.66,
}


def count_supervisable_trainees(
    context: GenerationContext, grid: RotaGrid, week: int, day: Day, period: Period
) -> int:
    """Number of trainees in this session who need supervision.

    A trainee counts iff their slot exists, doctor_type == TRAINEE, not on
    leave, not WFH, and template_type is not NO_SURGERY/ADMIN_TIME. No room
    criterion (Decision 5, confirmed): holding a role, or sitting in a C/W
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
                        _PREFERENCE_MULTIPLIERS[context.doctor_by_id[slot.doctor_id].supervision_preference],
                    ),
                    context.doctor_by_id[slot.doctor_id].code,
                ))
                chosen = pool[0]
                chosen.is_supervising = True
                counters.increment_system(chosen.doctor_id, SystemCounterType.SUPERVISION)

                reason = _pool_selection_reason(context, counters, pool)
                log.add(
                    phase=PHASE, action="assign_supervisor",
                    week=gen_week, day=day, period=period, doctor_id=chosen.doctor_id,
                    room_id=chosen.assigned_room_id,
                    message=(
                        f"Assigned {context.doctor_by_id[chosen.doctor_id].code} "
                        f"as supervisor on {day.value} {period.value} from the "
                        f"eligible pool ({reason}) for {n} trainee(s)."
                    ),
                )

                _swap_into_sr(context, grid, sr_rooms, gen_week, day, period, chosen, log)

    return issues


def _pool_selection_reason(
    context: GenerationContext, counters: CounterState, pool: list[SessionSlot],
) -> str:
    """Describe why `pool[0]` was picked over the field, mirroring Phase 5's
    `_selection_reason` but keyed on the SUPERVISION system counter -- the
    pool has no priority-tier concept, so this only ever compares scores.

    If the preference multiplier changed the outcome (the raw, unweighted
    scores would have picked someone else), the message says so explicitly,
    so the generation log never disagrees with what actually happened.
    """
    if len(pool) == 1:
        return "only eligible doctor"

    a, b = pool[0], pool[1]
    mult_a = _PREFERENCE_MULTIPLIERS[context.doctor_by_id[a.doctor_id].supervision_preference]
    mult_b = _PREFERENCE_MULTIPLIERS[context.doctor_by_id[b.doctor_id].supervision_preference]
    score_a = counters.weighted_system_score(
        a.doctor_id, SystemCounterType.SUPERVISION, context.spw_by_id.get(a.doctor_id, 0.0), mult_a,
    )
    score_b = counters.weighted_system_score(
        b.doctor_id, SystemCounterType.SUPERVISION, context.spw_by_id.get(b.doctor_id, 0.0), mult_b,
    )
    if score_a == score_b:
        return "alphabetical tie-break"

    raw_a = counters.weighted_system_score(
        a.doctor_id, SystemCounterType.SUPERVISION, context.spw_by_id.get(a.doctor_id, 0.0),
    )
    raw_b = counters.weighted_system_score(
        b.doctor_id, SystemCounterType.SUPERVISION, context.spw_by_id.get(b.doctor_id, 0.0),
    )
    # a is the winner post-multiplier (score_a < score_b, checked above). If
    # a's raw (unweighted) score was actually higher than b's, the raw order
    # would have picked b -- the multiplier is what flipped the outcome.
    suffix = " (preference-adjusted)" if raw_a > raw_b else ""
    return f"lowest weighted supervision score {score_a:.2f} vs {score_b:.2f}{suffix}"


def _swap_into_sr(
    context: GenerationContext,
    grid: RotaGrid,
    sr_rooms,
    gen_week: int,
    day: Day,
    period: Period,
    chosen: SessionSlot,
    log: DecisionLog,
) -> None:
    """If `chosen` is not already sitting in an SR room, and the (first, by
    room code) occupied SR room holds a different doctor, swap `chosen`
    into that SR room and move the displaced doctor into `chosen`'s
    vacated room.

    Excluded edge case: `chosen` already occupying an SR room is a no-op --
    they are already where the swap would otherwise put them.
    """
    chosen_room_id = chosen.assigned_room_id
    if chosen_room_id is not None and any(r.id == chosen_room_id for r in sr_rooms):
        return

    for room in sr_rooms:
        occupant_id = grid.get_room_occupant(gen_week, day, period, room.id)
        if occupant_id is None or occupant_id == chosen.doctor_id:
            continue

        grid.free_room(gen_week, day, period, chosen.doctor_id)
        grid.free_room(gen_week, day, period, occupant_id)
        grid.assign_room(gen_week, day, period, chosen.doctor_id, room.id)
        if chosen_room_id is not None:
            grid.assign_room(gen_week, day, period, occupant_id, chosen_room_id)

        log.add(
            phase=PHASE, action="swap_supervisor_into_sr",
            week=gen_week, day=day, period=period, doctor_id=chosen.doctor_id,
            room_id=room.id,
            message=(
                f"Swapped {context.doctor_by_id[chosen.doctor_id].code} into SR "
                f"room {room.code} with {context.doctor_by_id[occupant_id].code} "
                f"on {day.value} {period.value} (week {gen_week})."
            ),
        )
        return