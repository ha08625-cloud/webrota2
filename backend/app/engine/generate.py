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

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..models import (
    ClinicCounter,
    GeneratedRota,
    RotaClinicCounterSnapshot,
    RotaConfig,
    RotaSession,
    RotaSystemCounterSnapshot,
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
    """Persist one generation run: the rota header, a snapshot of every
    pre-existing counter row, every session, and the updated counters.
    Called once, at the end of a successful pipeline.

    Snapshot ordering matters (M3 plan, resolution 3): the snapshot is taken
    from the DB *before* _write_counters mutates any counter row, so it holds
    exact pre-generation values. Scrapping the draft later restores these
    values wholesale -- undoing both the generation's increments and any
    manual swap edits made while the rota was a draft.
    """
    rota = GeneratedRota(config_id=config_id, status=RotaStatus.DRAFT)
    db.add(rota)
    db.flush()  # populate rota.id for the snapshot and RotaSession FKs below

    _snapshot_counters(db, rota.id)

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


def _snapshot_counters(db: Session, rota_id: int) -> None:
    """Snapshot every existing counter row's current value against a rota.

    All rows are captured, not just those the generation will touch: swap
    edits during the draft period can change counters the generation never
    looked at, and scrap must restore those too. Bounded at roughly
    (doctors x clinic types) + 2 x doctors rows, and at most one draft
    exists at a time.
    """
    for row in db.execute(select(ClinicCounter)).scalars():
        db.add(RotaClinicCounterSnapshot(
            rota_id=rota_id, doctor_id=row.doctor_id,
            clinic_type_id=row.clinic_type_id, value_before=row.raw_count,
        ))
    for row in db.execute(select(SystemCounter)).scalars():
        db.add(RotaSystemCounterSnapshot(
            rota_id=rota_id, doctor_id=row.doctor_id,
            counter_type=row.counter_type, value_before=row.raw_count,
        ))


def get_active_draft(db: Session) -> GeneratedRota | None:
    """The single draft rota, or None. One draft exists globally at most
    (M3 plan, resolution 7); the generate endpoint 409s if this is not None.
    """
    return db.execute(
        select(GeneratedRota).where(GeneratedRota.status == RotaStatus.DRAFT)
    ).scalars().first()


def commit_rota(db: Session, rota_id: int) -> GeneratedRota:
    """Commit a draft: delete its snapshots and set status=committed.

    The live counter values -- generation increments plus any swap edits --
    become the baseline for future generations. Raises ValueError if the
    rota does not exist or is already committed (the router maps this
    to 409/404).
    """
    rota = db.get(GeneratedRota, rota_id)
    if rota is None:
        raise ValueError(f"GeneratedRota id={rota_id} not found")
    if rota.status != RotaStatus.DRAFT:
        raise ValueError(f"Rota {rota_id} is already committed")

    _delete_snapshots(db, rota_id)
    rota.status = RotaStatus.COMMITTED
    db.flush()
    return rota


def scrap_rota(db: Session, rota_id: int) -> None:
    """Discard a draft: restore all counters to their snapshotted
    pre-generation values, then delete the rota and its snapshots.

    Runs entirely within the caller's transaction (M3 plan, resolution 4).
    Counter rows whose key is absent from the snapshot were created during
    the draft period (generation reaching a new (doctor, clinic type) pair,
    or a forced swap to a previously-untracked doctor) and are deleted.
    Raises ValueError if the rota does not exist or is committed.
    """
    rota = db.get(GeneratedRota, rota_id)
    if rota is None:
        raise ValueError(f"GeneratedRota id={rota_id} not found")
    if rota.status != RotaStatus.DRAFT:
        raise ValueError(f"Rota {rota_id} is committed and cannot be scrapped")

    clinic_snaps = db.execute(
        select(RotaClinicCounterSnapshot)
        .where(RotaClinicCounterSnapshot.rota_id == rota_id)
    ).scalars().all()
    system_snaps = db.execute(
        select(RotaSystemCounterSnapshot)
        .where(RotaSystemCounterSnapshot.rota_id == rota_id)
    ).scalars().all()

    clinic_before = {(s.doctor_id, s.clinic_type_id): s.value_before for s in clinic_snaps}
    system_before = {(s.doctor_id, s.counter_type): s.value_before for s in system_snaps}

    # Restore snapshotted rows; delete rows created after the snapshot.
    for row in db.execute(select(ClinicCounter)).scalars().all():
        key = (row.doctor_id, row.clinic_type_id)
        if key in clinic_before:
            row.raw_count = clinic_before.pop(key)
        else:
            db.delete(row)
    for row in db.execute(select(SystemCounter)).scalars().all():
        key = (row.doctor_id, row.counter_type)
        if key in system_before:
            row.raw_count = system_before.pop(key)
        else:
            db.delete(row)

    # Snapshotted rows that no longer exist as live rows (deleted during the
    # draft period, e.g. via a future admin action) are recreated at their
    # pre-generation values, so scrap always restores the exact prior state.
    for (doctor_id, clinic_type_id), value in clinic_before.items():
        db.add(ClinicCounter(
            doctor_id=doctor_id, clinic_type_id=clinic_type_id, raw_count=value,
        ))
    for (doctor_id, counter_type), value in system_before.items():
        db.add(SystemCounter(
            doctor_id=doctor_id, counter_type=counter_type, raw_count=value,
        ))

    _delete_snapshots(db, rota_id)
    db.delete(rota)  # ORM cascade removes RotaSession rows
    db.flush()


def _delete_snapshots(db: Session, rota_id: int) -> None:
    db.execute(delete(RotaClinicCounterSnapshot).where(
        RotaClinicCounterSnapshot.rota_id == rota_id))
    db.execute(delete(RotaSystemCounterSnapshot).where(
        RotaSystemCounterSnapshot.rota_id == rota_id))
