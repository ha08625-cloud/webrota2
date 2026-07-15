"""Phase 4 -- apply pre-planned duty doctors.

Duty is pre-planned (a `DutyAssignment` row already names the doctor), so
this phase only layers a `role` onto an existing slot -- it never chooses a
doctor and never touches a counter. Room resolution for the duty doctor (a
Partner/Salaried, per the domain model) happens later in Phases 7-9A exactly
as it would without duty.
"""
from __future__ import annotations

from ...models.enums import DutyType, SessionRole
from ..datatypes import DecisionLog, GenerationContext, RotaGrid, ValidationIssue

PHASE = "phase4"


def run_phase4(
    context: GenerationContext, grid: RotaGrid, log: DecisionLog
) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []

    for (date_, period, duty_type), doctor_id in sorted(
        context.duty_map.items(), key=lambda kv: (kv[0][0], kv[0][1].value, kv[0][2].value)
    ):
        genslot = context.date_to_genslot.get(date_)
        if genslot is None:
            # Defensive only: context.duty_map is already filtered to the
            # run's date range by load_context, so this should not occur.
            continue
        gen_week, day = genslot

        doctor = context.doctor_by_id.get(doctor_id)
        code = doctor.code if doctor is not None else f"id={doctor_id}"
        slot = grid.get(doctor_id, gen_week, day, period)

        if slot is None:
            issues.append(ValidationIssue(
                severity="warning", phase=PHASE, check="duty_no_session_slot",
                week=gen_week, day=day, period=period,
                message=(
                    f"Duty doctor {code} ({duty_type.value}) has no session "
                    f"slot for {date_.isoformat()} {period.value} (no "
                    f"template row for this doctor/day/period)."
                ),
            ))
            continue

        if slot.role is not None:
            # Two DutyAssignment rows (e.g. primary and secondary) landing on
            # the same doctor/slot -- the schema doesn't prevent this. Keep
            # whichever was applied first (deterministic due to the sort
            # above) and warn rather than silently overwriting.
            issues.append(ValidationIssue(
                severity="warning", phase=PHASE, check="duty_role_conflict",
                week=gen_week, day=day, period=period,
                message=(
                    f"Duty doctor {code} already has role {slot.role.value} "
                    f"for {date_.isoformat()} {period.value}; cannot also "
                    f"apply {duty_type.value} duty to the same slot."
                ),
            ))
            continue

        slot.role = (
            SessionRole.DUTY_PRIMARY if duty_type == DutyType.PRIMARY
            else SessionRole.DUTY_SECONDARY
        )

    return issues