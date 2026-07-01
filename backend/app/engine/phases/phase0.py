"""Phase 0 -- pre-flight validation (read-only; hard errors abort generation).

Runs before any other phase, directly against the `GenerationContext`. If it
returns any `severity="error"` issue, `generate()` stops immediately: no
`RotaGrid` is built and nothing is written to the database.
"""
from __future__ import annotations

from ...models import RotaConfig
from ..datatypes import GenerationContext, ValidationIssue

PHASE = "phase0"


def run_phase0(context: GenerationContext, config: RotaConfig) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []

    issues.extend(_check_active_template(context))
    issues.extend(_check_start_date_is_monday(config))
    issues.extend(_check_num_weeks(config))
    issues.extend(_check_template_start_week(config))
    issues.extend(_check_duty_doctors_not_on_leave(context))
    issues.extend(_check_template_doctors_active(context))

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