"""Rota router: generation lifecycle and session swaps (M3 Task 3).

Lifecycle rules (finalised M3 plan, extended M3.7):
- One draft globally: generate returns 409 while any draft exists.
- generate also returns 409 if the requested date range overlaps a
  COMMITTED rota's range -- a committed week cannot be redrafted. Scrapped
  rotas are deleted outright and so never block a re-generation.
- Commit sets committed_at and keeps the counter snapshot (M3.7 -- it no
  longer deletes it); the live counters become the baseline for future
  generations regardless.
- Scrap (DELETE) restores counters to their snapshotted pre-generation
  values -- including undoing swap edits made during the draft -- then
  deletes the rota and its snapshot. 409 on committed rotas.
- Rollback (POST .../rollback-commit, M3.7) undoes a commit one step at a
  time: restores the rota's counters from its snapshot and flips it back
  to DRAFT, re-entering the normal draft lifecycle (editable, scrappable,
  re-committable). Only the most recently committed rota can be rolled
  back, and only while no draft currently exists -- see
  engine.generate.rollback_commit for the full ordering rationale. Unlike
  scrap, rollback does not delete anything; scrap remains the way to
  discard a rota after rolling it back.
- Force-delete (DELETE .../force-delete) is an escape hatch for committed
  rotas that cannot be rolled back (e.g. legacy committed_at=NULL commits)
  or other software-bug states -- not for everyday mistakes, where
  rollback remains correct. It permanently deletes the rota and its
  snapshot; counters are deliberately left untouched (see
  engine.generate.force_delete_rota for the rollback-interaction caveat
  this implies). No chain-order, snapshot-existence, or draft-elsewhere
  checks; archived_at is ignored. 409 on drafts, since scrap is their
  delete path.
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
    RotaClosure,
    RotaConfig,
    RotaGenerationLogEntry,
    RotaSession,
)
from ...models.enums import MasterSessionType, RotaStatus, SessionRole
from ...engine.generate import (
    commit_rota,
    force_delete_rota,
    generate,
    get_active_draft,
    rollback_commit,
    scrap_rota,
)
from ...engine.grid_utils import run_phase12_for_rota
from ...engine.week_map import build_week_dates
from ..deps import get_current_user, get_db
from ..schemas import (
    GenerateRotaIn,
    GenerateRotaOut,
    GenerationLogEntryOut,
    RotaOut,
    RotaSessionOut,
    RotaSummaryOut,
    SessionPatchIn,
    SessionPatchOut,
    SetRoleIn,
    SetRoleOut,
    SetRoomIn,
    SetRoomOut,
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


def _require_committed(rota: GeneratedRota) -> None:
    if rota.status != RotaStatus.COMMITTED:
        raise HTTPException(
            status_code=409,
            detail=f"Rota {rota.id} is a draft; this operation is committed-only",
        )


def _find_overlapping_committed_rota(
    db: Session, start_date: datetime.date, num_weeks: int
) -> tuple[GeneratedRota, RotaConfig] | None:
    """A committed rota whose date range intersects the requested range.

    Only COMMITTED rotas are checked: the at-most-one-draft rule already
    blocks generation while a draft exists (any week), and a scrapped rota
    is deleted outright, leaving no row to check against. Returns the first
    overlap found, ordered by start_date for a deterministic error message.
    """
    new_end = start_date + datetime.timedelta(days=num_weeks * 7)
    rows = db.execute(
        select(GeneratedRota, RotaConfig)
        .join(RotaConfig, GeneratedRota.config_id == RotaConfig.id)
        .where(GeneratedRota.status == RotaStatus.COMMITTED)
        .order_by(RotaConfig.start_date)
    ).all()
    for rota, config in rows:
        existing_end = config.start_date + datetime.timedelta(days=config.num_weeks * 7)
        if config.start_date < new_end and start_date < existing_end:
            return rota, config
    return None


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
            template_type=s.template_type,
            is_wfh=s.is_wfh,
            is_supervising=s.is_supervising,
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


def _closed_dates_out(db: Session, rota_id: int) -> list[datetime.date]:
    """A rota's closed dates, from its own RotaClosure snapshot -- not the
    live PracticeClosure table, so a closure added or removed after
    generation cannot change what this endpoint reports (M5)."""
    rows = db.execute(
        select(RotaClosure.date).where(RotaClosure.rota_id == rota_id)
    ).scalars().all()
    return sorted(rows)


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


def _find_room_holder(
    db: Session, rota_id: int, week: int, day, period, room_id: int, exclude_id: int
) -> RotaSession | None:
    """Session in the same slot already holding room_id, excluding self.

    Ordered by id for determinism and fetched with .first() rather than
    scalar_one_or_none(): duplicate holders should be impossible by
    construction, but a raised exception on dirty data is worse than
    displacing one of them (M4.1 plan).
    """
    return db.execute(
        select(RotaSession)
        .where(
            RotaSession.rota_id == rota_id,
            RotaSession.week == week,
            RotaSession.day == day,
            RotaSession.period == period,
            RotaSession.room_id == room_id,
            RotaSession.id != exclude_id,
        )
        .order_by(RotaSession.id)
    ).scalars().first()


def _find_role_holder(
    db: Session,
    rota_id: int,
    week: int,
    day,
    period,
    role: SessionRole,
    clinic_type_id: int | None,
    exclude_id: int,
) -> RotaSession | None:
    """Session in the same slot already holding (role[, clinic_type_id]),
    excluding self. Same defensive .first() as _find_room_holder."""
    conditions = [
        RotaSession.rota_id == rota_id,
        RotaSession.week == week,
        RotaSession.day == day,
        RotaSession.period == period,
        RotaSession.role == role,
        RotaSession.id != exclude_id,
    ]
    if clinic_type_id is not None:
        conditions.append(RotaSession.clinic_type_id == clinic_type_id)
    return db.execute(
        select(RotaSession).where(*conditions).order_by(RotaSession.id)
    ).scalars().first()



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

    overlap = _find_overlapping_committed_rota(
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
                "cannot be regenerated"
            ),
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
    this list. No pagination: volume is tens per year.

    Archived rotas (M6) are deliberately included, unfiltered -- the
    Committed/Archived tab split on RotaPage, and the rollback-eligibility
    scan of the full list, both depend on it. There is no query parameter
    to filter them out; that split is client-side by design."""
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
            committed_at=rota.committed_at,
            archived_at=rota.archived_at,
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
        closed_dates=_closed_dates_out(db, rota_id),
        committed_at=rota.committed_at,
        archived_at=rota.archived_at,
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


@router.get("/{rota_id}/log", response_model=list[GenerationLogEntryOut])
def get_rota_log(
    rota_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> list[GenerationLogEntryOut]:
    """The generation decision log, in the order the engine recorded it.

    Unlike /issues above, which persists nothing and re-runs Phase 12 via
    a grid rebuild on every request, this reads rows that were written
    once, in the same transaction as the rota, by generate._write_to_db()
    and never re-derived. No grid rebuild, no filter query parameters --
    a full 4-week run produces at most a few hundred rows, and filtering
    is done client-side. Works on drafts and committed rotas alike; empty
    for a rota with no log rows (e.g. one that predates this feature).
    """
    _get_rota_or_404(db, rota_id)
    rows = db.execute(
        select(RotaGenerationLogEntry)
        .where(RotaGenerationLogEntry.rota_id == rota_id)
        .order_by(RotaGenerationLogEntry.sequence)
    ).scalars().all()
    return [GenerationLogEntryOut.model_validate(r) for r in rows]


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


@router.post("/{rota_id}/rollback-commit", response_model=RotaOut)
def rollback_commit_endpoint(
    rota_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> RotaOut:
    """Undo a commit, one step back through commit history (M3.7).

    Unlike the other endpoints in this router, the 404/409 distinctions
    here are delegated to engine.generate.rollback_commit() rather than
    re-checked in the router first -- it already has to make five separate
    ValueError-raising checks (existence, status, committed_at NULL, an
    active draft in the way, and chain order), and re-deriving each of
    those from rota/query state here would just duplicate that logic with
    a chance of drifting out of sync. "not found" in the message is the
    only case that maps to 404; everything else rollback_commit() raises
    is a 409, and its message already names the blocking rota where
    relevant (e.g. an older commit rolled back out of order), so it is
    passed through as the detail unchanged.
    """
    try:
        rollback_commit(db, rota_id)
    except ValueError as exc:
        db.rollback()
        message = str(exc)
        status_code = 404 if "not found" in message else 409
        raise HTTPException(status_code=status_code, detail=message) from exc

    db.commit()
    return get_rota(rota_id, db=db, user=user)


@router.post("/{rota_id}/archive", response_model=RotaOut)
def archive(
    rota_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> RotaOut:
    """Hide a committed rota from the default "Committed" list (M6).

    Metadata-only: no engine involvement, no counter/session effect. Draft
    rotas cannot be archived (409 via _require_committed); an
    already-archived rota is also a 409, not a silent no-op.
    """
    rota = _get_rota_or_404(db, rota_id)
    _require_committed(rota)
    if rota.archived_at is not None:
        raise HTTPException(
            status_code=409, detail=f"Rota {rota.id} is already archived",
        )
    rota.archived_at = datetime.datetime.now(datetime.timezone.utc)
    db.commit()
    return get_rota(rota_id, db=db, user=user)


@router.post("/{rota_id}/unarchive", response_model=RotaOut)
def unarchive(
    rota_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> RotaOut:
    """Reverse of archive() (M6).

    No _require_committed guard here: a draft can never have archived_at
    set (only archive() sets it, and only on committed rotas), so the
    "not archived" 409 below already rejects a draft -- this is
    deliberate, not a missing check.
    """
    rota = _get_rota_or_404(db, rota_id)
    if rota.archived_at is None:
        raise HTTPException(
            status_code=409, detail=f"Rota {rota.id} is not archived",
        )
    rota.archived_at = None
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


@router.delete("/{rota_id}/force-delete", status_code=204)
def force_delete(
    rota_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> None:
    """Permanently delete a committed rota; counters are left untouched.

    An escape hatch for software-bug states -- the motivating case is a
    legacy commit with committed_at=None, which rollback-commit can never
    touch and which would otherwise sit forever blocking generate() from
    reusing its date range. Not a tool for everyday mistakes: rollback
    remains the correct way to undo a normal commit wherever it is
    eligible, since it keeps counters consistent with history. Force-delete
    does not -- see engine.generate.force_delete_rota's docstring for the
    rollback-interaction caveat this leaves behind.

    Unlike rollback, this endpoint performs no chain-order, committed_at,
    or snapshot-existence checks -- force_delete_rota() never touches
    counters, so none of those checks apply, and any committed rota can be
    deleted regardless of its position in the commit history. archived_at
    is also ignored server-side (archiving is a pure visibility flag); the
    frontend only offers this action on non-archived committed rotas.

    Delegates to engine.generate.force_delete_rota() the same way
    rollback-commit delegates to rollback_commit(): "not found" in the
    message maps to 404, everything else (a draft, since scrap is its
    delete path) maps to 409.
    """
    try:
        force_delete_rota(db, rota_id)
    except ValueError as exc:
        db.rollback()
        message = str(exc)
        status_code = 404 if "not found" in message else 409
        raise HTTPException(status_code=status_code, detail=message) from exc

    db.commit()


@router.patch("/{rota_id}/sessions/{session_id}", response_model=SessionPatchOut)
def patch_session(
    rota_id: int,
    session_id: int,
    payload: SessionPatchIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> SessionPatchOut:
    """Draft-only partial update: is_wfh, notes, and/or is_supervising
    (M3.5 Task 2; is_supervising added by the Phase 9C plan, section 4).

    Setting is_wfh true also clears room_id (Q3 decision); the freed room
    is immediately free for that week/day/period since freeness is derived
    from session rows. Setting is_wfh false does NOT restore a room -- the
    slot warns unresolved_room until a room is dragged on. is_supervising
    has no side effects in either direction: toggling is_wfh does not
    clear it (Phase 12's supervision_on_incompatible_slot check warns
    instead), and it does not adjust the SUPERVISION system counter --
    that counter is written at generation time only. Phase 12 re-runs and
    its fresh issues are returned, matching the swap endpoints.
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
        raise HTTPException(
            status_code=422,
            detail="Empty patch: provide is_wfh, notes, and/or is_supervising",
        )

    if "is_wfh" in fields and payload.is_wfh is not None:
        s.is_wfh = payload.is_wfh
        if payload.is_wfh:
            s.room_id = None
    if "notes" in fields:
        s.notes = payload.notes
    if "is_supervising" in fields and payload.is_supervising is not None:
        s.is_supervising = payload.is_supervising

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

@router.post("/{rota_id}/sessions/{session_id}/set-room", response_model=SetRoomOut)
def set_room(
    rota_id: int,
    session_id: int,
    payload: SetRoomIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> SetRoomOut:
    """One-sided room assign/clear with displacement (M4.1 Task 1).

    room_id=None clears the target's room -- no displacement lookup, no
    is_wfh change. room_id set: any other session in the same slot already
    holding that room is displaced (its room_id cleared to None), then the
    target takes the room and is_wfh is cleared if it was true (mirrors
    the PATCH is_wfh=true room-clear rule in reverse). Assigning the room
    the target already holds is a harmless no-op (lookup excludes self).
    No counter effect, matching swap-rooms. Draft-only.
    """
    rota = _get_rota_or_404(db, rota_id)
    _require_draft(rota)
    target = db.get(RotaSession, session_id)
    if target is None or target.rota_id != rota_id:
        raise HTTPException(
            status_code=404,
            detail=f"Session {session_id} not found in rota {rota_id}",
        )

    displaced: RotaSession | None = None
    if payload.room_id is None:
        target.room_id = None
    else:
        room = db.get(Room, payload.room_id)
        if room is None:
            raise HTTPException(
                status_code=404, detail=f"Room {payload.room_id} not found"
            )
        displaced = _find_room_holder(
            db, rota_id, target.week, target.day, target.period,
            payload.room_id, exclude_id=target.id,
        )
        if displaced is not None:
            displaced.room_id = None
        target.room_id = payload.room_id
        if target.is_wfh:
            target.is_wfh = False

    db.flush()
    issues = _issues_out(db, rota_id)
    db.commit()

    config = db.get(RotaConfig, rota.config_id)
    to_serialise = [target] if displaced is None else [target, displaced]
    outs = {s.session_id: s for s in _session_outs(db, config, to_serialise)}
    return SetRoomOut(
        session=outs[target.id],
        displaced_session=outs.get(displaced.id) if displaced is not None else None,
        issues=issues,
    )


@router.post("/{rota_id}/sessions/{session_id}/set-role", response_model=SetRoleOut)
def set_role(
    rota_id: int,
    session_id: int,
    payload: SetRoleIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> SetRoleOut:
    """Verbatim (role, clinic_type_id, template_type) triple setter with
    displacement, for the M4.1 cell-edit menu and its undo replay.

    The endpoint does not distinguish menu shapes from undo-restoration
    calls -- it always writes the given triple exactly. Displacement only
    applies to steal-class assignments: duty roles (same role, same slot)
    and clinic-type picks (role=clinic with a non-null clinic_type_id,
    same clinic_type_id, same slot). Everything else -- normal clinic,
    template shapes, unassign, and undo restorations with role=None -- has
    no displacement lookup. If the resulting state is role=None with
    template_type in (no_surgery, admin_time), the target's room is
    cleared (a no-surgery session silently holding a room would block it
    with no warning). Counter adjustments mirror swap-roles, with the
    same != guard making a same-clinic-type reassignment a no-op. Draft-only.

    is_supervising is untouched by this endpoint (Phase 9C plan, section
    4): an edit that invalidates a supervisor -- assigning them a clinic,
    moving them off a D/SR room, swapping their role -- is caught by Phase
    12's supervision_on_incompatible_slot check on the re-run this endpoint
    already triggers, not by any special-casing here.
    """
    rota = _get_rota_or_404(db, rota_id)
    _require_draft(rota)
    target = db.get(RotaSession, session_id)
    if target is None or target.rota_id != rota_id:
        raise HTTPException(
            status_code=404,
            detail=f"Session {session_id} not found in rota {rota_id}",
        )
    if payload.clinic_type_id is not None:
        ct = db.get(ClinicType, payload.clinic_type_id)
        if ct is None:
            raise HTTPException(
                status_code=404,
                detail=f"Clinic type {payload.clinic_type_id} not found",
            )

    old_role, old_ct = target.role, target.clinic_type_id

    displaced: RotaSession | None = None
    if payload.role in (SessionRole.DUTY_PRIMARY, SessionRole.DUTY_SECONDARY):
        displaced = _find_role_holder(
            db, rota_id, target.week, target.day, target.period,
            payload.role, None, exclude_id=target.id,
        )
    elif payload.role == SessionRole.CLINIC and payload.clinic_type_id is not None:
        displaced = _find_role_holder(
            db, rota_id, target.week, target.day, target.period,
            SessionRole.CLINIC, payload.clinic_type_id, exclude_id=target.id,
        )

    displaced_old_ct: int | None = None
    if displaced is not None:
        displaced_old_ct = displaced.clinic_type_id
        displaced.role = None
        displaced.clinic_type_id = None

    target.role = payload.role
    target.clinic_type_id = payload.clinic_type_id
    target.template_type = payload.template_type

    if (
        target.role is None
        and target.template_type in (MasterSessionType.NO_SURGERY, MasterSessionType.ADMIN_TIME)
    ):
        target.room_id = None

    # Counter adjustments (mirrors swap_roles: get-or-create, floored at 0).
    # Guarded so that reassigning a session to the clinic type it already
    # holds is a counter no-op, not a stray decrement with no increment.
    old_credit = old_role == SessionRole.CLINIC and old_ct is not None
    new_credit = target.role == SessionRole.CLINIC and target.clinic_type_id is not None
    same_credit = old_credit and new_credit and target.clinic_type_id == old_ct
    if old_credit and not same_credit:
        _adjust_clinic_counter(db, target.doctor_id, old_ct, -1)
    if new_credit and not same_credit:
        _adjust_clinic_counter(db, target.doctor_id, target.clinic_type_id, +1)
    if displaced is not None and displaced_old_ct is not None:
        _adjust_clinic_counter(db, displaced.doctor_id, displaced_old_ct, -1)

    db.flush()
    issues = _issues_out(db, rota_id)
    db.commit()

    config = db.get(RotaConfig, rota.config_id)
    to_serialise = [target] if displaced is None else [target, displaced]
    outs = {s.session_id: s for s in _session_outs(db, config, to_serialise)}
    return SetRoleOut(
        session=outs[target.id],
        displaced_session=outs.get(displaced.id) if displaced is not None else None,
        issues=issues,
    )