"""Master rota router: read-only view of the active template.

Master rota template editing endpoints are a deferred milestone (see
architecture.md, Outstanding Tasks); this router only exposes the single
active template for display, mirroring the read-only pattern of a
committed GeneratedRota.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...models import Doctor, MasterRotaSession, MasterRotaTemplate, Room
from ..deps import get_current_user, get_db
from ..schemas import MasterRotaSessionOut, MasterRotaTemplateOut

router = APIRouter(prefix="/master-rota", tags=["master_rota"])


@router.get("/active", response_model=MasterRotaTemplateOut)
def get_active_template(
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
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

    doctor_codes = {d.id: d.code for d in db.execute(select(Doctor)).scalars()}
    room_codes = {r.id: r.code for r in db.execute(select(Room)).scalars()}

    return MasterRotaTemplateOut(
        template_id=template.id,
        name=template.name,
        sessions=[
            MasterRotaSessionOut(
                session_id=s.id,
                doctor_id=s.doctor_id,
                doctor_code=doctor_codes.get(s.doctor_id, "?"),
                week=s.week,
                day=s.day,
                period=s.period,
                session_type=s.session_type,
                room_id=s.room_id,
                room_code=room_codes.get(s.room_id) if s.room_id else None,
            )
            for s in sessions
        ],
    )