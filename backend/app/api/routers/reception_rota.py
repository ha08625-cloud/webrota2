"""Reception day rota router: generation, editing, and coverage validation
(reception rota, Task 4).

The day grid is a straight copy-then-edit, not a generation pipeline: POST
"" copies the weekday's master template rows onto a date (active staff
only), and everything after that is direct CRUD on the resulting
ReceptionRotaSession rows. There is no draft/commit lifecycle, no engine,
and no phases -- see ReceptionRota's docstring for why a bare header is
enough to distinguish "never generated" from "generated, then emptied".

Regenerating over an edited day is refused (409) rather than silently
overwritten -- DELETE /{id} then POST "" again is the only path back to a
fresh copy (Decision 6). The frontend puts a confirm dialog on that
delete-then-generate sequence; the server enforces no part of the confirm
itself.

Every mutating endpoint except the two 204 deletes returns
{session, issues}, recomputing coverage in the same transaction as the
write -- see compute_coverage_issues below -- so the grid never needs a
second request to learn whether an edit closed or opened a shortfall.
"""
from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...engine.week_map import DAY_ORDER
from ...models import (
    ReceptionCoverageRule,
    ReceptionMasterSession,
    ReceptionRota,
    ReceptionRotaSession,
    ReceptionStaff,
)
from ...models.enums import Day, ReceptionRole
from ..deps import get_current_user, get_db
from ..schemas import (
    ReceptionRotaGenerateIn,
    ReceptionRotaOut,
    ReceptionRotaSessionIn,
    ReceptionRotaSessionOut,
    ReceptionRotaSessionPatchIn,
    ReceptionSessionWriteOut,
    ValidationIssueOut,
)

router = APIRouter(prefix="/reception/rota", tags=["reception"])

_DAY_BY_WEEKDAY: dict[int, Day] = {weekday: day for day, weekday in DAY_ORDER.items()}


def _session_out(session: ReceptionRotaSession, staff: ReceptionStaff) -> ReceptionRotaSessionOut:
    return ReceptionRotaSessionOut(
        session_id=session.id,
        staff_id=session.staff_id,
        staff_code=staff.code,
        staff_name=staff.name,
        hour=session.hour,
        role=session.role,
        note=session.note,
    )


def _get_rota_or_404(db: Session, rota_id: int) -> ReceptionRota:
    rota = db.get(ReceptionRota, rota_id)
    if rota is None:
        raise HTTPException(status_code=404, detail=f"Rota {rota_id} not found")
    return rota


def _get_session_or_404(
    db: Session, rota_id: int, session_id: int
) -> ReceptionRotaSession:
    session = db.get(ReceptionRotaSession, session_id)
    if session is None or session.rota_id != rota_id:
        raise HTTPException(
            status_code=404,
            detail=f"Session {session_id} not found in rota {rota_id}",
        )
    return session


def compute_coverage_issues(db: Session, rota: ReceptionRota) -> list[ValidationIssueOut]:
    """One issue per (day, hour) where the rota's phones headcount falls
    short of the coverage rule. The rule map is loaded once for the rota's
    weekday; counts come off `rota.sessions` (already loaded, not re-queried
    per hour). A (day, hour) with no rule row emits nothing (Decision 8).
    Always severity="warning" -- nothing in this feature blocks."""
    day = _DAY_BY_WEEKDAY[rota.date.weekday()]
    rules = db.execute(
        select(ReceptionCoverageRule).where(ReceptionCoverageRule.day == day)
    ).scalars().all()

    counts: dict[int, int] = {}
    for session in rota.sessions:
        if session.role == ReceptionRole.PHONES:
            counts[session.hour] = counts.get(session.hour, 0) + 1

    issues: list[ValidationIssueOut] = []
    for rule in sorted(rules, key=lambda r: r.hour):
        count = counts.get(rule.hour, 0)
        if count < rule.min_phones_staff:
            issues.append(ValidationIssueOut(
                severity="warning",
                phase="coverage",
                check="phones_shortfall",
                message=(
                    f"{rule.hour:02d}:00-{rule.hour + 1:02d}:00: {count} "
                    f"staff on phones, {rule.min_phones_staff} required"
                ),
                day=day,
            ))
    return issues


def _rota_out(db: Session, rota: ReceptionRota) -> ReceptionRotaOut:
    rows = db.execute(
        select(ReceptionRotaSession, ReceptionStaff)
        .join(ReceptionStaff, ReceptionRotaSession.staff_id == ReceptionStaff.id)
        .where(ReceptionRotaSession.rota_id == rota.id)
        .order_by(ReceptionRotaSession.hour, ReceptionStaff.code)
    ).all()
    return ReceptionRotaOut(
        rota_id=rota.id,
        date=rota.date,
        created_at=rota.created_at,
        sessions=[_session_out(session, staff) for session, staff in rows],
        issues=compute_coverage_issues(db, rota),
    )


@router.post("", response_model=ReceptionRotaOut, status_code=201)
def generate_rota(
    payload: ReceptionRotaGenerateIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ReceptionRotaOut:
    """Copy the weekday's master template onto `date`, active staff only.
    Weekend dates are rejected by ReceptionRotaGenerateIn's validator
    (422) before this runs. An existing header for the date is a 409
    naming it -- regenerating never silently overwrites hand-edited rows;
    DELETE the existing rota first (Decision 6)."""
    existing = db.execute(
        select(ReceptionRota).where(ReceptionRota.date == payload.date)
    ).scalars().first()
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Rota {existing.id} already exists for {payload.date}; "
                "delete it first to regenerate"
            ),
        )

    day = _DAY_BY_WEEKDAY[payload.date.weekday()]
    template_rows = db.execute(
        select(ReceptionMasterSession)
        .join(ReceptionStaff, ReceptionMasterSession.staff_id == ReceptionStaff.id)
        .where(
            ReceptionMasterSession.day == day,
            ReceptionStaff.active.is_(True),
        )
    ).scalars().all()

    rota = ReceptionRota(date=payload.date)
    for row in template_rows:
        rota.sessions.append(ReceptionRotaSession(
            staff_id=row.staff_id, hour=row.hour, role=row.role, note=row.note,
        ))
    db.add(rota)
    db.flush()
    out = _rota_out(db, rota)
    db.commit()
    return out


@router.get("", response_model=ReceptionRotaOut)
def get_rota_by_date(
    date: datetime.date,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ReceptionRotaOut:
    """How the day page decides between offering "Generate" (404) and
    "you are editing an existing day" (200)."""
    rota = db.execute(
        select(ReceptionRota).where(ReceptionRota.date == date)
    ).scalars().first()
    if rota is None:
        raise HTTPException(status_code=404, detail=f"No rota for {date}")
    return _rota_out(db, rota)


@router.get("/{rota_id}", response_model=ReceptionRotaOut)
def get_rota(
    rota_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ReceptionRotaOut:
    rota = _get_rota_or_404(db, rota_id)
    return _rota_out(db, rota)


@router.post(
    "/{rota_id}/sessions", response_model=ReceptionSessionWriteOut, status_code=201
)
def create_session(
    rota_id: int,
    payload: ReceptionRotaSessionIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ReceptionSessionWriteOut:
    """Add a staff member to an hour. 409 on a duplicate
    (rota_id, staff_id, hour), 404 on unknown staff."""
    rota = _get_rota_or_404(db, rota_id)
    staff = db.get(ReceptionStaff, payload.staff_id)
    if staff is None:
        raise HTTPException(
            status_code=404, detail=f"Reception staff {payload.staff_id} not found"
        )

    existing = db.execute(
        select(ReceptionRotaSession).where(
            ReceptionRotaSession.rota_id == rota_id,
            ReceptionRotaSession.staff_id == payload.staff_id,
            ReceptionRotaSession.hour == payload.hour,
        )
    ).scalars().first()
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Staff {payload.staff_id} already has a session at hour "
                f"{payload.hour} in rota {rota_id}"
            ),
        )

    session = ReceptionRotaSession(
        rota_id=rota_id,
        staff_id=payload.staff_id,
        hour=payload.hour,
        role=payload.role,
        note=payload.note,
    )
    db.add(session)
    db.flush()
    issues = compute_coverage_issues(db, rota)
    db.commit()
    db.refresh(session)
    return ReceptionSessionWriteOut(session=_session_out(session, staff), issues=issues)


@router.patch(
    "/{rota_id}/sessions/{session_id}", response_model=ReceptionSessionWriteOut
)
def patch_session(
    rota_id: int,
    session_id: int,
    payload: ReceptionRotaSessionPatchIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ReceptionSessionWriteOut:
    """Verbatim (role, note) pair setter, same contract as the master
    template's PATCH."""
    rota = _get_rota_or_404(db, rota_id)
    session = _get_session_or_404(db, rota_id, session_id)
    session.role = payload.role
    session.note = payload.note
    db.flush()
    issues = compute_coverage_issues(db, rota)
    db.commit()
    db.refresh(session)
    return ReceptionSessionWriteOut(
        session=_session_out(session, session.staff), issues=issues
    )


@router.delete("/{rota_id}/sessions/{session_id}", status_code=204)
def delete_session(
    rota_id: int,
    session_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> None:
    """Remove a staff member from an hour -- this IS the absence mechanism
    (Decision 10): with reception leave tracking out of scope for v1, a
    receptionist who cannot work an hour is represented only by deleting
    their row for it, and coverage counts anyone with a remaining `phones`
    row regardless of why. 204 with no body; the frontend refetches the
    day rather than splicing the response, since issues need recomputing
    too and this is an infrequent action."""
    _get_rota_or_404(db, rota_id)
    session = _get_session_or_404(db, rota_id, session_id)
    db.delete(session)
    db.commit()


@router.delete("/{rota_id}", status_code=204)
def delete_rota(
    rota_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> None:
    """Delete the whole day; sessions cascade (ORM
    cascade="all, delete-orphan" on ReceptionRota.sessions). Backs the
    UI's regenerate-behind-a-confirm -- there is no force/regenerate flag,
    just delete-then-POST, and the confirm dialog is where the user is
    told edits will be lost (Decision 6)."""
    rota = _get_rota_or_404(db, rota_id)
    db.delete(rota)
    db.commit()
