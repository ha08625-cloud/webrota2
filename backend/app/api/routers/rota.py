"""Rota router: generation lifecycle and session swaps (M3 Task 3).

Lifecycle rules (finalised M3 plan):
- One draft globally: generate returns 409 while any draft exists.
- Commit deletes the counter snapshots; the live counters become the
  baseline for future generations.
- Scrap (DELETE) restores counters to their snapshotted pre-generation
  values -- including undoing swap edits made during the draft -- then
  deletes the rota. 409 on committed rotas.
- Swaps are draft-only (409 on committed). swap-roles swaps
  (role, clinic_type_id) and adjusts ClinicCounter rows (get-or-create,
  floored at 0 on decrement); swap-rooms swaps room_id only, no counter
  change. Both re-run Phase 12 and return the fresh issues so the frontend
  can show "are you sure?"-grade warnings after a forced swap. Duty roles
  swap freely without touching DutyAssignment (a template, not an audit
  trail); Phase 12 reads roles from the grid, so re-validation stays
  correct.
"""
from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...models import (
    ClinicCounter,
    ClinicType,
    Doctor,
    GeneratedRota,
    LeaveEntry,
    Room,
    RotaConfig,
    RotaSession,
)
from ...models.enums import RotaStatus, SessionRole
from ...engine.generate import (
    commit_rota,
    generate,
    get_active_draft,
    scrap_rota,
)
from ...engine.grid_utils import run_phase12_for_rota
from ...engine.week_map import build_week_dates
from ..deps import get_current_user, get_db
from ..schemas import (
    GenerateRotaIn,
    GenerateRotaOut,
    RotaOut,
    RotaSessionOut,
    RotaSummaryOut,
    SessionPatchIn,
    SessionPatchOut,
    SwapIn,
    SwapOut,
    ValidationIssueOut,
)

router = APIRouter(prefix="/rota", tags=["rota"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_rota_or_404(db: Session, rota_id: int) -> GeneratedRota:
    rota = db.get(GeneratedRota, rota_id)
    if rota is None:
        raise HTTPException(status_code=404, detail=f"Rota {rota_id} not found")
    return rota


def _require_draft(rota: GeneratedRota) -> None:
    if rota.status != RotaStatus.DRAFT:
        raise HTTPException(
            status_code=409,
            detail=f"Rota {rota.id} is committed; this operation is draft-only",
        )


def _leave_lookup(
    db: Session, config: RotaConfig
) -> set[tuple[int, datetime.date, object]]:
    """Set of (doctor_id, date, period) leave keys within the rota's range."""
    range_start = config.start_date
    range_end = config.start_date + datetime.timedelta(days=config.num_weeks * 7)
    rows = db.execute(
        select(LeaveEntry).where(
            LeaveEntry.date >= range_start, LeaveEntry.date < range_end
        )
    ).scalars().all()
    return {(e.doctor_id, e.date, e.period) for e in rows}


def _session_outs(
    db: Session, config: RotaConfig, sessions: list[RotaSession]
) -> list[RotaSessionOut]:
    """Join doctor/room/clinic names and derive is_on_leave for API output."""
    doctor_codes = {d.id: d.code for d in db.execute(select(Doctor)).scalars()}
    room_codes = {r.id: r.code for r in db.execute(select(Room)).scalars()}
    clinic_names = {c.id: c.name for c in db.execute(select(ClinicType)).scalars()}
    week_dates = build_week_dates(config.start_date, config.num_weeks)
    leave = _leave_lookup(db, config)

    out: list[RotaSessionOut] = []
    for s in sessions:
        session_date = week_dates.get((s.week, s.day))
        out.append(RotaSessionOut(
            session_id=s.id,
            doctor_id=s.doctor_id,
            doctor_code=doctor_codes.get(s.doctor_id, "?"),
            week=s.week,
            day=s.day,
            period=s.period,
            room_id=s.room_id,
            room_code=room_codes.get(s.room_id) if s.room_id else None,
            clinic_type_id=s.clinic_type_id,
            clinic_type_name=(
                clinic_names.get(s.clinic_type_id) if s.clinic_type_id else None
            ),
            role=s.role,
            is_wfh=s.is_wfh,
            is_on_leave=(
                session_date is not None
                and (s.doctor_id, session_date, s.period) in leave
            ),
            notes=s.notes,
        ))
    return out


def _issues_out(db: Session, rota_id: int) -> list[ValidationIssueOut]:
    return [
        ValidationIssueOut.model_validate(i)
        for i in run_phase12_for_rota(db, rota_id)
    ]


def _adjust_clinic_counter(
    db: Session, doctor_id: int, clinic_type_id: int, delta: int
) -> None:
    """Get-or-create upsert; raw_count floored at 0 on decrement.

    Row creation on demand supports force-swapping to a previously-untracked
    doctor (M3 plan, resolution: counter rows for non-eligible doctors).
    Rows created during a draft are deleted again if the draft is scrapped.
    """
    row = db.execute(
        select(ClinicCounter).where(
            ClinicCounter.doctor_id == doctor_id,
            ClinicCounter.clinic_type_id == clinic_type_id,
        )
    ).scalar_one_or_none()
    if row is None:
        row = ClinicCounter(
            doctor_id=doctor_id, clinic_type_id=clinic_type_id, raw_count=0
        )
        db.add(row)
    row.raw_count = max(0, row.raw_count + delta)


def _load_swap_sessions(
    db: Session, rota_id: int, payload: SwapIn
) -> tuple[GeneratedRota, RotaSession, RotaSession]:
    rota = _get_rota_or_404(db, rota_id)
    _require_draft(rota)
    if payload.session_a_id == payload.session_b_id:
        raise HTTPException(status_code=400, detail="Cannot swap a session with itself")
    a = db.get(RotaSession, payload.session_a_id)
    b = db.get(RotaSession, payload.session_b_id)
    for sid, s in ((payload.session_a_id, a), (payload.session_b_id, b)):
        if s is None or s.rota_id != rota_id:
            raise HTTPException(
                status_code=404,
                detail=f"Session {sid} not found in rota {rota_id}",
            )
    return rota, a, b


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/generate", response_model=GenerateRotaOut)
def generate_rota(
    payload: GenerateRotaIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> GenerateRotaOut:
    if get_active_draft(db) is not None:
        raise HTTPException(
            status_code=409,
            detail="A draft rota already exists; commit or scrap it first",
        )

    config = RotaConfig(
        start_date=payload.start_date,
        num_weeks=payload.num_weeks,
        template_start_week=payload.template_start_week,
    )
    db.add(config)
    db.flush()

    result = generate(db, config.id)
    if result.status == "failed":
        # Phase 0 errors: no active template, duty-on-leave, non-Monday
        # start, etc. Nothing was written; not committing discards the
        # RotaConfig row too.
        raise HTTPException(
            status_code=422,
            detail=[
                ValidationIssueOut.model_validate(i).model_dump()
                for i in result.issues
            ],
        )

    db.commit()
    return GenerateRotaOut(
        rota_id=result.rota_id,
        status=RotaStatus.DRAFT,
        issues=[ValidationIssueOut.model_validate(i) for i in result.issues],
    )


@router.get("", response_model=list[RotaSummaryOut])
def list_rotas(
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> list[RotaSummaryOut]:
    """All rotas, newest first (M3.5 Task 1). The frontend derives the
    active draft (at most one by design) and the committed history from
    this list. No pagination: volume is tens per year."""
    rows = db.execute(
        select(GeneratedRota, RotaConfig)
        .join(RotaConfig, GeneratedRota.config_id == RotaConfig.id)
        .order_by(GeneratedRota.created_at.desc(), GeneratedRota.id.desc())
    ).all()
    return [
        RotaSummaryOut(
            rota_id=rota.id,
            status=rota.status,
            created_at=rota.created_at,
            start_date=config.start_date,
            num_weeks=config.num_weeks,
            template_start_week=config.template_start_week,
        )
        for rota, config in rows
    ]


@router.get("/{rota_id}", response_model=RotaOut)
def get_rota(
    rota_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> RotaOut:
    rota = _get_rota_or_404(db, rota_id)
    config = db.get(RotaConfig, rota.config_id)
    sessions = db.execute(
        select(RotaSession).where(RotaSession.rota_id == rota_id)
    ).scalars().all()
    return RotaOut(
        rota_id=rota.id,
        status=rota.status,
        created_at=rota.created_at,
        start_date=config.start_date,
        num_weeks=config.num_weeks,
        template_start_week=config.template_start_week,
        sessions=_session_outs(db, config, sessions),
    )


@router.get("/{rota_id}/issues", response_model=list[ValidationIssueOut])
def get_rota_issues(
    rota_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> list[ValidationIssueOut]:
    # Works on drafts and committed rotas (M3 plan, resolution 6).
    _get_rota_or_404(db, rota_id)
    return _issues_out(db, rota_id)


@router.post("/{rota_id}/commit", response_model=RotaOut)
def commit(
    rota_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> RotaOut:
    rota = _get_rota_or_404(db, rota_id)
    _require_draft(rota)
    commit_rota(db, rota_id)
    db.commit()
    return get_rota(rota_id, db=db, user=user)


@router.delete("/{rota_id}", status_code=204)
def scrap(
    rota_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> None:
    rota = _get_rota_or_404(db, rota_id)
    _require_draft(rota)
    scrap_rota(db, rota_id)
    db.commit()


@router.patch("/{rota_id}/sessions/{session_id}", response_model=SessionPatchOut)
def patch_session(
    rota_id: int,
    session_id: int,
    payload: SessionPatchIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> SessionPatchOut:
    """Draft-only partial update: is_wfh and/or notes (M3.5 Task 2).

    Setting is_wfh true also clears room_id (Q3 decision); the freed room
    is immediately free for that week/day/period since freeness is derived
    from session rows. Setting is_wfh false does NOT restore a room -- the
    slot warns unresolved_room until a room is dragged on. Phase 12 re-runs
    and its fresh issues are returned, matching the swap endpoints.
    """
    rota = _get_rota_or_404(db, rota_id)
    _require_draft(rota)
    s = db.get(RotaSession, session_id)
    if s is None or s.rota_id != rota_id:
        raise HTTPException(
            status_code=404,
            detail=f"Session {session_id} not found in rota {rota_id}",
        )

    fields = payload.model_fields_set
    if not fields:
        raise HTTPException(status_code=422, detail="Empty patch: provide is_wfh and/or notes")

    if "is_wfh" in fields and payload.is_wfh is not None:
        s.is_wfh = payload.is_wfh
        if payload.is_wfh:
            s.room_id = None
    if "notes" in fields:
        s.notes = payload.notes

    db.flush()
    issues = _issues_out(db, rota_id)
    db.commit()

    config = db.get(RotaConfig, rota.config_id)
    out = _session_outs(db, config, [s])[0]
    return SessionPatchOut(session=out, issues=issues)


@router.post("/{rota_id}/swap-roles", response_model=SwapOut)
def swap_roles(
    rota_id: int,
    payload: SwapIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> SwapOut:
    """Swap or move (role, clinic_type_id) between two draft sessions.

    M3.5 Tasks 3-4: one side may have no role, making this a move -- the
    counter guards below already handle an empty half correctly (decrement
    the source's clinic counter, increment the target's). Both sides empty
    is a 422: nothing to move. Eligibility is not checked server-side
    (consistent with force-swap); Phase 12 re-runs and returns warnings.
    """
    rota, a, b = _load_swap_sessions(db, rota_id, payload)

    if a.role is None and b.role is None:
        raise HTTPException(
            status_code=422,
            detail="Neither session has a role; nothing to swap or move",
        )

    old_a_role, old_a_ct = a.role, a.clinic_type_id
    old_b_role, old_b_ct = b.role, b.clinic_type_id

    a.role, b.role = old_b_role, old_a_role
    a.clinic_type_id, b.clinic_type_id = old_b_ct, old_a_ct

    # Counter updates (finalised M3 plan, Task 3). The != guard on the
    # second block makes a same-clinic-type swap a counter no-op.
    if old_a_role == SessionRole.CLINIC and old_a_ct is not None:
        _adjust_clinic_counter(db, a.doctor_id, old_a_ct, -1)
        _adjust_clinic_counter(db, b.doctor_id, old_a_ct, +1)
    if (
        old_b_role == SessionRole.CLINIC
        and old_b_ct is not None
        and old_b_ct != old_a_ct
    ):
        _adjust_clinic_counter(db, b.doctor_id, old_b_ct, -1)
        _adjust_clinic_counter(db, a.doctor_id, old_b_ct, +1)

    db.flush()
    issues = _issues_out(db, rota_id)
    db.commit()

    config = db.get(RotaConfig, rota.config_id)
    outs = _session_outs(db, config, [a, b])
    return SwapOut(session_a=outs[0], session_b=outs[1], issues=issues)


@router.post("/{rota_id}/swap-rooms", response_model=SwapOut)
def swap_rooms(
    rota_id: int,
    payload: SwapIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> SwapOut:
    """Swap or move room_id between two draft sessions (no counter effect).

    M3.5 Tasks 3-4: one side may have no room, making this a move. The
    deliberate consequence of a move is an unresolved_room warning on the
    source if its slot is REQUIRES_ROOM -- the signal to reassign. Both
    sides empty is a 422.
    """
    rota, a, b = _load_swap_sessions(db, rota_id, payload)

    if a.room_id is None and b.room_id is None:
        raise HTTPException(
            status_code=422,
            detail="Neither session has a room; nothing to swap or move",
        )

    a.room_id, b.room_id = b.room_id, a.room_id

    db.flush()
    issues = _issues_out(db, rota_id)
    db.commit()

    config = db.get(RotaConfig, rota.config_id)
    outs = _session_outs(db, config, [a, b])
    return SwapOut(session_a=outs[0], session_b=outs[1], issues=issues)