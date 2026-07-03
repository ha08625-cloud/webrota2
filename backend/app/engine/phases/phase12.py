"""Phase 12 -- validation (read-only; warnings only).

Runs after every other phase, purely to surface data-quality findings for
the admin to review. Never mutates the grid or counters, and every finding
here is a warning -- nothing in Phase 12 aborts generation.

Check 4 (supervision) is explicitly out of scope for M2 -- see the M2 plan's
"Open item" section; sequenced after the M3 bulk.

Check 3 excludes on-leave slots: a doctor on leave still gets a
REQUIRES_ROOM SessionSlot from Phase 2 (the template doesn't know they're on
leave), and Phases 7-9A correctly never give them a room. Without this
exclusion every leave day would register as a spurious "unresolved room"
finding -- flagged as a known gap back in step 7 (phase7_9a.py), resolved
here.
"""
from __future__ import annotations

from ...models.enums import Day, MasterSessionType, Period, SessionRole
from ..datatypes import GenerationContext, RotaGrid, ValidationIssue

PHASE = "phase12"

_DAYS = (Day.MONDAY, Day.TUESDAY, Day.WEDNESDAY, Day.THURSDAY, Day.FRIDAY)
_PERIODS = (Period.AM, Period.PM)


def run_phase12(context: GenerationContext, grid: RotaGrid) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    issues.extend(_check_duty_coverage(context, grid))
    issues.extend(_check_clinic_coverage(context, grid))
    issues.extend(_check_unresolved_rooms(context, grid))
    return issues


def _expected_duty_counts(day: Day) -> tuple[int, int]:
    """(expected primary count, expected secondary count) for a weekday.

    2 primary + 1 secondary on Monday; 1 primary + 0 secondary Tue-Fri, per
    the M2 plan's Check 1.
    """
    if day == Day.MONDAY:
        return 2, 1
    return 1, 0


def _check_duty_coverage(context: GenerationContext, grid: RotaGrid) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    num_weeks = max((gw for gw, _day in context.week_dates.keys()), default=0)

    for gen_week in range(1, num_weeks + 1):
        for day in _DAYS:
            expected_primary, expected_secondary = _expected_duty_counts(day)
            for period in _PERIODS:
                sessions = grid.sessions_for_slot(gen_week, day, period)
                primary_count = sum(1 for s in sessions if s.role == SessionRole.DUTY_PRIMARY)
                secondary_count = sum(1 for s in sessions if s.role == SessionRole.DUTY_SECONDARY)

                if primary_count != expected_primary:
                    issues.append(_warning(
                        "duty_coverage_primary", gen_week, day, period,
                        f"Expected {expected_primary} primary duty doctor(s) on "
                        f"{day.value} {period.value}, found {primary_count}.",
                    ))
                if secondary_count != expected_secondary:
                    issues.append(_warning(
                        "duty_coverage_secondary", gen_week, day, period,
                        f"Expected {expected_secondary} secondary duty doctor(s) on "
                        f"{day.value} {period.value}, found {secondary_count}.",
                    ))
    return issues


def _check_clinic_coverage(context: GenerationContext, grid: RotaGrid) -> list[ValidationIssue]:
    """Exactly one assignment per enabled clinic type's schedule slot per week.

    This subsumes duty-helper coverage, since a duty helper is modelled as
    an ordinary ClinicType (per the M2 plan's Check 2 note).
    """
    issues: list[ValidationIssue] = []
    num_weeks = max((gw for gw, _day in context.week_dates.keys()), default=0)

    for clinic in context.clinic_types:
        for schedule in clinic.schedules:
            for gen_week in range(1, num_weeks + 1):
                sessions = grid.sessions_for_slot(gen_week, schedule.day, schedule.period)
                count = sum(1 for s in sessions if s.clinic_type_id == clinic.id)
                if count != 1:
                    issues.append(_warning(
                        "clinic_coverage", gen_week, schedule.day, schedule.period,
                        f"Expected exactly 1 assignment for clinic '{clinic.name}' on "
                        f"{schedule.day.value} {schedule.period.value}, found {count}.",
                    ))
    return issues


def _check_unresolved_rooms(context: GenerationContext, grid: RotaGrid) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    for slot in grid.slots.values():
        if slot.template_type != MasterSessionType.REQUIRES_ROOM:
            continue
        if slot.assigned_room_id is not None:
            continue
        if slot.is_on_leave:
            continue  # a doctor on leave never needs a room -- see phase7_9a.py

        doctor = context.doctor_by_id.get(slot.doctor_id)
        code = doctor.code if doctor is not None else f"id={slot.doctor_id}"
        issues.append(_warning(
            "unresolved_room", slot.week, slot.day, slot.period,
            f"{code} has an unresolved REQUIRES_ROOM slot on {slot.day.value} "
            f"{slot.period.value} (week {slot.week}).",
        ))
    return issues


def _warning(check: str, week: int, day: Day, period: Period, message: str) -> ValidationIssue:
    return ValidationIssue(
        severity="warning", phase=PHASE, check=check,
        week=week, day=day, period=period, message=message,
    )
