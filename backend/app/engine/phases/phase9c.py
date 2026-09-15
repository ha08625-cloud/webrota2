"""Phase 9C -- trainee supervision assignment.

Runs after Phase 5 and *before* Phases 7-9A, so rooms are deliberately not
final coming in: nearly every candidate is still roomless at this point.
For every session with at least one trainee requiring supervision, assigns
a supervisor from the single selectable pool (Partner/Salaried, unclaimed
by any role) by lowest weighted SUPERVISION score, then seats that
supervisor in an SR room. Emits a warning, and leaves the session
unassigned, when no selectable supervisor exists.

Running before the room passes is what makes the SR booking cheap. The SR
room is held back from every other room search in a session that needs a
supervisor (`reserved_sr_room_ids`, consulted by Phases 4 and 5), so an SR
room is free when the booking happens; and because Phases 7-9A run after
this, their four room-placing paths exclude the booked SR room for free --
`grid.is_room_free()` already says no.

Implementation plan decisions this module encodes:
  1. Single supervisor pool -- no duty-helper fallback. A duty helper holds
     role=CLINIC, so the `role is None` criterion excludes them for free;
     no ClinicTypeInfo.category plumbing needed.
  2. No SR-priority fast path. Selection is always by weighted SUPERVISION
     score across the whole selectable pool. Nothing about the pool is
     room-based any more, so there is nothing for such a fast path to key
     on in the first place.
  3. Two predicates, one definition. `is_selectable_supervisor` is what
     the pool is built from here: it has no room criterion at all, because
     at this point in the pipeline a role-free Partner/Salaried doctor only
     holds a room if a PRE_ASSIGNED template row gave them one, and a room
     test would empty the pool in nearly every session.
     `is_eligible_supervisor` adds the D-or-SR room test on top and is used
     by Phase 12, which runs when rooms *are* final. It is defined in terms
     of the first, so the two cannot drift.
  4. The supervisor is moved into SR, overriding a template pin if need be.
     Once chosen, the supervisor is seated in the first free SR room by
     code -- whatever room they were holding, including a PRE_ASSIGNED one,
     is freed. This is the one place in the pipeline where Phase 9C
     overrides a template pin, and the only place it writes a room. Like
     the post-selection swap it replaces, the booking touches neither
     `is_supervising` nor any counter -- ROOM_MOVE included.
  5. `is_supervising` is the only persisted output. The trainee count is
     deliberately NOT persisted -- see `count_supervisable_trainees`.
  6. Trainee counting rule has no room criterion: an off-site (C/W-roomed)
     trainee still counts. This matches GAS and is intended.
  7. `count_supervisable_trainees` and `is_eligible_supervisor` are the
     single shared predicates reused by Phase 12 Check 4, so the assignment
     rule and the validation rule cannot drift apart.

The predicates are module-level public functions for that reason -- do not
inline their logic into `phase12.py`.

One hole in "the supervisor always ends up in SR": a PRE_ASSIGNED template
row naming an SR room claims it in Phase 2, before any reservation can
apply. Phase 0 warns on such a row; here the booking simply finds no free
SR room, leaves the supervisor's room to Pass 3, and Phase 12 flags the
result.

The decision-log prose lives in `_log_phase9c.py`, along with the
supervision-preference multipliers and `supervision_score`: the sort below
imports them back from there so the selection and its explanation cannot
read different numbers.
"""
from __future__ import annotations

from ...models.enums import (
    Day,
    DoctorType,
    MasterSessionType,
    Period,
    RoomType,
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
from . import _log_phase9c as narrate
from ._log_phase9c import PHASE

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
    criterion: holding a role, or sitting in a C/W
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


def is_selectable_supervisor(
    context: GenerationContext, grid: RotaGrid, slot: SessionSlot
) -> bool:
    """True iff `slot` may be *picked* to supervise: Partner/Salaried,
    unclaimed by any role (this excludes duty doctors, clinics, and duty
    helpers, since a duty helper holds role=CLINIC), not on leave, not WFH,
    and not NO_SURGERY/ADMIN_TIME.

    No room criterion, deliberately: this phase runs before Phases 7-9A, so
    a candidate's room is neither assigned yet nor a useful signal -- the
    supervisor is seated in SR by `_book_sr_room` once chosen. See decision
    3 in the module docstring.
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
    return True


def is_eligible_supervisor(context: GenerationContext, grid: RotaGrid, slot: SessionSlot) -> bool:
    """True iff `slot` is a valid supervisor *with rooms as they finally
    stand*: selectable (above) and on-site in a D or SR room.

    Used by Phase 12 Check 4, which runs at the end of the pipeline. It is
    defined in terms of `is_selectable_supervisor` rather than restating
    it, so the selection rule and the validation rule cannot drift.
    """
    if not is_selectable_supervisor(context, grid, slot):
        return False
    if slot.assigned_room_id is None:
        return False
    room = context.room_by_id.get(slot.assigned_room_id)
    if room is None or room.room_type not in _SUPERVISOR_ROOM_TYPES:
        return False
    return True


def reserved_sr_room_ids(
    context: GenerationContext, grid: RotaGrid
) -> dict[tuple[int, Day, Period], int]:
    """The SR room held back for supervision in each session that needs one.

    `(week, day, period) -> room_id` for every session with at least one
    supervisable trainee; sessions without one are absent, so SR stays in
    the ordinary room pools there rather than standing empty. The reserved
    room is the first SR room by code, which is the same one
    `_book_sr_room` takes.

    Computed once, off the Phase 2 grid, and consulted by the phases that
    place doctors before Phase 9C runs (Phase 4's evictee relocation and
    Phase 5's displaced-occupant relocation). The phases that run *after*
    9C need no reservation: the supervisor already occupies the room, so
    `grid.is_room_free()` excludes it.

    One caveat of computing it early: Phase 4 abandons a template WFH slot
    when it applies a duty role, so a trainee WFH slot that Phase 4 turns
    into a working one is not counted here and its session gets no
    reservation. 9C still books an SR room there if one happens to be free.
    """
    sr_rooms = sorted(context.rooms_by_type.get(RoomType.SR, ()), key=lambda r: r.code)
    if not sr_rooms:
        return {}

    num_weeks = max((gw for gw, _day in context.week_dates.keys()), default=0)
    reserved: dict[tuple[int, Day, Period], int] = {}
    for gen_week in range(1, num_weeks + 1):
        for day in _DAYS:
            for period in _PERIODS:
                if count_supervisable_trainees(context, grid, gen_week, day, period) > 0:
                    reserved[(gen_week, day, period)] = sr_rooms[0].id
    return reserved


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
                    if is_selectable_supervisor(context, grid, slot)
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
                    narrate.no_eligible_supervisor(
                        log, context, grid, gen_week, day, period, n
                    )
                    continue

                pool.sort(key=lambda slot: (
                    narrate.supervision_score(context, counters, slot.doctor_id),
                    context.doctor_by_id[slot.doctor_id].code,
                ))
                chosen = pool[0]
                # The entry is composed *before* the counter moves, and only
                # written afterwards: incrementing first would show the
                # winner's post-assignment score, which can read as higher
                # than the runner-up's -- i.e. as though the wrong doctor had
                # been picked.
                message, entry_rationale = narrate.supervisor_selected(
                    context, counters, grid, pool, n, gen_week, day, period,
                )

                chosen.is_supervising = True
                counters.increment_system(chosen.doctor_id, SystemCounterType.SUPERVISION)
                narrate.supervisor_assigned(
                    log, gen_week, day, period, chosen, message, entry_rationale
                )

                _book_sr_room(context, grid, sr_rooms, gen_week, day, period, chosen, log)

    return issues


def _book_sr_room(
    context: GenerationContext,
    grid: RotaGrid,
    sr_rooms,
    gen_week: int,
    day: Day,
    period: Period,
    chosen: SessionSlot,
    log: DecisionLog,
) -> None:
    """Seat `chosen` in the first free SR room by code, freeing whatever
    room they were holding.

    Two no-ops. `chosen` already sitting in an SR room needs no move (they
    are where this would put them). No free SR room at all means a
    PRE_ASSIGNED template row has claimed the only one -- Phase 0 warns on
    that row; here the supervisor is simply left roomless for Pass 3 to
    place and Phase 12 flags the outcome.

    Otherwise the move is unconditional, even when the room being vacated
    is a PRE_ASSIGNED one: overriding that pin is deliberate (decision 4 in
    the module docstring), and is the only template pin Phase 9C overrides.
    It is a pure room write -- neither `is_supervising` nor any counter
    moves here, ROOM_MOVE included, since the doctor is being seated for
    the job they were just given rather than displaced for someone else's.
    """
    previous_room_id = chosen.assigned_room_id
    if previous_room_id is not None and any(r.id == previous_room_id for r in sr_rooms):
        return

    for room in sr_rooms:
        if not grid.is_room_free(gen_week, day, period, room.id):
            continue

        # `assign_room` frees the doctor's previous room first, so a
        # PRE_ASSIGNED room is released by this one call.
        grid.assign_room(gen_week, day, period, chosen.doctor_id, room.id)

        narrate.booked_sr_room(
            log, context, gen_week, day, period, chosen, previous_room_id, room,
        )
        return
