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
"""
from __future__ import annotations

from dataclasses import dataclass

from ...models.enums import MasterSessionType, RoomType, SessionRole
from .. import rationale as rat
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
                if (date_, period) in context.closed_slots:
                    # M5: no slots exist here (Phase 2 built none), so there
                    # is nothing to assign and no warning to raise -- unlike
                    # a genuinely uncovered slot, a closed date is expected
                    # to have zero coverage.
                    log.add(
                        phase=PHASE, action="skip_closed_date",
                        week=gen_week, day=day, period=period,
                        clinic_type_id=clinic.id,
                        message=(
                            f"Skipped clinic '{clinic.name}' on "
                            f"{date_.isoformat()} {period.value}: practice "
                            f"closed."
                        ),
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
                    # Logged as well as warned: the warning says nobody was
                    # available, the log entry says which configured doctors
                    # were considered and what ruled each of them out, which
                    # is the actual question being asked when this fires.
                    log.add(
                        phase=PHASE, action="no_eligible_doctor",
                        week=gen_week, day=day, period=period,
                        clinic_type_id=clinic.id,
                        message=(
                            f"No eligible doctor for clinic '{clinic.name}' on "
                            f"{date_.isoformat()} {period.value}; slot left "
                            f"unassigned."
                        ),
                        rationale=rat.stages(
                            rat.listing(
                                "Doctors configured as eligible for this clinic type",
                                _excluded_lines(excluded),
                            ),
                            "Every configured doctor was ruled out, so there was "
                            "no field to compare.",
                        ),
                    )
                    continue

                # One scored, sorted field drives both the assignment and
                # its explanation, so the log can never disagree with what
                # the sort actually did.
                candidates = _score_candidates(context, counters, clinic, eligible)
                candidates.sort(key=lambda c: (c.tier, c.weighted, c.code))
                doctor_id = candidates[0].doctor_id
                reason = _selection_reason(candidates)

                slot = grid.get(doctor_id, gen_week, day, period)
                slot.clinic_type_id = clinic.id
                slot.role = SessionRole.CLINIC

                log.add(
                    phase=PHASE, action="assign_clinic",
                    week=gen_week, day=day, period=period, doctor_id=doctor_id,
                    clinic_type_id=clinic.id,
                    message=(
                        f"Assigned clinic '{clinic.name}' to "
                        f"{_code(context, doctor_id)} on {date_.isoformat()} "
                        f"{period.value} ({reason})."
                    ),
                    rationale=_selection_rationale(candidates, excluded),
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


def _selection_reason(candidates: list[_Candidate]) -> str:
    """The one-line reason embedded in the entry's `message`. Mirrors the
    sort key `candidates` is already ordered by: priority tier, then
    weighted counter score, then alphabetical. `_selection_rationale`
    expands the same comparison into the full stage-by-stage account."""
    if len(candidates) == 1:
        return "only eligible doctor"

    a, b = candidates[0], candidates[1]
    if a.tier != b.tier:
        return f"priority tier {a.tier}"
    if a.weighted != b.weighted:
        return (
            f"priority tier {a.tier}, tie broken on weighted "
            f"score {a.weighted:.2f} vs {b.weighted:.2f}"
        )
    return f"priority tier {a.tier}, alphabetical tie-break"


def _selection_rationale(
    candidates: list[_Candidate], excluded: list[tuple[str, str]]
) -> str:
    """The full account of a clinic assignment: the eligible field, who was
    ruled out and why, the top tier, the counter comparison inside it, and
    the decisive stage.

    Stages are emitted only up to the one that decided -- if the top tier
    holds a single doctor, no counter line is written, because no counter
    was consulted. Reading a run's log, the presence of a line is itself
    the evidence that the stage ran.
    """
    chosen = candidates[0]
    lines: list[str | None] = [
        rat.listing(
            "Eligible",
            [
                f"{c.code} (priority tier {c.tier}, {rat.score(c.raw, c.spw, c.weighted, c.balance)})"
                for c in candidates
            ],
        ),
        rat.listing("Not eligible", _excluded_lines(excluded)) if excluded else None,
    ]

    top_tier = [c for c in candidates if c.tier == chosen.tier]
    if len(candidates) == 1:
        lines.append(rat.decided(f"{rat.ONLY_CANDIDATE} -- {chosen.code}"))
        return rat.stages(*lines)

    lines.append(rat.listing(
        f"Top priority tier {chosen.tier}", [c.code for c in top_tier]
    ))
    if len(top_tier) == 1:
        lines.append(rat.decided(
            f"{rat.PRIORITY_TIER} -- {chosen.code} is alone in tier {chosen.tier}"
        ))
        return rat.stages(*lines)

    lines.append(rat.listing(
        "Weighted clinic counters within that tier",
        [f"{c.code} {rat.score(c.raw, c.spw, c.weighted, c.balance)}" for c in top_tier],
    ))
    tied = [c for c in top_tier if c.weighted == chosen.weighted]
    if len(tied) == 1:
        lines.append(rat.decided(
            f"{rat.WEIGHTED_COUNTER} -- {chosen.code} has the lowest weighted "
            f"count, {rat.fmt(chosen.weighted)}"
        ))
        return rat.stages(*lines)

    lines.append(rat.listing(
        f"Still tied on weighted count {rat.fmt(chosen.weighted)}",
        [c.code for c in tied],
    ))
    lines.append(rat.decided(f"{rat.ALPHABETICAL} -- {chosen.code}"))
    return rat.stages(*lines)


def _excluded_lines(excluded: list[tuple[str, str]]) -> list[str]:
    return [f"{code}: {reason}" for code, reason in excluded]


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


def _clinic_name(context: GenerationContext, clinic_type_id: int) -> str:
    for clinic in context.clinic_types:
        if clinic.id == clinic_type_id:
            return clinic.name
    return f"clinic type id={clinic_type_id}"


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
    # Snapshot the room list before anything moves, so every entry below
    # explains itself against the state the search actually faced.
    rooms_line = rat.listing(
        f"Rooms eligible for clinic '{clinic.name}' (searched in room-id order)",
        _room_states(
            context, grid, eligible_room_ids, gen_week, day, period,
            clinic_priority_by_id, clinic.clinic_priority,
        ),
    )

    current_room = grid.get_doctor_room(gen_week, day, period, doctor_id)
    if current_room is not None and current_room in clinic.eligible_room_ids:
        log.add(
            phase=PHASE, action="assign_clinic_room",
            week=gen_week, day=day, period=period, doctor_id=doctor_id,
            room_id=current_room, clinic_type_id=clinic.id,
            message=(
                f"{_code(context, doctor_id)} already in eligible room "
                f"{context.room_by_id[current_room].code} for clinic "
                f"'{clinic.name}'."
            ),
            rationale=rat.stages(
                rooms_line,
                rat.decided(
                    f"no search run -- {_code(context, doctor_id)} already held "
                    f"{context.room_by_id[current_room].code}, which is on that list"
                ),
            ),
        )
        return None  # already in an eligible room

    for room_id in eligible_room_ids:
        if grid.is_room_free(gen_week, day, period, room_id):
            grid.assign_room(gen_week, day, period, doctor_id, room_id)
            log.add(
                phase=PHASE, action="assign_clinic_room",
                week=gen_week, day=day, period=period, doctor_id=doctor_id,
                room_id=room_id, clinic_type_id=clinic.id,
                message=(
                    f"Assigned room {context.room_by_id[room_id].code} to "
                    f"{_code(context, doctor_id)} for clinic '{clinic.name}'."
                ),
                rationale=rat.stages(
                    rooms_line,
                    rat.decided(
                        f"first free room in that list -- "
                        f"{context.room_by_id[room_id].code}; no displacement needed"
                    ),
                ),
            )
            return None

    attempts: list[str] = []
    for room_id in eligible_room_ids:
        room_code = context.room_by_id[room_id].code
        occupant_id = grid.get_room_occupant(gen_week, day, period, room_id)
        if occupant_id is None:
            continue  # defensive: none were free above, so this shouldn't occur
        displaceable, why = _displaceability(
            context, grid, clinic_priority_by_id, occupant_id, gen_week, day, period,
            clinic.clinic_priority,
        )
        if not displaceable:
            attempts.append(f"{room_code}: cannot take it -- {why}")
            continue

        exclude_d = context.room_by_id[room_id].room_type == RoomType.D
        new_room = _best_free_preferred_room(
            context, grid, occupant_id, gen_week, day, period, exclude_d=exclude_d,
        )
        if new_room is None:
            attempts.append(
                f"{room_code}: {_code(context, occupant_id)} could be displaced but "
                f"has no free preferred room to move to"
                + (" (D rooms excluded)" if exclude_d else "")
            )
            continue  # this candidate room's occupant has nowhere to go; try the next

        grid.assign_room(gen_week, day, period, occupant_id, new_room)
        grid.assign_room(gen_week, day, period, doctor_id, room_id)
        log.add(
            phase=PHASE, action="displace_for_clinic",
            week=gen_week, day=day, period=period, doctor_id=doctor_id,
            related_doctor_id=occupant_id, room_id=room_id, related_room_id=new_room,
            clinic_type_id=clinic.id,
            message=(
                f"Displaced {_code(context, occupant_id)} from "
                f"{context.room_by_id[room_id].code} to "
                f"{context.room_by_id[new_room].code} so "
                f"{_code(context, doctor_id)} can run clinic '{clinic.name}'."
            ),
            rationale=rat.stages(
                rooms_line,
                "No eligible room was free, so the list was walked again for a "
                "displaceable occupant.",
                rat.listing("Rooms tried and rejected first", attempts) if attempts else None,
                rat.decided(
                    f"first eligible room whose occupant could both be displaced and "
                    f"rehoused -- {room_code}; {_code(context, occupant_id)} moved to "
                    f"{context.room_by_id[new_room].code}, the first free room on their "
                    f"own preference list"
                ),
            ),
        )
        return None

    doctor = context.doctor_by_id.get(doctor_id)
    code = doctor.code if doctor is not None else f"id={doctor_id}"
    log.add(
        phase=PHASE, action="clinic_room_unresolved",
        week=gen_week, day=day, period=period, doctor_id=doctor_id,
        clinic_type_id=clinic.id,
        message=(
            f"No eligible room could be found or freed for {code} on clinic "
            f"'{clinic.name}'; left in their current room."
        ),
        rationale=rat.stages(
            rooms_line,
            rat.listing("Rooms tried for displacement", attempts),
            rat.decided("nothing left to try -- every eligible room was occupied "
                        "and none of the occupants could be displaced and rehoused"),
        ),
    )
    return ValidationIssue(
        severity="warning", phase=PHASE, check="clinic_room_unresolved",
        week=gen_week, day=day, period=period,
        message=(
            f"Could not find or free an eligible room for {code} on clinic "
            f"'{clinic.name}'; left in their current room."
        ),
    )


def _room_states(
    context: GenerationContext,
    grid: RotaGrid,
    room_ids: list[int],
    gen_week: int,
    day,
    period,
    clinic_priority_by_id: dict[int, int],
    current_clinic_priority: int,
) -> list[str]:
    """One `"R1: free"` / `"R1: held by AB, displaceable"` line per eligible
    room, in the order the search walks them."""
    states = []
    for room_id in room_ids:
        room_code = context.room_by_id[room_id].code
        occupant_id = grid.get_room_occupant(gen_week, day, period, room_id)
        if occupant_id is None:
            states.append(f"{room_code}: free")
            continue
        displaceable, why = _displaceability(
            context, grid, clinic_priority_by_id, occupant_id, gen_week, day, period,
            current_clinic_priority,
        )
        states.append(
            f"{room_code}: held by {_code(context, occupant_id)}, "
            + ("displaceable" if displaceable else why)
        )
    return states


def _displaceability(
    context: GenerationContext,
    grid: RotaGrid,
    clinic_priority_by_id: dict[int, int],
    occupant_id: int,
    gen_week: int,
    day,
    period,
    current_clinic_priority: int,
) -> tuple[bool, str]:
    """`(displaceable, reason)` -- the reason names the protection that
    fired, and is only meaningful when `displaceable` is False."""
    slot = grid.get(occupant_id, gen_week, day, period)
    if slot is None:
        return False, "no session slot for that doctor this session"
    if slot.is_on_leave:
        return False, "protected: on leave"
    if slot.role in (SessionRole.DUTY_PRIMARY, SessionRole.DUTY_SECONDARY):
        return False, f"protected: on {slot.role.value}"
    if slot.role == SessionRole.CLINIC:
        occupant_priority = clinic_priority_by_id.get(slot.clinic_type_id)
        if occupant_priority is not None and occupant_priority < current_clinic_priority:
            # Protected: occupant's clinic is higher priority (lower number).
            return False, (
                f"protected: running '{_clinic_name(context, slot.clinic_type_id)}' "
                f"at clinic priority {occupant_priority}, ahead of this clinic's "
                f"{current_clinic_priority}"
            )
    return True, "displaceable"


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


def _code(context: GenerationContext, doctor_id: int) -> str:
    doctor = context.doctor_by_id.get(doctor_id)
    return doctor.code if doctor is not None else f"id={doctor_id}"
