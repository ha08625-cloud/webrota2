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

import datetime

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..models import (
    ClinicCounter,
    GeneratedRota,
    RotaClinicCounterSnapshot,
    RotaClosure,
    RotaConfig,
    RotaGenerationLogEntry,
    RotaSession,
    RotaSystemCounterSnapshot,
    SystemCounter,
)
from ..models.enums import RotaStatus
from .context import load_context
from .datatypes import CounterState, DecisionLog, GenerationResult, RotaGrid, ValidationIssue
from .phases import (
    run_phase0,
    run_phase2,
    run_phase4,
    run_phase5,
    run_phase7_to_9a,
    run_phase9b,
    run_phase9c,
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
    log = DecisionLog()
    issues.extend(run_phase4(context, grid, log))
    issues.extend(run_phase5(context, grid, counters, log))
    issues.extend(run_phase7_to_9a(context, grid, counters, log))
    issues.extend(run_phase9b(context, grid, log))
    issues.extend(run_phase9c(context, grid, counters, log))
    issues.extend(run_phase12(context, grid))

    rota_id = _write_to_db(db, config_id, grid, counters, context.closed_dates, log)

    status = "partial" if any(i.severity == "warning" for i in issues) else "success"
    return GenerationResult(rota_id=rota_id, issues=tuple(issues), status=status)


def _write_to_db(
    db: Session,
    config_id: int,
    grid: RotaGrid,
    counters: CounterState,
    closed_dates: frozenset,
    log: DecisionLog,
) -> int:
    """Persist one generation run: the rota header, a snapshot of every
    pre-existing counter row, every session, the closed-date snapshot, the
    decision log, and the updated counters. Called once, at the end of a
    successful pipeline.

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
        # (NO_SURGERY / ADMIN_TIME / WFH with no clinic or duty role).
        # template_type is persisted directly as of M3.6 - RotaSession no
        # longer relies on re-deriving it from MasterRotaSession at read
        # time (see the model docstring for why).
        db.add(RotaSession(
            rota_id=rota.id,
            doctor_id=slot.doctor_id,
            week=slot.week,
            day=slot.day,
            period=slot.period,
            room_id=slot.assigned_room_id,
            clinic_type_id=slot.clinic_type_id,
            role=slot.role,
            template_type=slot.template_type,
            is_wfh=slot.is_wfh,
            notes=slot.notes,
            is_supervising=slot.is_supervising,
        ))

    # M5: snapshot every closed date that fell inside this run's range, so
    # grid_utils.rebuild_rota_grid() can later reconstruct this rota's
    # closures from RotaClosure rather than the (possibly since-edited)
    # PracticeClosure table -- deleting or adding a closure after this rota
    # exists must not change how it renders or validates.
    for closed_date in sorted(closed_dates):
        db.add(RotaClosure(rota_id=rota.id, date=closed_date))

    for entry in log.entries:
        db.add(RotaGenerationLogEntry(
            rota_id=rota.id, sequence=entry.sequence, phase=entry.phase,
            action=entry.action, week=entry.week, day=entry.day,
            period=entry.period, doctor_id=entry.doctor_id,
            related_doctor_id=entry.related_doctor_id, room_id=entry.room_id,
            related_room_id=entry.related_room_id,
            clinic_type_id=entry.clinic_type_id, message=entry.message,
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
    looked at, and scrap() -- or rollback_commit(), which restores from
    this same snapshot -- must be able to restore those too. Each call
    adds roughly (doctors x clinic types) + 2 x doctors rows: bounded per
    call, but no longer bounded in total, since commit_rota() no longer
    deletes the snapshot -- every committed rota's snapshot persists
    until that rota is scrapped, directly or after a rollback.
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
    """Commit a draft: set status=committed and record committed_at.

    Snapshots are no longer deleted here. They persist as a permanent
    audit record and are what rollback_commit() restores from when
    undoing a commit. committed_at records commit order and is what
    rollback_commit() uses to find, and enforce rollback against, "the
    most recently committed rota" -- strict reverse-chronological order
    only. The live counter values -- generation increments plus any swap
    edits -- become the baseline for future generations regardless of
    whether the snapshot is later used for a rollback. Raises ValueError
    if the rota does not exist or is already committed (the router maps
    this to 409/404).
    """
    rota = db.get(GeneratedRota, rota_id)
    if rota is None:
        raise ValueError(f"GeneratedRota id={rota_id} not found")
    if rota.status != RotaStatus.DRAFT:
        raise ValueError(f"Rota {rota_id} is already committed")

    rota.status = RotaStatus.COMMITTED
    rota.committed_at = datetime.datetime.now(datetime.timezone.utc)
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

    _restore_counters_from_snapshot(db, rota_id)
    _delete_snapshots(db, rota_id)
    db.delete(rota)  # ORM cascade removes RotaSession rows
    db.flush()


def rollback_commit(db: Session, rota_id: int) -> GeneratedRota:
    """Undo a commit, walking one step back through commit history.

    Restores this rota's counters to their pre-generation snapshot (the
    same restore logic scrap_rota() uses) and flips it back to draft,
    clearing both committed_at and archived_at, so it re-enters the
    normal draft lifecycle wholesale -- editable via the existing
    endpoints, scrappable via scrap_rota(), or re-committable via
    commit_rota() (which self-heals the chain by refreshing committed_at
    to now). This function does not delete the rota or its snapshot --
    that is scrap_rota()'s job, called separately if the user wants the
    rota gone after rolling it back.

    archived_at is cleared here, not just committed_at, because
    "archived" only has meaning for a committed rota (Design Decision 5,
    archive-committed-rotas plan): commit_rota() refreshes committed_at
    on re-commit regardless of any prior state, so a surviving
    archived_at would silently re-archive a freshly re-committed rota
    with no UI action explaining it.

    Strict reverse-chronological order is enforced two ways, deliberately
    without a separate locking mechanism:
    - get_active_draft(db) must return None. Because rolling back always
      produces a draft, and only one draft can exist globally (the same
      constraint generate() relies on), this alone blocks rolling back an
      older commit while a more recent rollback (or any other draft) is
      still sitting there unresolved.
    - This rota must independently be the most recently committed one,
      found by querying status=committed rows ordered by
      committed_at desc, id desc (NULLS treated as oldest, since a NULL
      committed_at only ever means "committed before rollback support
      existed" -- see the committed_at is None check below, which makes
      this ordering detail unreachable for the target rota but keeps a
      legacy NULL row from ever being mistaken for "most recent"). This
      is queried directly rather than inferred from the single-draft
      rule, so the ordering check stays correct even if the single-draft
      rule is ever relaxed later.

    Raises ValueError if: the rota does not exist; it is not currently
    committed; committed_at is None (committed before rollback support
    existed -- its snapshot was deleted at commit time under the old
    lifecycle, so there is nothing to restore from, and re-running this
    restore logic against an empty snapshot would delete every live
    counter row in the system); a draft already exists; this is not the
    most recently committed rota (message names the rota that must be
    rolled back first); or the rota has zero snapshot rows (belt-and-
    braces companion to the committed_at check -- a seeded system
    guarantees at least one snapshot row per legitimate generation, so an
    empty snapshot always means something is wrong). The router maps all
    of these to 409/404.
    """
    rota = db.get(GeneratedRota, rota_id)
    if rota is None:
        raise ValueError(f"GeneratedRota id={rota_id} not found")
    if rota.status != RotaStatus.COMMITTED:
        raise ValueError(f"Rota {rota_id} is not committed and cannot be rolled back")
    if rota.committed_at is None:
        raise ValueError(
            f"Rota {rota_id} was committed before rollback support existed "
            "and cannot be rolled back"
        )
    if get_active_draft(db) is not None:
        raise ValueError(
            "A draft already exists -- resolve it (commit or scrap) before "
            "rolling back a commit"
        )

    most_recent = db.execute(
        select(GeneratedRota)
        .where(GeneratedRota.status == RotaStatus.COMMITTED)
        .order_by(GeneratedRota.committed_at.desc().nullslast(), GeneratedRota.id.desc())
    ).scalars().first()
    if most_recent is None or most_recent.id != rota_id:
        blocker = most_recent.id if most_recent is not None else "none"
        raise ValueError(
            f"Rota {rota_id} is not the most recently committed rota -- "
            f"roll back rota {blocker} first"
        )

    has_clinic_snapshot = db.execute(
        select(RotaClinicCounterSnapshot.id)
        .where(RotaClinicCounterSnapshot.rota_id == rota_id)
        .limit(1)
    ).first()
    has_system_snapshot = db.execute(
        select(RotaSystemCounterSnapshot.id)
        .where(RotaSystemCounterSnapshot.rota_id == rota_id)
        .limit(1)
    ).first()
    if has_clinic_snapshot is None and has_system_snapshot is None:
        raise ValueError(
            f"Rota {rota_id} has no snapshot rows and cannot be rolled back"
        )

    _restore_counters_from_snapshot(db, rota_id)
    rota.status = RotaStatus.DRAFT
    rota.committed_at = None
    rota.archived_at = None
    db.flush()
    return rota


def _restore_counters_from_snapshot(db: Session, rota_id: int) -> None:
    """Restore every counter row to the value snapshotted for this rota.

    Shared by scrap_rota() and rollback_commit(): both need to undo every
    counter change made since this rota's snapshot was taken -- the
    generation's own increments plus any edits made afterward -- by
    restoring snapshotted rows to their pre-generation values, deleting
    rows absent from the snapshot (created after it), and recreating
    snapshotted rows that no longer exist live (deleted during the draft
    or committed period by some other action). Does not touch the
    snapshot rows themselves or the rota row -- callers decide what
    happens to those: scrap_rota() deletes both, rollback_commit() leaves
    the snapshot in place and flips the rota back to draft.
    """
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

    # Snapshotted rows that no longer exist as live rows are recreated at
    # their pre-generation values, so the restore is always exact.
    for (doctor_id, clinic_type_id), value in clinic_before.items():
        db.add(ClinicCounter(
            doctor_id=doctor_id, clinic_type_id=clinic_type_id, raw_count=value,
        ))
    for (doctor_id, counter_type), value in system_before.items():
        db.add(SystemCounter(
            doctor_id=doctor_id, counter_type=counter_type, raw_count=value,
        ))


def _delete_snapshots(db: Session, rota_id: int) -> None:
    db.execute(delete(RotaClinicCounterSnapshot).where(
        RotaClinicCounterSnapshot.rota_id == rota_id))
    db.execute(delete(RotaSystemCounterSnapshot).where(
        RotaSystemCounterSnapshot.rota_id == rota_id))