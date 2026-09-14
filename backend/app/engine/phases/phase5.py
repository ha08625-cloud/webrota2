"""Phase 5 -- clinic type assignment, including room_required resolution.

For each enabled clinic type (already ordered by clinic_priority ascending
in the context), each of its schedule slots, and each generation week: pick
an eligible doctor, assign them the clinic role, resolve a room if the
clinic requires one, and increment their shared clinic counter.

Iteration order is clinic type -> schedule -> generation week (schedule
outer, week inner), per the M2 plan -- this matters because the counter
selection for later iterations depends on increments made by earlier ones.

Every entry this phase logs carries a `rationale` replaying the selection
stage by stage: the eligible field with each doctor's tier and weighted
counter, the doctors excluded from it and why, the top tier, the counter
comparison within that tier, and the stage that actually decided. The
room-resolution entries do the same for the clinic's eligible room list.
All of that prose lives in `_log_phase5.py` -- including
`displaceability`, which this phase's own search calls, because its
"why not" half exists only for the log.
"""
from __future__ import annotations

from dataclasses import dataclass

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
from . import _log_phase5 as narrate
from ._log_phase5 import PHASE, clinic_name as _clinic_name
from ._shared import code as _code

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
                if (date_, period) in context.closed_slots:
                    # M5: no slots exist here (Phase 2 built none), so there
                    # is nothing to assign and no warning to raise -- unlike
                    # a genuinely uncovered slot, a closed date is expected
                    # to have zero coverage.
                    narrate.skipped_closed_date(
                        log, gen_week, day, period, clinic, date_
                    )
                    continue

                eligible, excluded = _eligible_doctors(
                    context, grid, clinic, gen_week, day, period
                )
                if not eligible:
                    issues.append(ValidationIssue(
                        severity="warning", phase=PHASE, check="no_eligible_doctor",
                        week=gen_week, day=day, period=period,
                        message=(
                            f"No eligible doctor for clinic '{clinic.name}' on "
                            f"{date_.isoformat()} {period.value}."
                        ),
                    ))
                    narrate.no_eligible_doctor(
                        log, gen_week, day, period, clinic, date_, excluded
                    )
                    continue

                # One scored, sorted field drives both the assignment and
                # its explanation, so the log can never disagree with what
                # the sort actually did.
                candidates = _score_candidates(context, counters, clinic, eligible)
                candidates.sort(key=lambda c: (c.tier, c.weighted, c.code))
                doctor_id = candidates[0].doctor_id

                slot = grid.get(doctor_id, gen_week, day, period)
                slot.clinic_type_id = clinic.id
                slot.role = SessionRole.CLINIC

                narrate.clinic_assigned(
                    log, context, gen_week, day, period, clinic, date_,
                    candidates, excluded,
                )

                if clinic.room_required:
                    room_issue = _resolve_room(
                        context, grid, clinic, doctor_id, gen_week, day, period,
                        clinic_priority_by_id, log,
                    )
                    if room_issue is not None:
                        issues.append(room_issue)

                counters.increment_clinic(doctor_id, clinic.id)

    return issues


@dataclass(frozen=True)
class _Candidate:
    """One eligible doctor with everything the sort key looks at, resolved
    once so the assignment and its rationale read the same numbers."""
    doctor_id: int
    code: str
    tier: int
    raw: int
    spw: float
    weighted: float
    balance: float = 0.0


def _score_candidates(
    context: GenerationContext,
    counters: CounterState,
    clinic: ClinicTypeInfo,
    eligible: list[ClinicDoctorEligibility],
) -> list[_Candidate]:
    return [
        _Candidate(
            doctor_id=elig.doctor_id,
            code=_code(context, elig.doctor_id),
            tier=elig.doctor_priority,
            raw=counters.clinic.get((elig.doctor_id, clinic.id), 0),
            spw=context.spw_by_id.get(elig.doctor_id, 0.0),
            weighted=counters.weighted_clinic_score(
                elig.doctor_id, clinic.id, context.spw_by_id.get(elig.doctor_id, 0.0)
            ),
            balance=counters.clinic_opening_balance(elig.doctor_id, clinic.id),
        )
        for elig in eligible
    ]


def _eligible_doctors(
    context: GenerationContext,
    grid: RotaGrid,
    clinic: ClinicTypeInfo,
    gen_week: int,
    day,
    period,
) -> tuple[list[ClinicDoctorEligibility], list[tuple[str, str]]]:
    """`(eligible, excluded)` -- the doctors configured for this clinic type
    that can take this slot, and `(code, reason)` for each that cannot.

    The exclusion reasons are the phase's own filter conditions, in the
    order they are applied, and exist purely for the decision log: "why
    wasn't Dr X considered for this clinic" is the question the log could
    not previously answer. The list is bounded by the clinic type's
    configured eligibility list, not by the whole practice.
    """
    result = []
    excluded: list[tuple[str, str]] = []
    for elig in clinic.doctor_eligibilities:
        doctor = context.doctor_by_id.get(elig.doctor_id)
        if doctor is None or not doctor.active:
            excluded.append((_code(context, elig.doctor_id), "inactive or unknown doctor"))
            continue
        code = doctor.code
        slot = grid.get(elig.doctor_id, gen_week, day, period)
        if slot is None:
            excluded.append((code, "does not work this session in the template"))
            continue
        if slot.is_on_leave:
            excluded.append((code, "on leave"))
            continue
        if slot.is_wfh:
            excluded.append((code, "working from home"))
            continue
        if slot.template_type in _EXCLUDED_TEMPLATE_TYPES:
            excluded.append((code, f"template session is {slot.template_type.value}"))
            continue
        if slot.role is not None:
            # Already on duty or assigned a higher-priority clinic earlier
            # in this phase -- name which, since "already has a role" on its
            # own does not say whether duty or clinic ordering caused it.
            held = slot.role.value
            if slot.clinic_type_id is not None:
                held = f"{held} ({_clinic_name(context, slot.clinic_type_id)})"
            excluded.append((code, f"already assigned {held} this session"))
            continue
        result.append(elig)
    return result, excluded


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
    narr = narrate.ClinicRoomNarrator(
        context, grid, log, clinic, doctor_id, gen_week, day, period,
        eligible_room_ids, clinic_priority_by_id,
    )

    current_room = grid.get_doctor_room(gen_week, day, period, doctor_id)
    if current_room is not None and current_room in clinic.eligible_room_ids:
        narr.already_in_eligible_room(current_room)
        return None  # already in an eligible room

    for room_id in eligible_room_ids:
        if grid.is_room_free(gen_week, day, period, room_id):
            grid.assign_room(gen_week, day, period, doctor_id, room_id)
            narr.assigned_free_room(room_id)
            return None

    for room_id in eligible_room_ids:
        occupant_id = grid.get_room_occupant(gen_week, day, period, room_id)
        if occupant_id is None:
            continue  # defensive: none were free above, so this shouldn't occur
        displaceable, why = narrate.displaceability(
            context, grid, clinic_priority_by_id, occupant_id, gen_week, day, period,
            clinic.clinic_priority,
        )
        if not displaceable:
            narr.note_room_protected(room_id, why)
            continue

        exclude_d = context.room_by_id[room_id].room_type == RoomType.D
        new_room = _best_free_preferred_room(
            context, grid, occupant_id, gen_week, day, period, exclude_d=exclude_d,
        )
        if new_room is None:
            # This candidate room's occupant has nowhere to go; try the next.
            narr.note_occupant_stuck(room_id, occupant_id, exclude_d)
            continue

        grid.assign_room(gen_week, day, period, occupant_id, new_room)
        grid.assign_room(gen_week, day, period, doctor_id, room_id)
        narr.displaced_occupant(occupant_id, room_id, new_room)
        return None

    narr.unresolved()
    return ValidationIssue(
        severity="warning", phase=PHASE, check="clinic_room_unresolved",
        week=gen_week, day=day, period=period,
        message=(
            f"Could not find or free an eligible room for {_code(context, doctor_id)} "
            f"on clinic '{clinic.name}'; left in their current room."
        ),
    )


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
