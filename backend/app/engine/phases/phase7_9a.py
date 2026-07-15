"""Phases 7-9A -- resolve remaining REQUIRES_ROOM slots after Phase 5.

Three passes over every doctor whose REQUIRES_ROOM slot still has
`assigned_room_id is None`:

  Pass 1 (full-day Trainee/AHP): a Trainee/AHP needing the same D room for
    both AM and PM of a day. Prefer a room free in both sessions; failing
    that, displace a full-day Partner/Salaried D-room occupant.
  Pass 2 (single-session Trainee/AHP): the same, per remaining individual
    session -- covers slots Pass 1 couldn't resolve as a full day, and
    slots that only ever needed a single session.
  Pass 3 (Partner/Salaried fallback): no displacement -- walk the doctor's
    own preference list and take the first free room.

Displacing a Partner/Salaried doctor (Pass 1/2) follows the full "Room
Preference Assignment" algorithm from algorithms.md: preferred list first,
then any free room of an eligible non-D type (C, W, SR) as a fallback. Pass
3 does not get this fallback -- it is not displacement, and the plan is
explicit that a Pass-3 doctor only ever tries their own preference list.

Known gap, flagged for Phase 12 (next step): a doctor on leave still gets a
REQUIRES_ROOM `SessionSlot` from Phase 2 (the template says they'd need a
room if working), but this module skips leave slots entirely -- they never
get a room and are not treated as failures. Phase 12 Check 3 ("no
unresolved REQUIRES_ROOM slot") must exclude on-leave slots too, or every
leave day will read as a validation failure.
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
from ..datatypes import CounterState, DecisionLog, GenerationContext, RotaGrid, ValidationIssue

PHASE = "phase7_9a"

_DAYS = (Day.MONDAY, Day.TUESDAY, Day.WEDNESDAY, Day.THURSDAY, Day.FRIDAY)
_PERIODS = (Period.AM, Period.PM)
_DISPLACEABLE_TYPES = (DoctorType.PARTNER, DoctorType.SALARIED)
_ROOM_MOVE_FALLBACK_TYPES = (RoomType.C, RoomType.W, RoomType.SR)


def run_phase7_to_9a(
    context: GenerationContext, grid: RotaGrid, counters: CounterState, log: DecisionLog
) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    num_weeks = max((gw for gw, _day in context.week_dates.keys()), default=0)
    d_room_ids = sorted(r.id for r in context.rooms_by_type.get(RoomType.D, ()))

    for gen_week in range(1, num_weeks + 1):
        for day in _DAYS:
            issues.extend(_pass1_full_day(context, grid, counters, gen_week, day, d_room_ids, log))

    for gen_week in range(1, num_weeks + 1):
        for day in _DAYS:
            for period in _PERIODS:
                issues.extend(
                    _pass2_single_session(context, grid, counters, gen_week, day, period, d_room_ids, log)
                )

    for gen_week in range(1, num_weeks + 1):
        for day in _DAYS:
            for period in _PERIODS:
                issues.extend(_pass3_partner_salaried_fallback(context, grid, gen_week, day, period, log))

    return issues


# ---------------------------------------------------------------------------
# Pass 1: full-day Trainee/AHP
# ---------------------------------------------------------------------------

def _pass1_full_day(
    context: GenerationContext, grid: RotaGrid, counters: CounterState,
    gen_week: int, day: Day, d_room_ids: list[int], log: DecisionLog,
) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    candidates = _full_day_candidates(context, grid, gen_week, day)

    for doctor_id in candidates:
        am_slot = grid.get(doctor_id, gen_week, day, Period.AM)
        pm_slot = grid.get(doctor_id, gen_week, day, Period.PM)
        if am_slot.assigned_room_id is not None or pm_slot.assigned_room_id is not None:
            continue  # already resolved earlier in this pass

        free_room = _first_free_room_both(grid, gen_week, day, d_room_ids)
        if free_room is not None:
            grid.assign_room(gen_week, day, Period.AM, doctor_id, free_room)
            grid.assign_room(gen_week, day, Period.PM, doctor_id, free_room)
            continue

        candidate = _find_full_day_displacement(context, grid, counters, gen_week, day, d_room_ids)
        if candidate is None:
            issues.append(_warning(
                "no_full_day_room", gen_week, day, None,
                f"No free or displaceable D room for {_code(context, doctor_id)} "
                f"(full day) on {day.value}.",
            ))
            continue

        displaced_id, d_room_id = candidate
        new_room = _best_available_room(
            context, grid, displaced_id, gen_week, day, periods=(Period.AM, Period.PM),
        )
        if new_room is None:
            issues.append(_warning(
                "no_full_day_room", gen_week, day, None,
                f"Could not relocate {_code(context, displaced_id)} to free a D "
                f"room for {_code(context, doctor_id)} (full day) on {day.value}.",
            ))
            continue

        grid.assign_room(gen_week, day, Period.AM, displaced_id, new_room)
        grid.assign_room(gen_week, day, Period.PM, displaced_id, new_room)
        grid.assign_room(gen_week, day, Period.AM, doctor_id, d_room_id)
        grid.assign_room(gen_week, day, Period.PM, doctor_id, d_room_id)
        counters.increment_system(displaced_id, SystemCounterType.ROOM_MOVE)  # once, not twice

    return issues


def _full_day_candidates(
    context: GenerationContext, grid: RotaGrid, gen_week: int, day: Day
) -> list[int]:
    result = []
    for doctor in context.doctors:  # already ordered by code
        if doctor.doctor_type not in (DoctorType.TRAINEE, DoctorType.AHP):
            continue
        am_slot = grid.get(doctor.id, gen_week, day, Period.AM)
        pm_slot = grid.get(doctor.id, gen_week, day, Period.PM)
        if am_slot is None or pm_slot is None:
            continue
        if am_slot.is_on_leave or pm_slot.is_on_leave:
            continue
        if am_slot.template_type != MasterSessionType.REQUIRES_ROOM:
            continue
        if pm_slot.template_type != MasterSessionType.REQUIRES_ROOM:
            continue
        if am_slot.assigned_room_id is not None or pm_slot.assigned_room_id is not None:
            continue
        result.append(doctor.id)
    return result


def _find_full_day_displacement(
    context: GenerationContext, grid: RotaGrid, counters: CounterState,
    gen_week: int, day: Day, d_room_ids: list[int],
) -> tuple[int, int] | None:
    candidates: list[tuple[int, int]] = []
    for room_id in d_room_ids:
        occ_am = grid.get_room_occupant(gen_week, day, Period.AM, room_id)
        occ_pm = grid.get_room_occupant(gen_week, day, Period.PM, room_id)
        if occ_am is None or occ_am != occ_pm:
            continue
        if not _is_displaceable_full_day(context, grid, occ_am, gen_week, day):
            continue
        candidates.append((occ_am, room_id))

    if not candidates:
        return None

    candidates.sort(key=lambda c: _room_move_sort_key(context, counters, c[0]))
    return candidates[0]


def _is_displaceable_full_day(
    context: GenerationContext, grid: RotaGrid, doctor_id: int, gen_week: int, day: Day
) -> bool:
    doctor = context.doctor_by_id.get(doctor_id)
    if doctor is None or doctor.doctor_type not in _DISPLACEABLE_TYPES:
        return False
    am_slot = grid.get(doctor_id, gen_week, day, Period.AM)
    pm_slot = grid.get(doctor_id, gen_week, day, Period.PM)
    if am_slot is None or pm_slot is None:
        return False
    if am_slot.is_on_leave or pm_slot.is_on_leave:
        return False
    if am_slot.role is not None or pm_slot.role is not None:
        return False
    return True


# ---------------------------------------------------------------------------
# Pass 2: single-session Trainee/AHP
# ---------------------------------------------------------------------------

def _pass2_single_session(
    context: GenerationContext, grid: RotaGrid, counters: CounterState,
    gen_week: int, day: Day, period: Period, d_room_ids: list[int], log: DecisionLog,
) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    candidates = _single_session_candidates(context, grid, gen_week, day, period)

    for doctor_id in candidates:
        slot = grid.get(doctor_id, gen_week, day, period)
        if slot.assigned_room_id is not None:
            continue  # defensive: pass 1 only ever resolves both sessions or neither

        free_room = _first_free_room_single(grid, gen_week, day, period, d_room_ids)
        if free_room is not None:
            grid.assign_room(gen_week, day, period, doctor_id, free_room)
            continue

        candidate = _find_single_session_displacement(
            context, grid, counters, gen_week, day, period, d_room_ids,
        )
        if candidate is None:
            issues.append(_warning(
                "no_single_session_room", gen_week, day, period,
                f"No free or displaceable D room for {_code(context, doctor_id)} "
                f"on {day.value} {period.value}.",
            ))
            continue

        displaced_id, d_room_id = candidate
        new_room = _best_available_room(
            context, grid, displaced_id, gen_week, day, periods=(period,),
        )
        if new_room is None:
            issues.append(_warning(
                "no_single_session_room", gen_week, day, period,
                f"Could not relocate {_code(context, displaced_id)} to free a D "
                f"room for {_code(context, doctor_id)} on {day.value} {period.value}.",
            ))
            continue

        grid.assign_room(gen_week, day, period, displaced_id, new_room)
        grid.assign_room(gen_week, day, period, doctor_id, d_room_id)
        counters.increment_system(displaced_id, SystemCounterType.ROOM_MOVE)

    return issues


def _single_session_candidates(
    context: GenerationContext, grid: RotaGrid, gen_week: int, day: Day, period: Period
) -> list[int]:
    result = []
    for doctor in context.doctors:
        if doctor.doctor_type not in (DoctorType.TRAINEE, DoctorType.AHP):
            continue
        slot = grid.get(doctor.id, gen_week, day, period)
        if slot is None or slot.is_on_leave:
            continue
        if slot.template_type != MasterSessionType.REQUIRES_ROOM:
            continue
        if slot.assigned_room_id is not None:
            continue
        result.append(doctor.id)
    return result


def _find_single_session_displacement(
    context: GenerationContext, grid: RotaGrid, counters: CounterState,
    gen_week: int, day: Day, period: Period, d_room_ids: list[int],
) -> tuple[int, int] | None:
    candidates: list[tuple[int, int]] = []
    for room_id in d_room_ids:
        occ = grid.get_room_occupant(gen_week, day, period, room_id)
        if occ is None:
            continue
        if not _is_displaceable_single(context, grid, occ, gen_week, day, period):
            continue
        candidates.append((occ, room_id))

    if not candidates:
        return None

    candidates.sort(key=lambda c: _room_move_sort_key(context, counters, c[0]))
    return candidates[0]


def _is_displaceable_single(
    context: GenerationContext, grid: RotaGrid, doctor_id: int,
    gen_week: int, day: Day, period: Period,
) -> bool:
    doctor = context.doctor_by_id.get(doctor_id)
    if doctor is None or doctor.doctor_type not in _DISPLACEABLE_TYPES:
        return False
    slot = grid.get(doctor_id, gen_week, day, period)
    if slot is None or slot.is_on_leave or slot.role is not None:
        return False
    return True


# ---------------------------------------------------------------------------
# Pass 3: Partner/Salaried fallback (no displacement)
# ---------------------------------------------------------------------------

def _pass3_partner_salaried_fallback(
    context: GenerationContext, grid: RotaGrid, gen_week: int, day: Day, period: Period,
    log: DecisionLog,
) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    for doctor in context.doctors:
        if doctor.doctor_type not in _DISPLACEABLE_TYPES:
            continue
        slot = grid.get(doctor.id, gen_week, day, period)
        if slot is None or slot.is_on_leave:
            continue
        if slot.template_type != MasterSessionType.REQUIRES_ROOM:
            continue
        if slot.assigned_room_id is not None:
            continue

        chosen = None
        for room_id in context.preferred_rooms_by_doctor.get(doctor.id, ()):
            if grid.is_room_free(gen_week, day, period, room_id):
                chosen = room_id
                break

        if chosen is None:
            issues.append(_warning(
                "no_partner_salaried_room", gen_week, day, period,
                f"No free preferred room for {doctor.code} on {day.value} "
                f"{period.value}; slot remains unresolved.",
            ))
            continue

        grid.assign_room(gen_week, day, period, doctor.id, chosen)

    return issues


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _first_free_room_both(grid: RotaGrid, gen_week: int, day: Day, room_ids: list[int]) -> int | None:
    for room_id in room_ids:
        if grid.is_room_free(gen_week, day, Period.AM, room_id) and \
           grid.is_room_free(gen_week, day, Period.PM, room_id):
            return room_id
    return None


def _first_free_room_single(
    grid: RotaGrid, gen_week: int, day: Day, period: Period, room_ids: list[int]
) -> int | None:
    for room_id in room_ids:
        if grid.is_room_free(gen_week, day, period, room_id):
            return room_id
    return None


def _best_available_room(
    context: GenerationContext, grid: RotaGrid, doctor_id: int,
    gen_week: int, day: Day, periods: tuple[Period, ...],
) -> int | None:
    """The room-preference-assignment algorithm for a displaced doctor.

    Tries the doctor's own preferred rooms first (skipping D rooms -- they
    were just displaced *out* of a D room), then falls back to any free
    room of an eligible non-D type (C, W, SR). The room must be free in
    every period in `periods` simultaneously (both AM and PM for a
    full-day displacement, or just the one period for a single-session
    displacement).
    """
    def _free_in_all(room_id: int) -> bool:
        return all(grid.is_room_free(gen_week, day, p, room_id) for p in periods)

    for room_id in context.preferred_rooms_by_doctor.get(doctor_id, ()):
        if context.room_by_id[room_id].room_type == RoomType.D:
            continue
        if _free_in_all(room_id):
            return room_id

    fallback_ids = sorted(
        r.id for r in context.rooms if r.room_type in _ROOM_MOVE_FALLBACK_TYPES
    )
    for room_id in fallback_ids:
        if _free_in_all(room_id):
            return room_id

    return None


def _room_move_sort_key(context: GenerationContext, counters: CounterState, doctor_id: int):
    spw = context.spw_by_id.get(doctor_id, 0.0)
    score = counters.weighted_system_score(doctor_id, SystemCounterType.ROOM_MOVE, spw)
    code = context.doctor_by_id[doctor_id].code
    return (score, code)


def _code(context: GenerationContext, doctor_id: int) -> str:
    doctor = context.doctor_by_id.get(doctor_id)
    return doctor.code if doctor is not None else f"id={doctor_id}"


def _warning(check: str, week: int, day: Day, period: Period | None, message: str) -> ValidationIssue:
    return ValidationIssue(
        severity="warning", phase=PHASE, check=check,
        week=week, day=day, period=period, message=message,
    )