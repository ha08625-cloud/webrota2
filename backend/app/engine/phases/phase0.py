"""Phase 0 -- pre-flight validation (read-only; hard errors abort generation).

Runs before any other phase, directly against the `GenerationContext`. If it
returns any `severity="error"` issue, `generate()` stops immediately: no
`RotaGrid` is built and nothing is written to the database.
"""
from __future__ import annotations

from ...doctor_window import is_within_window
from ...models import RotaConfig
from ...models.enums import MasterSessionType
from ..datatypes import GenerationContext, ValidationIssue
from ..week_map import template_week

PHASE = "phase0"


def run_phase0(context: GenerationContext, config: RotaConfig) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []

    issues.extend(_check_active_template(context))
    issues.extend(_check_start_date_is_monday(config))
    issues.extend(_check_num_weeks(config))
    issues.extend(_check_template_start_week(config))
    issues.extend(_check_duty_doctors_not_on_leave(context))
    issues.extend(_check_duty_on_incompatible_template_slot(context, config))
    issues.extend(_check_template_doctors_active(context))
    issues.extend(_check_duty_on_closed_date(context))
    issues.extend(_check_duty_within_doctor_dates(context))

    return issues


def _check_active_template(context: GenerationContext) -> list[ValidationIssue]:
    if context.active_template is not None:
        return []
    return [ValidationIssue(
        severity="error", phase=PHASE, check="active_template",
        message=(
            "No unique active master rota template found. There must be "
            "exactly one MasterRotaTemplate with is_active=True (zero or "
            "more than one both count as a data error)."
        ),
    )]


def _check_start_date_is_monday(config: RotaConfig) -> list[ValidationIssue]:
    if config.start_date.weekday() == 0:
        return []
    return [ValidationIssue(
        severity="error", phase=PHASE, check="start_date_monday",
        message=f"start_date {config.start_date.isoformat()} is not a Monday.",
    )]


def _check_num_weeks(config: RotaConfig) -> list[ValidationIssue]:
    if config.num_weeks in (1, 2, 4):
        return []
    return [ValidationIssue(
        severity="error", phase=PHASE, check="num_weeks",
        message=f"num_weeks must be 1, 2, or 4; got {config.num_weeks}.",
    )]


def _check_template_start_week(config: RotaConfig) -> list[ValidationIssue]:
    if 1 <= config.template_start_week <= 4:
        return []
    return [ValidationIssue(
        severity="error", phase=PHASE, check="template_start_week",
        message=(
            f"template_start_week must be between 1 and 4; "
            f"got {config.template_start_week}."
        ),
    )]


def _check_duty_doctors_not_on_leave(context: GenerationContext) -> list[ValidationIssue]:
    """Error if a pre-planned duty doctor has leave for that exact date/period."""
    issues: list[ValidationIssue] = []
    for (date_, period, duty_type), doctor_id in sorted(
        context.duty_map.items(), key=lambda kv: (kv[0][0], kv[0][1].value, kv[0][2].value)
    ):
        if (doctor_id, date_, period) not in context.leave_set:
            continue
        genslot = context.date_to_genslot.get(date_)
        gen_week, day = genslot if genslot is not None else (None, None)
        doctor = context.doctor_by_id.get(doctor_id)
        code = doctor.code if doctor is not None else f"id={doctor_id}"
        issues.append(ValidationIssue(
            severity="error", phase=PHASE, check="duty_on_leave",
            week=gen_week, day=day, period=period,
            message=(
                f"Duty doctor {code} ({duty_type.value}) is on leave on "
                f"{date_.isoformat()} {period.value}."
            ),
        ))
    return issues


def _check_duty_on_incompatible_template_slot(
    context: GenerationContext, config: RotaConfig
) -> list[ValidationIssue]:
    """Error if a pre-planned duty doctor's slot is templated NO_SURGERY or
    ADMIN_TIME (M3.7): nothing is scheduled there, so a duty role has
    nowhere meaningful to attach. Same severity tier as duty-on-leave, for
    the same reason - both are pre-flight data errors, not generation-time
    tradeoffs.

    WFH is deliberately not covered here (M3.7 decision): a WFH template
    slot is overridable in practice (the doctor comes in for duty), so it
    is a Phase 12 warning, not a Phase 0 block - see
    _check_role_on_incompatible_slot in phase12.py.

    A missing template row entirely (no entry for this doctor/day/period
    at all) is a different, pre-existing condition and is left alone here
    - see Phase 4's duty_no_session_slot warning.
    """
    issues: list[ValidationIssue] = []
    for (date_, period, duty_type), doctor_id in sorted(
        context.duty_map.items(), key=lambda kv: (kv[0][0], kv[0][1].value, kv[0][2].value)
    ):
        genslot = context.date_to_genslot.get(date_)
        if genslot is None:
            # Defensive only, same as _check_duty_doctors_not_on_leave:
            # context.duty_map is already filtered to the run's date range.
            continue
        gen_week, day = genslot
        tw = template_week(gen_week, config.template_start_week)
        template_entry = context.template_sessions.get((doctor_id, tw, day, period))
        if template_entry is None:
            continue  # no template row at all - Phase 4's concern, not this one
        session_type, _room_id = template_entry
        if session_type not in (MasterSessionType.NO_SURGERY, MasterSessionType.ADMIN_TIME):
            continue

        doctor = context.doctor_by_id.get(doctor_id)
        code = doctor.code if doctor is not None else f"id={doctor_id}"
        issues.append(ValidationIssue(
            severity="error", phase=PHASE, check="duty_on_incompatible_slot",
            week=gen_week, day=day, period=period,
            message=(
                f"Duty doctor {code} ({duty_type.value}) is assigned to a "
                f"{session_type.value} slot on {date_.isoformat()} "
                f"{period.value}, which cannot carry a duty role."
            ),
        ))
    return issues


def _check_template_doctors_active(context: GenerationContext) -> list[ValidationIssue]:
    """Error if the active template references a doctor who is not active.

    One issue per doctor, not per slot -- a doctor referenced across many
    template slots has one fix (reactivate them or remove them from the
    template), so flagging every slot would just be noise.
    """
    if context.active_template is None:
        return []  # Nothing to check; _check_active_template already errored.

    bad_doctor_ids = sorted({
        doctor_id for (doctor_id, _week, _day, _period) in context.template_sessions
        if context.doctor_by_id.get(doctor_id) is None
        or not context.doctor_by_id[doctor_id].active
    })

    issues: list[ValidationIssue] = []
    for doctor_id in bad_doctor_ids:
        doctor = context.doctor_by_id.get(doctor_id)
        code = doctor.code if doctor is not None else f"id={doctor_id}"
        issues.append(ValidationIssue(
            severity="error", phase=PHASE, check="template_doctor_active",
            message=(
                f"Doctor {code} is referenced by the active master rota "
                f"template but is not active."
            ),
        ))
    return issues


def _check_duty_on_closed_date(context: GenerationContext) -> list[ValidationIssue]:
    """Error if a pre-planned duty assignment falls on a closed slot (M5).

    Same tier as duty-on-leave and duty-on-incompatible-slot: a closed slot
    has no session and nothing for a duty role to attach to, so this is a
    pre-flight data error, not a generation-time tradeoff. The Duty page is
    expected to prevent this at entry, but the engine cannot rely on that --
    a closure can be added after a duty assignment already exists. Checked
    per period: a Thursday-AM duty is fine even when Thursday PM is closed.
    """
    issues: list[ValidationIssue] = []
    for (date_, period, duty_type), doctor_id in sorted(
        context.duty_map.items(), key=lambda kv: (kv[0][0], kv[0][1].value, kv[0][2].value)
    ):
        if (date_, period) not in context.closed_slots:
            continue
        genslot = context.date_to_genslot.get(date_)
        gen_week, day = genslot if genslot is not None else (None, None)
        doctor = context.doctor_by_id.get(doctor_id)
        code = doctor.code if doctor is not None else f"id={doctor_id}"
        issues.append(ValidationIssue(
            severity="error", phase=PHASE, check="duty_on_closed_date",
            week=gen_week, day=day, period=period,
            message=(
                f"Duty doctor {code} ({duty_type.value}) is assigned on "
                f"{date_.isoformat()} {period.value}, which is a closed slot."
            ),
        ))
    return issues


def _check_duty_within_doctor_dates(context: GenerationContext) -> list[ValidationIssue]:
    """Error if a pre-planned duty falls outside the doctor's employment
    window.

    Same tier as duty-on-leave and duty-on-closed-date: Phase 2 builds no
    slot for an out-of-window (doctor, date), so the duty has nothing to
    attach to. Without this it would degrade to Phase 4's
    duty_no_session_slot warning and the rota would generate with the duty
    silently dropped. `POST /duty` rejects this at entry, but a window can
    be narrowed after a duty assignment already exists.

    Uses `context.doctor_by_id` rather than `context.doctors` for the same
    reason as _check_template_doctors_active: an inactive doctor must still
    be reachable here.
    """
    issues: list[ValidationIssue] = []
    for (date_, period, duty_type), doctor_id in sorted(
        context.duty_map.items(), key=lambda kv: (kv[0][0], kv[0][1].value, kv[0][2].value)
    ):
        doctor = context.doctor_by_id.get(doctor_id)
        if doctor is None or is_within_window(doctor, date_):
            continue
        genslot = context.date_to_genslot.get(date_)
        gen_week, day = genslot if genslot is not None else (None, None)
        issues.append(ValidationIssue(
            severity="error", phase=PHASE, check="duty_outside_doctor_dates",
            week=gen_week, day=day, period=period,
            message=(
                f"Duty doctor {doctor.code} ({duty_type.value}) is assigned on "
                f"{date_.isoformat()} {period.value}, which is outside their "
                f"employment dates."
            ),
        ))
    return issues