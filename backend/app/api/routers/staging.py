"""Staging router: create, read, edit, and abandon an editable copy of the
active template's rows for a date range (staging plan, Task 3).

Complete (POST /staging/{staging_id}/complete, which runs the generation
pipeline against the staged copy) is Task 4 and is not in this file.

Editing mirrors the master rota template's contract verbatim (see
routers/master_rota.py) -- pair setter, same-slot room displacement
including the PRE_ASSIGNED -> REQUIRES_ROOM demotion, permissive verbatim
writer with no eligibility checks. The staging plan's Design Decision 9
covers the one addition: session create 422s when week exceeds this
staging's own num_weeks.
"""
from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...engine.generate import (
    find_overlapping_committed_rota,
    get_active_draft,
    get_active_staging,
)
from ...engine.week_map import build_week_dates, template_week
from ...models import (
    Doctor,
    LeaveEntry,
    MasterRotaSession,
    MasterRotaTemplate,
    PracticeClosure,
    Room,
    RotaConfig,
    RotaStaging,
    RotaStagingSession,
)
from ...models.enums import MasterSessionType
from ..deps import get_current_user, get_db
from ..schemas import (
    StagingCreateIn,
    StagingOut,
    StagingSessionCreateIn,
    StagingSessionOut,
    StagingSessionPatchIn,
    StagingSessionWriteOut,
)

router = APIRouter(prefix="/staging", tags=["staging"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _staging_or_404(db: Session, staging_id: int) -> RotaStaging:
    staging = db.get(RotaStaging, staging_id)
    if staging is None:
        raise HTTPException(
            status_code=404, detail=f"Staging {staging_id} not found"
        )
    return staging


def _require_active(staging: RotaStaging) -> None:
    if staging.completed_at is not None:
        raise HTTPException(
            status_code=409,
            detail=f"Staging {staging.id} is completed; this operation is active-only",
        )


def _leave_lookup(
    db: Session, config: RotaConfig
) -> set[tuple[int, datetime.date, object]]:
    """Same query shape as routers/rota.py's _leave_lookup: every leave key
    within the config's date range."""
    range_start = config.start_date
    range_end = config.start_date + datetime.timedelta(days=config.num_weeks * 7)
    rows = db.execute(
        select(LeaveEntry).where(
            LeaveEntry.date >= range_start, LeaveEntry.date < range_end
        )
    ).scalars().all()
    return {(e.doctor_id, e.date, e.period) for e in rows}


def _session_outs(
    db: Session, config: RotaConfig, sessions: list[RotaStagingSession]
) -> list[StagingSessionOut]:
    """Join doctor_code/doctor_type/room_code and derive is_on_leave.
    Shared by every endpoint returning session rows so they never drift
    out of sync (mirrors master_rota.py's _session_outs)."""
    doctors = {d.id: d for d in db.execute(select(Doctor)).scalars()}
    room_codes = {r.id: r.code for r in db.execute(select(Room)).scalars()}
    week_dates = build_week_dates(config.start_date, config.num_weeks)
    leave = _leave_lookup(db, config)

    out: list[StagingSessionOut] = []
    for s in sessions:
        doctor = doctors.get(s.doctor_id)
        session_date = week_dates.get((s.week, s.day))
        out.append(StagingSessionOut(
            session_id=s.id,
            doctor_id=s.doctor_id,
            doctor_code=doctor.code if doctor is not None else "?",
            doctor_type=doctor.doctor_type,
            week=s.week,
            day=s.day,
            period=s.period,
            session_type=s.session_type,
            room_id=s.room_id,
            room_code=room_codes.get(s.room_id) if s.room_id else None,
            is_on_leave=(
                session_date is not None
                and (s.doctor_id, session_date, s.period) in leave
            ),
        ))
    return out


def _closed_dates_out(
    db: Session, config: RotaConfig
) -> list[datetime.date]:
    """Live PracticeClosure data in the config's range -- no snapshot exists
    for a staging (Design Decision 10), so this is the current table, not a
    frozen copy."""
    range_start = config.start_date
    range_end = config.start_date + datetime.timedelta(days=config.num_weeks * 7)
    rows = db.execute(
        select(PracticeClosure.date).where(
            PracticeClosure.date >= range_start, PracticeClosure.date < range_end
        )
    ).scalars().all()
    return sorted(rows)


def _staging_out(db: Session, staging: RotaStaging) -> StagingOut:
    config = db.get(RotaConfig, staging.config_id)
    sessions = db.execute(
        select(RotaStagingSession).where(RotaStagingSession.staging_id == staging.id)
    ).scalars().all()
    return StagingOut(
        staging_id=staging.id,
        config_id=staging.config_id,
        start_date=config.start_date,
        num_weeks=config.num_weeks,
        created_at=staging.created_at,
        completed_at=staging.completed_at,
        closed_dates=_closed_dates_out(db, config),
        sessions=_session_outs(db, config, sessions),
    )


def _find_room_holder(
    db: Session,
    staging_id: int,
    week: int,
    day,
    period,
    room_id: int,
    exclude_id: int | None = None,
) -> RotaStagingSession | None:
    """Session in the same staging slot already holding room_id, excluding
    self. Same .first()-over-scalar_one_or_none() defensiveness as the
    master rota / rota routers' equivalents: a duplicate holder should be
    impossible by construction, but displacing one of them is a better
    failure mode than a 500 on dirty data.

    exclude_id is optional (None) for POST/create, where no self row
    exists yet -- PATCH always passes the target session's own id."""
    conditions = [
        RotaStagingSession.staging_id == staging_id,
        RotaStagingSession.week == week,
        RotaStagingSession.day == day,
        RotaStagingSession.period == period,
        RotaStagingSession.room_id == room_id,
    ]
    if exclude_id is not None:
        conditions.append(RotaStagingSession.id != exclude_id)
    return db.execute(
        select(RotaStagingSession).where(*conditions).order_by(RotaStagingSession.id)
    ).scalars().first()


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("", response_model=StagingOut, status_code=201)
def create_staging(
    payload: StagingCreateIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> StagingOut:
    """Copy the active template's rows for [start_date, start_date +
    num_weeks) into a new run-scoped editable staging (staging plan,
    Design Decisions 1, 4, 5, 7, 10).

    Checks, in order, each a 409 with a distinct message:
    - no active draft (a draft must be resolved before starting a
      staging, mirroring generate's own first check)
    - no active staging (at most one globally)
    - no committed-rota overlap for the requested range
    - exactly one active MasterRotaTemplate (the engine's strict rule --
      staging is a generation precursor, so this is checked here rather
      than deferring to the master-rota GET's lowest-id resolution)
    """
    if get_active_draft(db) is not None:
        raise HTTPException(
            status_code=409,
            detail="A draft rota already exists; commit or scrap it first",
        )
    if get_active_staging(db) is not None:
        raise HTTPException(
            status_code=409,
            detail="A staging is already in progress; complete or abandon it first",
        )

    overlap = find_overlapping_committed_rota(
        db, payload.start_date, payload.num_weeks
    )
    if overlap is not None:
        existing_rota, existing_config = overlap
        raise HTTPException(
            status_code=409,
            detail=(
                f"A committed rota (id={existing_rota.id}) already covers "
                f"{existing_config.start_date.isoformat()} "
                f"({existing_config.num_weeks} week(s)); overlapping weeks "
                "cannot be staged"
            ),
        )

    active_templates = db.execute(
        select(MasterRotaTemplate).where(MasterRotaTemplate.is_active.is_(True))
    ).scalars().all()
    if len(active_templates) != 1:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Staging requires exactly one active master rota template "
                f"(found {len(active_templates)})"
            ),
        )
    template = active_templates[0]

    # template_start_week=1 always on the persisted config (Design Decision
    # 4): staging rows are keyed by generation week, so the pipeline must
    # see template_week() as the identity when it later runs against this
    # config. payload.template_start_week is applied once below, to select
    # which template weeks get copied, then discarded -- it is not stored.
    config = RotaConfig(
        start_date=payload.start_date,
        num_weeks=payload.num_weeks,
        template_start_week=1,
    )
    db.add(config)
    db.flush()

    staging = RotaStaging(config_id=config.id, source_template_id=template.id)
    db.add(staging)
    db.flush()

    template_rows = db.execute(
        select(MasterRotaSession).where(MasterRotaSession.template_id == template.id)
    ).scalars().all()
    rows_by_week: dict[int, list[MasterRotaSession]] = {}
    for row in template_rows:
        rows_by_week.setdefault(row.week, []).append(row)

    for gen_week in range(1, payload.num_weeks + 1):
        tw = template_week(gen_week, payload.template_start_week)
        for row in rows_by_week.get(tw, []):
            # Copied regardless of closures (Design Decision 10) -- Phase
            # 2's closed-date skip remains the single closure authority.
            db.add(RotaStagingSession(
                staging_id=staging.id,
                doctor_id=row.doctor_id,
                week=gen_week,
                day=row.day,
                period=row.period,
                session_type=row.session_type,
                room_id=row.room_id,
            ))

    db.flush()
    db.commit()
    return _staging_out(db, staging)


@router.get("/active", response_model=StagingOut)
def get_active_staging_endpoint(
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> StagingOut:
    staging = get_active_staging(db)
    if staging is None:
        raise HTTPException(status_code=404, detail="No active staging")
    return _staging_out(db, staging)


@router.patch(
    "/{staging_id}/sessions/{session_id}",
    response_model=StagingSessionWriteOut,
)
def patch_session(
    staging_id: int,
    session_id: int,
    payload: StagingSessionPatchIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> StagingSessionWriteOut:
    """Verbatim (session_type, room_id) pair setter with room displacement,
    mirroring master_rota.patch_session exactly (see its docstring)."""
    staging = _staging_or_404(db, staging_id)
    _require_active(staging)
    target = db.get(RotaStagingSession, session_id)
    if target is None or target.staging_id != staging_id:
        raise HTTPException(
            status_code=404,
            detail=f"Session {session_id} not found in staging {staging_id}",
        )

    displaced: RotaStagingSession | None = None
    if payload.room_id is not None:
        room = db.get(Room, payload.room_id)
        if room is None:
            raise HTTPException(
                status_code=404, detail=f"Room {payload.room_id} not found"
            )
        displaced = _find_room_holder(
            db, staging_id, target.week, target.day, target.period,
            payload.room_id, exclude_id=target.id,
        )
        if displaced is not None:
            displaced.room_id = None
            if displaced.session_type == MasterSessionType.PRE_ASSIGNED:
                displaced.session_type = MasterSessionType.REQUIRES_ROOM

    target.session_type = payload.session_type
    target.room_id = payload.room_id

    db.flush()
    db.commit()

    config = db.get(RotaConfig, staging.config_id)
    to_serialise = [target] if displaced is None else [target, displaced]
    outs = {s.session_id: s for s in _session_outs(db, config, to_serialise)}
    return StagingSessionWriteOut(
        session=outs[target.id],
        displaced_session=outs.get(displaced.id) if displaced is not None else None,
    )


@router.post(
    "/{staging_id}/sessions",
    response_model=StagingSessionWriteOut,
    status_code=201,
)
def create_session(
    staging_id: int,
    payload: StagingSessionCreateIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> StagingSessionWriteOut:
    """Create a new slot in the staging, mirroring master_rota.create_session
    (see its docstring). Additionally 422s when week exceeds this staging's
    own num_weeks (Design Decision 9)."""
    staging = _staging_or_404(db, staging_id)
    _require_active(staging)
    config = db.get(RotaConfig, staging.config_id)

    if payload.week > config.num_weeks:
        raise HTTPException(
            status_code=422,
            detail=(
                f"week {payload.week} is outside this staging's "
                f"{config.num_weeks}-week range"
            ),
        )

    doctor = db.get(Doctor, payload.doctor_id)
    if doctor is None:
        raise HTTPException(
            status_code=404, detail=f"Doctor {payload.doctor_id} not found"
        )

    existing = db.execute(
        select(RotaStagingSession).where(
            RotaStagingSession.staging_id == staging_id,
            RotaStagingSession.doctor_id == payload.doctor_id,
            RotaStagingSession.week == payload.week,
            RotaStagingSession.day == payload.day,
            RotaStagingSession.period == payload.period,
        )
    ).scalars().first()
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Doctor {payload.doctor_id} already has a session in "
                f"staging {staging_id} at week {payload.week} "
                f"{payload.day.value} {payload.period.value}"
            ),
        )

    displaced: RotaStagingSession | None = None
    if payload.room_id is not None:
        room = db.get(Room, payload.room_id)
        if room is None:
            raise HTTPException(
                status_code=404, detail=f"Room {payload.room_id} not found"
            )
        displaced = _find_room_holder(
            db, staging_id, payload.week, payload.day, payload.period,
            payload.room_id,
        )
        if displaced is not None:
            displaced.room_id = None
            if displaced.session_type == MasterSessionType.PRE_ASSIGNED:
                displaced.session_type = MasterSessionType.REQUIRES_ROOM

    target = RotaStagingSession(
        staging_id=staging_id,
        doctor_id=payload.doctor_id,
        week=payload.week,
        day=payload.day,
        period=payload.period,
        session_type=payload.session_type,
        room_id=payload.room_id,
    )
    db.add(target)

    db.flush()
    db.commit()

    to_serialise = [target] if displaced is None else [target, displaced]
    outs = {s.session_id: s for s in _session_outs(db, config, to_serialise)}
    return StagingSessionWriteOut(
        session=outs[target.id],
        displaced_session=outs.get(displaced.id) if displaced is not None else None,
    )


@router.delete("/{staging_id}/sessions/{session_id}", status_code=204)
def delete_session(
    staging_id: int,
    session_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> None:
    """Delete a slot from the staging, mirroring master_rota.delete_session."""
    staging = _staging_or_404(db, staging_id)
    _require_active(staging)
    target = db.get(RotaStagingSession, session_id)
    if target is None or target.staging_id != staging_id:
        raise HTTPException(
            status_code=404,
            detail=f"Session {session_id} not found in staging {staging_id}",
        )

    db.delete(target)
    db.commit()


@router.delete("/{staging_id}", status_code=204)
def abandon_staging(
    staging_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> None:
    """Abandon an active staging: hard-delete the staging (sessions cascade)
    and its RotaConfig (staging plan, Design Decision 3).

    409 on a completed staging -- that is a retained record of the run, not
    something this endpoint discards. Deleting the RotaConfig explicitly
    after the staging is safe here specifically because an *active* staging
    by construction has no GeneratedRota yet: the only path that creates
    one is complete(), which marks completed_at in the same transaction.
    """
    staging = _staging_or_404(db, staging_id)
    _require_active(staging)

    config = db.get(RotaConfig, staging.config_id)
    db.delete(staging)  # ORM cascade removes RotaStagingSession rows
    db.flush()  # staging row must be gone before the config delete below --
    # SQLite enforces FK constraints per-statement, and there is no
    # relationship() between RotaConfig and RotaStaging for the unit of
    # work to infer ordering from, so this cannot be left implicit.
    db.delete(config)
    db.commit()