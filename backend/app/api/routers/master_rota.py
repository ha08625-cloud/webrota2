"""Master rota router: read-only view of the active template, plus
per-session PATCH and POST/DELETE (session create/delete).

Editing is deliberately not draft-gated the way rota-session edits are --
the template has no draft/committed concept (see MasterRotaSession's
docstring). Edits affect future generations only: RotaSession snapshots
template_type at generation time, so existing drafts and committed rotas
are untouched by a template edit made afterwards. Phase 12 does not
run on the template; the endpoint's own displacement rule is the only
conflict-avoidance mechanism here.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...models import Doctor, MasterRotaSession, MasterRotaTemplate, Room, User
from ...models.enums import MasterSessionType
from ..deps import get_current_user, get_db
from ..schemas import (
    MasterRotaSessionOut,
    MasterRotaTemplateOut,
    MasterSessionCreateIn,
    MasterSessionPatchIn,
    MasterSessionWriteOut,
)

router = APIRouter(prefix="/master-rota", tags=["master_rota"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _session_outs(
    db: Session, sessions: list[MasterRotaSession]
) -> list[MasterRotaSessionOut]:
    """Join doctor_code/doctor_type/room_code for API output. Shared by the
    GET list and the PATCH response so the two never drift out of sync."""
    doctors = {d.id: d for d in db.execute(select(Doctor)).scalars()}
    room_codes = {r.id: r.code for r in db.execute(select(Room)).scalars()}

    out: list[MasterRotaSessionOut] = []
    for s in sessions:
        doctor = doctors.get(s.doctor_id)
        out.append(MasterRotaSessionOut(
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
        ))
    return out


def _find_room_holder(
    db: Session,
    template_id: int,
    week: int,
    day,
    period,
    room_id: int,
    exclude_id: int | None = None,
) -> MasterRotaSession | None:
    """Session in the same template slot already holding room_id, excluding
    self. Same-week only: a room held in a different week is not displaced.
    Ordered by id and fetched with .first() rather than scalar_one_or_none(),
    matching the rota-side _find_room_holder -- a duplicate holder should be
    impossible by construction, but raising on dirty data is worse than
    displacing one of them.

    exclude_id is optional (None) for POST/create, where no self row exists
    yet -- PATCH always passes the target session's own id."""
    conditions = [
        MasterRotaSession.template_id == template_id,
        MasterRotaSession.week == week,
        MasterRotaSession.day == day,
        MasterRotaSession.period == period,
        MasterRotaSession.room_id == room_id,
    ]
    if exclude_id is not None:
        conditions.append(MasterRotaSession.id != exclude_id)
    return db.execute(
        select(MasterRotaSession).where(*conditions).order_by(MasterRotaSession.id)
    ).scalars().first()


@router.get("/active", response_model=MasterRotaTemplateOut)
def get_active_template(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MasterRotaTemplateOut:
    # is_active is not enforced unique at the schema level (see
    # MasterRotaTemplate's docstring), so this deliberately picks the
    # lowest id rather than .scalar_one() -- a second active row must
    # not 500 the whole page, it should just resolve deterministically.
    template = db.execute(
        select(MasterRotaTemplate)
        .where(MasterRotaTemplate.is_active.is_(True))
        .order_by(MasterRotaTemplate.id)
    ).scalars().first()
    if template is None:
        raise HTTPException(status_code=404, detail="No active master rota template")

    sessions = db.execute(
        select(MasterRotaSession).where(MasterRotaSession.template_id == template.id)
    ).scalars().all()

    return MasterRotaTemplateOut(
        template_id=template.id,
        name=template.name,
        sessions=_session_outs(db, sessions),
    )


@router.patch(
    "/templates/{template_id}/sessions/{session_id}",
    response_model=MasterSessionWriteOut,
)
def patch_session(
    template_id: int,
    session_id: int,
    payload: MasterSessionPatchIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MasterSessionWriteOut:
    """Verbatim (session_type, room_id) pair setter with room displacement.

    Works on any template, active or not -- the frontend only ever passes
    the active one, but there's no reason to hard-couple the endpoint to
    is_active. Displacement only applies when the payload sets a non-null
    room_id: any other session in the same (template_id, week, day, period)
    already holding that room is displaced (room_id cleared to None; a
    displaced PRE_ASSIGNED becomes REQUIRES_ROOM since a roomless
    PRE_ASSIGNED means nothing to phase2, while a displaced ADMIN_TIME
    keeps its type). Assigning the room the target already holds is a
    no-op for displacement (the lookup excludes self). No counters, no
    Phase 12 -- the template has no draft/committed lifecycle to gate on.
    """
    if db.get(MasterRotaTemplate, template_id) is None:
        raise HTTPException(
            status_code=404, detail=f"Template {template_id} not found"
        )
    target = db.get(MasterRotaSession, session_id)
    if target is None or target.template_id != template_id:
        raise HTTPException(
            status_code=404,
            detail=f"Session {session_id} not found in template {template_id}",
        )

    displaced: MasterRotaSession | None = None
    if payload.room_id is not None:
        room = db.get(Room, payload.room_id)
        if room is None:
            raise HTTPException(
                status_code=404, detail=f"Room {payload.room_id} not found"
            )
        displaced = _find_room_holder(
            db, template_id, target.week, target.day, target.period,
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

    to_serialise = [target] if displaced is None else [target, displaced]
    outs = {s.session_id: s for s in _session_outs(db, to_serialise)}
    return MasterSessionWriteOut(
        session=outs[target.id],
        displaced_session=outs.get(displaced.id) if displaced is not None else None,
    )


@router.post(
    "/templates/{template_id}/sessions",
    response_model=MasterSessionWriteOut,
    status_code=201,
)
def create_session(
    template_id: int,
    payload: MasterSessionCreateIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> MasterSessionWriteOut:
    """Create a new slot in the template.

    Same displacement rule as PATCH (see patch_session's docstring), run
    before insert since there's no self row to exclude yet. No
    doctor-active check here -- the server stays a permissive verbatim
    writer, as PATCH is; the frontend gates the "add session"
    affordance to active doctors. This also keeps undo-recreate working
    if a doctor is deactivated mid-session.
    """
    if db.get(MasterRotaTemplate, template_id) is None:
        raise HTTPException(
            status_code=404, detail=f"Template {template_id} not found"
        )
    doctor = db.get(Doctor, payload.doctor_id)
    if doctor is None:
        raise HTTPException(
            status_code=404, detail=f"Doctor {payload.doctor_id} not found"
        )

    existing = db.execute(
        select(MasterRotaSession).where(
            MasterRotaSession.template_id == template_id,
            MasterRotaSession.doctor_id == payload.doctor_id,
            MasterRotaSession.week == payload.week,
            MasterRotaSession.day == payload.day,
            MasterRotaSession.period == payload.period,
        )
    ).scalars().first()
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Doctor {payload.doctor_id} already has a session in "
                f"template {template_id} at week {payload.week} "
                f"{payload.day.value} {payload.period.value}"
            ),
        )

    displaced: MasterRotaSession | None = None
    if payload.room_id is not None:
        room = db.get(Room, payload.room_id)
        if room is None:
            raise HTTPException(
                status_code=404, detail=f"Room {payload.room_id} not found"
            )
        displaced = _find_room_holder(
            db, template_id, payload.week, payload.day, payload.period,
            payload.room_id,
        )
        if displaced is not None:
            displaced.room_id = None
            if displaced.session_type == MasterSessionType.PRE_ASSIGNED:
                displaced.session_type = MasterSessionType.REQUIRES_ROOM

    target = MasterRotaSession(
        template_id=template_id,
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
    outs = {s.session_id: s for s in _session_outs(db, to_serialise)}
    return MasterSessionWriteOut(
        session=outs[target.id],
        displaced_session=outs.get(displaced.id) if displaced is not None else None,
    )


@router.delete(
    "/templates/{template_id}/sessions/{session_id}",
    status_code=204,
)
def delete_session(
    template_id: int,
    session_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    """Delete a slot from the template.

    Hard delete -- MasterRotaSession has no children and the template has
    no draft/committed lifecycle, so there's nothing to cascade or gate.
    No response body: the frontend captures undo data from the in-memory
    session before issuing the request, as it does for PATCH, and
    apiClient's request() already special-cases 204 to return undefined.
    """
    if db.get(MasterRotaTemplate, template_id) is None:
        raise HTTPException(
            status_code=404, detail=f"Template {template_id} not found"
        )
    target = db.get(MasterRotaSession, session_id)
    if target is None or target.template_id != template_id:
        raise HTTPException(
            status_code=404,
            detail=f"Session {session_id} not found in template {template_id}",
        )

    db.delete(target)
    db.commit()