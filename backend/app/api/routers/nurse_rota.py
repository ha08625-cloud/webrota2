"""Nurse rota router: the nurse-row view of the active master template.

A second permission area over the SAME table the master rota edits. The
partition is `Doctor.doctor_type == NURSE`, not a separate table, and two
rules are what make that partition a real boundary rather than a filter on
the read:

1. Every write resolves the target doctor and 404s unless they are a
   nurse -- 404 rather than 403, because the session is not part of this
   resource and a 403 would confirm it exists.
2. Room displacement, which the master rota does silently, refuses with a
   409 naming the holder when that holder is not a nurse. Displacement is
   the exact mechanism by which a nurse_rota-only login could otherwise
   reach and mutate a doctor's row, so this is the permission boundary
   itself. Nurse-on-nurse displacement keeps the master rota's behaviour.

The reverse is deliberately NOT symmetrical: a clinical writer on the
Master Rota can still displace a nurse. `clinical: write` is the superset.

The write paths carry no template_id -- the nurse surface only ever edits
the active template, so the router resolves it and 404s any session id
that is not in it. Without that check, dropping the path parameter would
let a nurse edit an archived template's rows by id.

Nurses are inert to the engine (engine/phases/_shared.INERT_TYPES), so
nothing here feeds generation beyond one fact: a room a nurse books is an
ordinary occupied room for that slot, and the generator will not hand it
to a doctor. That is correct, and it is visible to the rota administrator
on the Master Rota.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...models import Doctor, MasterRotaSession, MasterRotaTemplate, Room, User
from ...models.enums import DoctorType, MasterSessionType
from ..deps import get_current_user, get_db
from ..schemas import (
    MasterRotaSessionOut,
    NurseRotaOut,
    NurseSessionCreateIn,
    NurseSessionPatchIn,
    NurseSessionWriteOut,
    NurseSlotOccupancy,
    RoomOut,
)
from .master_rota import _find_room_holder, _session_outs

router = APIRouter(prefix="/nurse-rota", tags=["nurse_rota"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _active_template(db: Session) -> MasterRotaTemplate:
    """The active template, resolved exactly as master_rota does: lowest id
    among is_active rows, because is_active is not enforced unique (see
    MasterRotaTemplate's docstring) and a second active row must resolve
    deterministically rather than 500 the page."""
    template = db.execute(
        select(MasterRotaTemplate)
        .where(MasterRotaTemplate.is_active.is_(True))
        .order_by(MasterRotaTemplate.id)
    ).scalars().first()
    if template is None:
        raise HTTPException(status_code=404, detail="No active master rota template")
    return template


def _require_nurse(db: Session, doctor_id: int) -> Doctor:
    """The doctor, if they are a nurse. 404 otherwise -- for a non-nurse
    this resource does not contain them, and a 403 would say it does."""
    doctor = db.get(Doctor, doctor_id)
    if doctor is None or doctor.doctor_type != DoctorType.NURSE:
        raise HTTPException(
            status_code=404, detail=f"Nurse {doctor_id} not found"
        )
    return doctor


def _resolve_target(
    db: Session, session_id: int
) -> tuple[MasterRotaTemplate, MasterRotaSession]:
    """The active template and a session of it belonging to a nurse.

    404s in three places, all with the same shape: no active template, a
    session id that is not in the active template, and a session whose
    doctor is not a nurse."""
    template = _active_template(db)
    target = db.get(MasterRotaSession, session_id)
    if target is None or target.template_id != template.id:
        raise HTTPException(
            status_code=404, detail=f"Nurse rota session {session_id} not found"
        )
    _require_nurse(db, target.doctor_id)
    return template, target


def _displace_or_409(
    db: Session,
    template_id: int,
    week: int,
    day,
    period,
    room_id: int,
    exclude_id: int | None,
) -> MasterRotaSession | None:
    """Clear a nurse holder out of `room_id` in this slot, or refuse.

    The holder lookup is master_rota's own `_find_room_holder`, imported
    rather than copied: one copy of that predicate is the point, and the
    two routers write to the same table. Only the decision afterwards
    differs -- master displaces anybody, this refuses when the holder is
    not a nurse.
    """
    holder = _find_room_holder(
        db, template_id, week, day, period, room_id, exclude_id=exclude_id
    )
    if holder is None:
        return None

    holder_doctor = db.get(Doctor, holder.doctor_id)
    if holder_doctor is None or holder_doctor.doctor_type != DoctorType.NURSE:
        code = holder_doctor.code if holder_doctor is not None else "?"
        raise HTTPException(
            status_code=409,
            detail=(
                f"That room is taken by {code} in this session. Nurse rota "
                "edits cannot move a doctor out of a room."
            ),
        )

    holder.room_id = None
    if holder.session_type == MasterSessionType.PRE_ASSIGNED:
        holder.session_type = MasterSessionType.REQUIRES_ROOM
    return holder


def _require_room(db: Session, room_id: int) -> Room:
    room = db.get(Room, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail=f"Room {room_id} not found")
    return room


def _write_out(
    db: Session,
    target: MasterRotaSession,
    displaced: MasterRotaSession | None,
) -> NurseSessionWriteOut:
    to_serialise = [target] if displaced is None else [target, displaced]
    outs: dict[int, MasterRotaSessionOut] = {
        s.session_id: s for s in _session_outs(db, to_serialise)
    }
    return NurseSessionWriteOut(
        session=outs[target.id],
        displaced_session=outs.get(displaced.id) if displaced is not None else None,
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/active", response_model=NurseRotaOut)
def get_active_nurse_rota(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> NurseRotaOut:
    """The active template's nurse rows, every room, and who else holds
    which room.

    Non-nurse sessions contribute nothing but occupancy: a room_id, the
    slot it is held in, and the holder's code. Rooms are ALL rooms, not
    just treatment rooms -- a nurse may be placed in any room.
    """
    template = _active_template(db)

    sessions = db.execute(
        select(MasterRotaSession).where(
            MasterRotaSession.template_id == template.id
        )
    ).scalars().all()
    doctors = {d.id: d for d in db.execute(select(Doctor)).scalars()}
    rooms = db.execute(select(Room).order_by(Room.code)).scalars().all()
    room_codes = {r.id: r.code for r in rooms}

    nurse_sessions: list[MasterRotaSession] = []
    occupancy: list[NurseSlotOccupancy] = []
    for s in sessions:
        doctor = doctors.get(s.doctor_id)
        if doctor is not None and doctor.doctor_type == DoctorType.NURSE:
            nurse_sessions.append(s)
        elif s.room_id is not None:
            occupancy.append(NurseSlotOccupancy(
                week=s.week,
                day=s.day,
                period=s.period,
                room_id=s.room_id,
                room_code=room_codes.get(s.room_id, "?"),
                doctor_code=doctor.code if doctor is not None else "?",
            ))

    return NurseRotaOut(
        template_id=template.id,
        name=template.name,
        sessions=_session_outs(db, nurse_sessions),
        rooms=[RoomOut.model_validate(r) for r in rooms],
        occupancy=occupancy,
    )


@router.patch("/sessions/{session_id}", response_model=NurseSessionWriteOut)
def patch_nurse_session(
    session_id: int,
    payload: NurseSessionPatchIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> NurseSessionWriteOut:
    """Verbatim (session_type, room_id) pair setter on one nurse row."""
    template, target = _resolve_target(db, session_id)

    displaced: MasterRotaSession | None = None
    if payload.room_id is not None:
        _require_room(db, payload.room_id)
        displaced = _displace_or_409(
            db, template.id, target.week, target.day, target.period,
            payload.room_id, exclude_id=target.id,
        )

    target.session_type = payload.session_type
    target.room_id = payload.room_id

    db.flush()
    db.commit()
    return _write_out(db, target, displaced)


@router.post("/sessions", response_model=NurseSessionWriteOut, status_code=201)
def create_nurse_session(
    payload: NurseSessionCreateIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> NurseSessionWriteOut:
    """Create a nurse slot in the active template.

    Same displacement rule as PATCH, run before insert since there is no
    self row to exclude yet. No active-doctor check -- the server stays a
    permissive verbatim writer, as the master rota is, which is also what
    keeps undo-recreate working if a nurse is deactivated mid-session.
    """
    template = _active_template(db)
    _require_nurse(db, payload.doctor_id)

    existing = db.execute(
        select(MasterRotaSession).where(
            MasterRotaSession.template_id == template.id,
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
                f"Nurse {payload.doctor_id} already has a session at week "
                f"{payload.week} {payload.day.value} {payload.period.value}"
            ),
        )

    displaced: MasterRotaSession | None = None
    if payload.room_id is not None:
        _require_room(db, payload.room_id)
        displaced = _displace_or_409(
            db, template.id, payload.week, payload.day, payload.period,
            payload.room_id, exclude_id=None,
        )

    target = MasterRotaSession(
        template_id=template.id,
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
    return _write_out(db, target, displaced)


@router.delete("/sessions/{session_id}", status_code=204)
def delete_nurse_session(
    session_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    """Delete a nurse slot from the active template.

    Hard delete, as the master rota's is: MasterRotaSession has no
    children and the template has no draft/committed lifecycle. No
    response body -- the frontend captures undo data from the in-memory
    session before issuing the request.
    """
    _template, target = _resolve_target(db, session_id)
    db.delete(target)
    db.commit()
