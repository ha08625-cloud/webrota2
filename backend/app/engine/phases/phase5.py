"""Phase 5 -- clinic type assignment, including room_required resolution.

For each enabled clinic type (already ordered by clinic_priority ascending
in the context), each of its schedule slots, and each generation week: pick
an eligible doctor, assign them the clinic role, resolve a room if the
clinic requires one, and increment their shared clinic counter.

Iteration order is clinic type -> schedule -> generation week (schedule
outer, week inner), per the M2 plan -- this matters because the counter
selection for later iterations depends on increments made by earlier ones.
"""
from __future__ import annotations

from ...models.enums import MasterSessionType, RoomType, SessionRole
from ..datatypes import (
    ClinicDoctorEligibility,
    ClinicTypeInfo,
    CounterState,
    DecisionLog,
    GenerationContext,
    RotaGrid,
    ValidationIssue,
)

PHASE = "phase5"

_EXCLUDED_TEMPLATE_TYPES = frozenset({
    MasterSessionType.NO_SURGERY, MasterSessionType.ADMIN_TIME,
})


def run_phase5(
    context: GenerationContext, grid: RotaGrid, counters: CounterState, log: DecisionLog
) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    clinic_priority_by_id = {ct.id: ct.clinic_priority for ct in context.clinic_types}
    num_weeks = max((gw for gw, _day in context.week_dates.keys()), default=0)

    for clinic in context.clinic_types:  # already ordered by clinic_priority asc, id asc
        for schedule in clinic.schedules:  # already ordered by weekday, period
            day, period = schedule.day, schedule.period
            for gen_week in range(1, num_weeks + 1):
                date_ = context.week_dates.get((gen_week, day))
                if date_ is None:
                    continue  # defensive: should always be present for 1..num_weeks
                if date_ in context.closed_dates:
                    # M5: no slots exist here (Phase 2 built none), so there
                    # is nothing to assign and no warning to raise -- unlike
                    # a genuinely uncovered slot, a closed date is expected
                    # to have zero coverage.
                    continue

                eligible = _eligible_doctors(context, grid, clinic, gen_week, day, period)
                if not eligible:
                    issues.append(ValidationIssue(
                        severity="warning", phase=PHASE, check="no_eligible_doctor",
                        week=gen_week, day=day, period=period,
                        message=(
                            f"No eligible doctor for clinic '{clinic.name}' on "
                            f"{date_.isoformat()} {period.value}."
                        ),
                    ))
                    continue

                eligible.sort(key=lambda e: (
                    e.doctor_priority,
                    counters.weighted_clinic_score(
                        e.doctor_id, clinic.id, context.spw_by_id.get(e.doctor_id, 0.0)
                    ),
                    context.doctor_by_id[e.doctor_id].code,
                ))
                doctor_id = eligible[0].doctor_id

                slot = grid.get(doctor_id, gen_week, day, period)
                slot.clinic_type_id = clinic.id
                slot.role = SessionRole.CLINIC

                if clinic.room_required:
                    room_issue = _resolve_room(
                        context, grid, clinic, doctor_id, gen_week, day, period,
                        clinic_priority_by_id, log,
                    )
                    if room_issue is not None:
                        issues.append(room_issue)

                counters.increment_clinic(doctor_id, clinic.id)

    return issues


def _eligible_doctors(
    context: GenerationContext,
    grid: RotaGrid,
    clinic: ClinicTypeInfo,
    gen_week: int,
    day,
    period,
) -> list[ClinicDoctorEligibility]:
    result = []
    for elig in clinic.doctor_eligibilities:
        doctor = context.doctor_by_id.get(elig.doctor_id)
        if doctor is None or not doctor.active:
            continue
        slot = grid.get(elig.doctor_id, gen_week, day, period)
        if slot is None:
            continue  # no template session for this doctor at this slot
        if slot.is_on_leave or slot.is_wfh:
            continue
        if slot.template_type in _EXCLUDED_TEMPLATE_TYPES:
            continue
        if slot.role is not None:
            continue  # already on duty or assigned an earlier-tier clinic
        result.append(elig)
    return result


def _resolve_room(
    context: GenerationContext,
    grid: RotaGrid,
    clinic: ClinicTypeInfo,
    doctor_id: int,
    gen_week: int,
    day,
    period,
    clinic_priority_by_id: dict[int, int],
    log: DecisionLog,
) -> ValidationIssue | None:
    eligible_room_ids = sorted(clinic.eligible_room_ids)

    current_room = grid.get_doctor_room(gen_week, day, period, doctor_id)
    if current_room is not None and current_room in clinic.eligible_room_ids:
        return None  # already in an eligible room

    for room_id in eligible_room_ids:
        if grid.is_room_free(gen_week, day, period, room_id):
            grid.assign_room(gen_week, day, period, doctor_id, room_id)
            return None

    for room_id in eligible_room_ids:
        occupant_id = grid.get_room_occupant(gen_week, day, period, room_id)
        if occupant_id is None:
            continue  # defensive: none were free above, so this shouldn't occur
        if not _is_displaceable(
            context, grid, clinic_priority_by_id, occupant_id, gen_week, day, period,
            clinic.clinic_priority,
        ):
            continue

        exclude_d = context.room_by_id[room_id].room_type == RoomType.D
        new_room = _best_free_preferred_room(
            context, grid, occupant_id, gen_week, day, period, exclude_d=exclude_d,
        )
        if new_room is None:
            continue  # this candidate room's occupant has nowhere to go; try the next

        grid.assign_room(gen_week, day, period, occupant_id, new_room)
        grid.assign_room(gen_week, day, period, doctor_id, room_id)
        return None

    doctor = context.doctor_by_id.get(doctor_id)
    code = doctor.code if doctor is not None else f"id={doctor_id}"
    return ValidationIssue(
        severity="warning", phase=PHASE, check="clinic_room_unresolved",
        week=gen_week, day=day, period=period,
        message=(
            f"Could not find or free an eligible room for {code} on clinic "
            f"'{clinic.name}'; left in their current room."
        ),
    )


def _is_displaceable(
    context: GenerationContext,
    grid: RotaGrid,
    clinic_priority_by_id: dict[int, int],
    occupant_id: int,
    gen_week: int,
    day,
    period,
    current_clinic_priority: int,
) -> bool:
    slot = grid.get(occupant_id, gen_week, day, period)
    if slot is None:
        return False
    if slot.is_on_leave:
        return False
    if slot.role in (SessionRole.DUTY_PRIMARY, SessionRole.DUTY_SECONDARY):
        return False
    if slot.role == SessionRole.CLINIC:
        occupant_priority = clinic_priority_by_id.get(slot.clinic_type_id)
        if occupant_priority is not None and occupant_priority < current_clinic_priority:
            return False  # protected: occupant's clinic is higher priority (lower number)
    return True


def _best_free_preferred_room(
    context: GenerationContext,
    grid: RotaGrid,
    doctor_id: int,
    gen_week: int,
    day,
    period,
    exclude_d: bool,
) -> int | None:
    for room_id in context.preferred_rooms_by_doctor.get(doctor_id, ()):
        if exclude_d and context.room_by_id[room_id].room_type == RoomType.D:
            continue
        if grid.is_room_free(gen_week, day, period, room_id):
            return room_id
    return None