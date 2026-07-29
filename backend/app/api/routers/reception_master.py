"""Reception weekday master template router: the read/write surface for
`reception_master_sessions`.

There is no displacement rule here, unlike routers/master_rota.py. The
clinical template needs one because a room can be held by only one doctor
at a time; a reception hour has no such exclusive resource, so several
staff sharing a (day, hour) slot is the normal case, not a conflict. Do
not port that logic here.

No coverage validation runs against the template. Coverage warnings are a
property of a dated day grid (see routers/reception_rota.py, once it
exists), not of the template -- the template has no date, so a shortfall
computed against it would not be actionable.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...engine.week_map import DAY_ORDER
from ...models import ReceptionMasterSession, ReceptionStaff
from ..deps import get_current_user, get_db
from ..schemas.reception import (
    ReceptionMasterSessionCreateIn,
    ReceptionMasterSessionOut,
    ReceptionMasterSessionPatchIn,
)

router = APIRouter(prefix="/reception/master", tags=["reception"])


def _session_out(session: ReceptionMasterSession, staff: ReceptionStaff) -> ReceptionMasterSessionOut:
    return ReceptionMasterSessionOut(
        session_id=session.id,
        staff_id=session.staff_id,
        staff_code=staff.code,
        staff_name=staff.name,
        day=session.day,
        hour=session.hour,
        role=session.role,
        note=session.note,
    )


def _get_session_or_404(db: Session, session_id: int) -> ReceptionMasterSession:
    session = db.get(ReceptionMasterSession, session_id)
    if session is None:
        raise HTTPException(
            status_code=404, detail=f"Master template session {session_id} not found"
        )
    return session


@router.get("", response_model=list[ReceptionMasterSessionOut])
def list_master_sessions(
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> list[ReceptionMasterSessionOut]:
    """The full flat template, one fetch -- at most a few hundred rows, and
    the grid pivots it client-side, exactly as GET /master-rota/active
    does. Ordered day, hour, staff_code; day is stored by value so it is
    ordered in Python rather than SQL, matching reception_coverage's list
    endpoint."""
    rows = db.execute(
        select(ReceptionMasterSession, ReceptionStaff)
        .join(ReceptionStaff, ReceptionMasterSession.staff_id == ReceptionStaff.id)
    ).all()
    ordered = sorted(
        rows, key=lambda row: (DAY_ORDER[row[0].day], row[0].hour, row[1].code)
    )
    return [_session_out(session, staff) for session, staff in ordered]


@router.post("/sessions", response_model=ReceptionMasterSessionOut, status_code=201)
def create_master_session(
    payload: ReceptionMasterSessionCreateIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ReceptionMasterSessionOut:
    """Create one (staff_id, day, hour) template slot. Pre-checks the slot
    and returns a descriptive 409 rather than letting the unique constraint
    raise -- the same documented exception to the catch-IntegrityError
    convention that the master rota session POST makes, for the same
    reason. Unknown staff_id is an explicit 404 lookup, not an FK error --
    on Postgres an FK violation surfaces at flush as a 500.

    Permissive by design, like the clinical template's writers: no
    active-staff check here. The frontend gates the add affordance to
    active staff; keeping the server permissive is what lets an undo
    recreate a row for a staff member deactivated in the meantime.
    """
    staff = db.get(ReceptionStaff, payload.staff_id)
    if staff is None:
        raise HTTPException(
            status_code=404, detail=f"Reception staff {payload.staff_id} not found"
        )

    existing = db.execute(
        select(ReceptionMasterSession).where(
            ReceptionMasterSession.staff_id == payload.staff_id,
            ReceptionMasterSession.day == payload.day,
            ReceptionMasterSession.hour == payload.hour,
        )
    ).scalars().first()
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Staff {payload.staff_id} already has a template session "
                f"at {payload.day.value} hour {payload.hour}"
            ),
        )

    session = ReceptionMasterSession(
        staff_id=payload.staff_id,
        day=payload.day,
        hour=payload.hour,
        role=payload.role,
        note=payload.note,
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return _session_out(session, staff)


@router.patch("/sessions/{session_id}", response_model=ReceptionMasterSessionOut)
def patch_master_session(
    session_id: int,
    payload: ReceptionMasterSessionPatchIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ReceptionMasterSessionOut:
    """Verbatim (role, note) pair setter -- both fields are always present
    in the request body, not a partial update, matching PATCH
    /master-rota/templates/{tid}/sessions/{sid}'s reasoning."""
    session = _get_session_or_404(db, session_id)
    session.role = payload.role
    session.note = payload.note
    db.commit()
    db.refresh(session)
    return _session_out(session, session.staff)


@router.delete("/sessions/{session_id}", status_code=204)
def delete_master_session(
    session_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> None:
    """Hard delete -- ReceptionMasterSession has no children and the
    template has no draft/committed lifecycle, so there is nothing to
    cascade or gate."""
    session = _get_session_or_404(db, session_id)
    db.delete(session)
    db.commit()
