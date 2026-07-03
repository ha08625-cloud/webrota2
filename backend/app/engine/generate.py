"""Orchestrates the full generation pipeline and persists the result.

generate() runs Phase 0 -> 2 -> 4 -> 5 -> 7-9A -> 9B -> 12 in order, then
writes the outcome in one transaction via _write_to_db(). The caller is
expected to run generate() inside its own `session.begin()` (or equivalent);
any uncaught exception here rolls back everything, including counter
writes. Warnings never raise -- only a Phase 0 error stops the pipeline
before anything is written.

Deviation from the M2 plan's own generate() sketch, flagged when Phase 2
was built (step 4): run_phase2() takes a `db` parameter here. The plan's
pseudocode showed `run_phase2(context, config)` with no db argument, but
Phase 2's own description requires DB access to load ClinicCounter/
SystemCounter rows into the CounterState working copy -- the sketch was
simplified and this fixes that inconsistency.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import (
    ClinicCounter,
    GeneratedRota,
    RotaConfig,
    RotaSession,
    SystemCounter,
)
from ..models.enums import RotaStatus
from .context import load_context
from .datatypes import CounterState, GenerationResult, RotaGrid, ValidationIssue
from .phases import (
    run_phase0,
    run_phase2,
    run_phase4,
    run_phase5,
    run_phase7_to_9a,
    run_phase9b,
    run_phase12,
)


def generate(db: Session, config_id: int) -> GenerationResult:
    config = db.get(RotaConfig, config_id)
    if config is None:
        raise ValueError(f"RotaConfig id={config_id} not found")

    context = load_context(db, config)

    issues: list[ValidationIssue] = []
    p0_issues = run_phase0(context, config)
    issues.extend(p0_issues)
    if any(i.severity == "error" for i in p0_issues):
        return GenerationResult(rota_id=None, issues=tuple(issues), status="failed")

    grid, counters = run_phase2(context, config, db)
    issues.extend(run_phase4(context, grid))
    issues.extend(run_phase5(context, grid, counters))
    issues.extend(run_phase7_to_9a(context, grid, counters))
    issues.extend(run_phase9b(context, grid))
    issues.extend(run_phase12(context, grid))

    rota_id = _write_to_db(db, config_id, grid, counters)

    status = "partial" if any(i.severity == "warning" for i in issues) else "success"
    return GenerationResult(rota_id=rota_id, issues=tuple(issues), status=status)


def _write_to_db(db: Session, config_id: int, grid: RotaGrid, counters: CounterState) -> int:
    """Persist one generation run: the rota header, every session, and the
    updated counters. Called once, at the end of a successful pipeline.

    Factored as a single function (not split further) so M3 can wrap it with
    a "snapshot all existing counter rows before this call" step without
    restructuring -- see the M2 plan's `_write_to_db` note. M3 will also add
    the snapshot tables and scrap_rota().
    """
    rota = GeneratedRota(config_id=config_id, status=RotaStatus.DRAFT)
    db.add(rota)
    db.flush()  # populate rota.id for the RotaSession FK below

    for slot in grid.slots.values():
        # Every slot is written, including template-type-only ones
        # (NO_SURGERY / ADMIN_TIME / WFH with no clinic or duty role) -- the
        # M2 plan is explicit that RotaSession has no session_type column of
        # its own; that type is re-derived from MasterRotaSession later.
        db.add(RotaSession(
            rota_id=rota.id,
            doctor_id=slot.doctor_id,
            week=slot.week,
            day=slot.day,
            period=slot.period,
            room_id=slot.assigned_room_id,
            clinic_type_id=slot.clinic_type_id,
            role=slot.role,
            is_wfh=slot.is_wfh,
            notes=slot.notes,
        ))

    _write_counters(db, counters)

    db.flush()
    return rota.id


def _write_counters(db: Session, counters: CounterState) -> None:
    """Upsert every counter touched during this run.

    Clinic counters: INSERT for keys CounterState marked new (no prior DB
    row), UPDATE otherwise. System counters always UPDATE -- M1's
    seed_system_counters guarantees a room_move and supervision row already
    exists for every active doctor, so `.scalar_one()` intentionally raises
    if that guarantee has somehow been violated, rather than silently
    creating a duplicate or inconsistent row.
    """
    for (doctor_id, clinic_type_id), raw_count in counters.clinic.items():
        if counters.is_new_clinic_key(doctor_id, clinic_type_id):
            db.add(ClinicCounter(
                doctor_id=doctor_id, clinic_type_id=clinic_type_id, raw_count=raw_count,
            ))
        else:
            row = db.execute(
                select(ClinicCounter).where(
                    ClinicCounter.doctor_id == doctor_id,
                    ClinicCounter.clinic_type_id == clinic_type_id,
                )
            ).scalar_one()
            row.raw_count = raw_count

    for (doctor_id, counter_type), raw_count in counters.system.items():
        row = db.execute(
            select(SystemCounter).where(
                SystemCounter.doctor_id == doctor_id,
                SystemCounter.counter_type == counter_type,
            )
        ).scalar_one()
        row.raw_count = raw_count
