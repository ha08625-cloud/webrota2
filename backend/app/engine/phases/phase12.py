"""Phase 12 -- validation (read-only; warnings only).

Runs after every other phase, purely to surface data-quality findings for
the admin to review. Never mutates the grid or counters, and every finding
here is a warning -- nothing in Phase 12 aborts generation.

Check 3 excludes on-leave slots: a doctor on leave still gets a
REQUIRES_ROOM SessionSlot from Phase 2 (the template doesn't know they're on
leave), and Phases 7-9A correctly never give them a room. Without this
exclusion every leave day would register as a spurious "unresolved room"
finding -- flagged as a known gap back in step 7 (phase7_9a.py), resolved
here.

Check 3b (`room_on_leave_slot`) exists for the paths that can still put a
room on an on-leave slot even though generation itself never does (Phase 2
skips the occupancy claim for on-leave slots -- see phase2.py M-leave
task). It catches: post-hoc leave added on a committed rota (the room was
claimed before the leave existed), `rollback_commit()` reinstating a
committed rota as a draft with a stale room hold, and a forced `set-room`
edit onto a leave slot via the API (the popover blocks this in the UI, but
apply-then-warn permits it server-side). It fires independently of role,
so it can co-fire with `role_on_incompatible_slot` on the same slot -- both
findings are true and distinct, not a duplicate.

Check 4 (supervision, Phase 9C implementation plan section 3) reuses
`count_supervisable_trainees` and `is_eligible_supervisor` from phase9c.py
so the assignment rule and the validation rule cannot drift apart. Two
prongs:
  - supervision_missing: a session has supervisable trainees but no slot
    both flags is_supervising AND is currently eligible. A flag on an
    ineligible slot does not count -- this is what keeps forced edits
    honest, mirroring role_on_incompatible_slot.
  - supervision_on_incompatible_slot: any is_supervising slot that fails
    eligibility, regardless of whether trainees are present.
A session edited into a bad state can trigger both at once (the flagged
supervisor is now invalid AND no valid supervisor remains) -- correct, not
a duplicate.
"""
from __future__ import annotations

from ...models.enums import Day, MasterSessionType, Period, SessionRole
from ..datatypes import GenerationContext, RotaGrid, ValidationIssue
from .phase9c import count_supervisable_trainees, is_eligible_supervisor

PHASE = "phase12"

_DAYS = (Day.MONDAY, Day.TUESDAY, Day.WEDNESDAY, Day.THURSDAY, Day.FRIDAY)
_PERIODS = (Period.AM, Period.PM)


def run_phase12(context: GenerationContext, grid: RotaGrid) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    issues.extend(_check_duty_coverage(context, grid))
    issues.extend(_check_clinic_coverage(context, grid))
    issues.extend(_check_unresolved_rooms(context, grid))
    issues.extend(_check_room_on_leave_slot(context, grid))
    issues.extend(_check_role_on_incompatible_slot(context, grid))
    issues.extend(_check_supervision_missing(context, grid))
    issues.extend(_check_supervision_on_incompatible_slot(context, grid))
    return issues


def _expected_duty_counts(
    context: GenerationContext, gen_week: int, day: Day, period: Period
) -> tuple[int, int]:
    """(expected primary count, expected secondary count) for one session.

    Exactly 1 primary duty doctor per session, every weekday -- the
    DutyAssignment schema's unique constraint on (date, period, duty_type)
    structurally forbids more than one row per session regardless of day,
    so a "2 primary on Monday" check (the M2 plan's original wording) can
    never be satisfied and was a bug, caught by CI hitting the constraint
    directly.

    M5/half-day closures: primary is closure-aware *per period* -- not
    expected at all on a closed (date, period) (0, not 1), since primary
    duty simply does not relocate the way secondary does. Secondary stays
    day-level, not per-period: it is expected on both AM and PM of the first
    *fully open* weekday of each generation week (0 elsewhere), per
    `context.first_open_weekday_by_week`. That function only ever returns a
    day with neither period closed, so secondary duty's day never has a
    closed half to worry about -- this generalises the original "Monday
    only" rule (user: "it moves to Tuesday" when Monday is closed) and
    degrades to "no secondary expected" for a week with no fully open
    weekday, where `first_open_weekday_by_week[gen_week]` is None and can
    never equal a real `day`.
    """
    date_ = context.week_dates.get((gen_week, day))
    is_closed = date_ is not None and (date_, period) in context.closed_slots
    expected_primary = 0 if is_closed else 1
    expected_secondary = 1 if day == context.first_open_weekday_by_week.get(gen_week) else 0
    return expected_primary, expected_secondary


def _check_duty_coverage(context: GenerationContext, grid: RotaGrid) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    num_weeks = max((gw for gw, _day in context.week_dates.keys()), default=0)

    for gen_week in range(1, num_weeks + 1):
        for day in _DAYS:
            for period in _PERIODS:
                expected_primary, expected_secondary = _expected_duty_counts(
                    context, gen_week, day, period
                )
                sessions = grid.sessions_for_slot(gen_week, day, period)
                primary_count = sum(1 for s in sessions if s.role == SessionRole.DUTY_PRIMARY)
                secondary_count = sum(1 for s in sessions if s.role == SessionRole.DUTY_SECONDARY)

                if primary_count != expected_primary:
                    issues.append(_warning(
                        "duty_coverage_primary", gen_week, day, period,
                        f"Primary duty coverage wrong {day.value} {period.value} "
                        f"(week {gen_week}) -- expected {expected_primary}, "
                        f"found {primary_count}",
                    ))
                if secondary_count != expected_secondary:
                    issues.append(_warning(
                        "duty_coverage_secondary", gen_week, day, period,
                        f"Secondary duty coverage wrong {day.value} {period.value} "
                        f"(week {gen_week}) -- expected {expected_secondary}, "
                        f"found {secondary_count}",
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
                date_ = context.week_dates.get((gen_week, schedule.day))
                if date_ is not None and (date_, schedule.period) in context.closed_slots:
                    # M5: mirrors Phase 5 -- no slots exist here, nothing
                    # was or could be assigned, so no coverage warning.
                    continue
                sessions = grid.sessions_for_slot(gen_week, schedule.day, schedule.period)
                count = sum(1 for s in sessions if s.clinic_type_id == clinic.id)
                if count != 1:
                    issues.append(_warning(
                        "clinic_coverage", gen_week, schedule.day, schedule.period,
                        f"{clinic.name} coverage wrong {schedule.day.value} "
                        f"{schedule.period.value} (week {gen_week}) -- expected 1, "
                        f"found {count}",
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
        if slot.is_wfh:
            continue  # WFH needs no room (M3.5 Task 2: the session PATCH can
            # set WFH on a REQUIRES_ROOM slot, clearing its room; that must
            # not warn while WFH is on. Toggling WFH off re-surfaces it.)

        doctor = context.doctor_by_id.get(slot.doctor_id)
        code = doctor.code if doctor is not None else f"id={slot.doctor_id}"
        issues.append(_warning(
            "unresolved_room", slot.week, slot.day, slot.period,
            f"{code} needs a room {slot.day.value} {slot.period.value} "
            f"(week {slot.week})",
            doctor_id=slot.doctor_id,
        ))
    return issues


def _check_room_on_leave_slot(
    context: GenerationContext, grid: RotaGrid
) -> list[ValidationIssue]:
    """Warn if any on-leave slot still holds a room. Generation never
    produces this (Phase 2 skips the occupancy claim for on-leave slots),
    so this only fires for post-hoc leave on a committed rota, a
    rollback-to-draft that reinstates a stale hold, or a forced set-room
    edit onto a leave slot. Independent of role -- can co-fire with
    role_on_incompatible_slot on the same slot.
    """
    issues: list[ValidationIssue] = []
    for slot in grid.slots.values():
        if not slot.is_on_leave or slot.assigned_room_id is None:
            continue

        doctor = context.doctor_by_id.get(slot.doctor_id)
        doctor_code = doctor.code if doctor is not None else f"id={slot.doctor_id}"
        room = context.room_by_id.get(slot.assigned_room_id)
        room_code = room.code if room is not None else f"id={slot.assigned_room_id}"
        issues.append(_warning(
            "room_on_leave_slot", slot.week, slot.day, slot.period,
            f"{doctor_code} is on leave but still holds room {room_code} -- "
            f"{slot.day.value} {slot.period.value} (week {slot.week})",
        ))
    return issues


def _check_role_on_incompatible_slot(
    context: GenerationContext, grid: RotaGrid
) -> list[ValidationIssue]:
    """Warn if any role (duty or clinic) ended up on a slot that shouldn't
    carry one (M3.7): NO_SURGERY/ADMIN_TIME template slots, on-leave slots,
    or WFH slots. Covers both generation output and every edit (swap, move,
    and the session PATCH all re-run Phase 12 via grid_utils), since the
    editing API has no eligibility checks of its own - a forced swap/move
    can put any role anywhere. Covers clinic roles too, not just duty: the
    swap/move endpoints can put a clinic assignment on an incompatible slot
    exactly as easily as a duty one, at no extra cost to check both.
    """
    issues: list[ValidationIssue] = []
    for slot in grid.slots.values():
        if slot.role is None:
            continue

        reasons: list[str] = []
        if slot.is_on_leave:
            reasons.append("on leave")
        if slot.is_wfh:
            reasons.append("WFH")
        if slot.template_type in (MasterSessionType.NO_SURGERY, MasterSessionType.ADMIN_TIME):
            reasons.append(f"on a {slot.template_type.value} slot")
        if not reasons:
            continue

        doctor = context.doctor_by_id.get(slot.doctor_id)
        code = doctor.code if doctor is not None else f"id={slot.doctor_id}"
        issues.append(_warning(
            "role_on_incompatible_slot", slot.week, slot.day, slot.period,
            f"{code} has {slot.role.value} while {'; '.join(reasons)} -- "
            f"{slot.day.value} {slot.period.value} (week {slot.week})",
        ))
    return issues


def _check_supervision_missing(
    context: GenerationContext, grid: RotaGrid
) -> list[ValidationIssue]:
    """Warn if a session has supervisable trainees but no slot both flags
    is_supervising AND is currently an eligible supervisor. A flag on a
    slot that has since become ineligible (e.g. via a later edit) does not
    satisfy this -- it is instead caught by
    `_check_supervision_on_incompatible_slot` below.
    """
    issues: list[ValidationIssue] = []
    num_weeks = max((gw for gw, _day in context.week_dates.keys()), default=0)

    for gen_week in range(1, num_weeks + 1):
        for day in _DAYS:
            for period in _PERIODS:
                n = count_supervisable_trainees(context, grid, gen_week, day, period)
                if n == 0:
                    continue

                sessions = grid.sessions_for_slot(gen_week, day, period)
                has_valid_supervisor = any(
                    slot.is_supervising and is_eligible_supervisor(context, grid, slot)
                    for slot in sessions
                )
                if not has_valid_supervisor:
                    issues.append(_warning(
                        "supervision_missing", gen_week, day, period,
                        f"Supervisor needed {day.value} {period.value} "
                        f"(week {gen_week})",
                    ))
    return issues


def _check_supervision_on_incompatible_slot(
    context: GenerationContext, grid: RotaGrid
) -> list[ValidationIssue]:
    """Warn if any is_supervising slot fails is_eligible_supervisor, whether
    or not trainees are present in the session -- mirrors
    role_on_incompatible_slot, keeping the manual-edit escape hatch honest.
    """
    issues: list[ValidationIssue] = []
    for slot in grid.slots.values():
        if not slot.is_supervising:
            continue
        if is_eligible_supervisor(context, grid, slot):
            continue

        doctor = context.doctor_by_id.get(slot.doctor_id)
        code = doctor.code if doctor is not None else f"id={slot.doctor_id}"
        issues.append(_warning(
            "supervision_on_incompatible_slot", slot.week, slot.day, slot.period,
            f"{code} flagged as supervisor but not eligible -- "
            f"{slot.day.value} {slot.period.value} (week {slot.week})",
        ))
    return issues


def _warning(
    check: str, week: int, day: Day, period: Period, message: str,
    doctor_id: int | None = None,
) -> ValidationIssue:
    return ValidationIssue(
        severity="warning", phase=PHASE, check=check,
        week=week, day=day, period=period, message=message,
        doctor_id=doctor_id,
    )