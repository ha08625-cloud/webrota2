"""Doctor router.

DELETE is a soft delete (active=False). It returns 409 if the doctor has
sessions on a committed rota -- deactivating is fine, but the guard prevents
the frontend treating soft-delete as a data purge for doctors with history.
If the doctor only appears on the current draft, scrapping the draft first
is the correct path.

Counter invariant: every doctor row has exactly one SystemCounter row per
SystemCounterType (room_move, supervision), created here at doctor creation
regardless of doctor_type. Trainee/AHP rows sit unused at zero -- the cost
of a handful of dead rows buys a single unconditional invariant, closing
the PATCH edge case where a doctor's type changes to Partner/Salaried after
creation. `generate._write_counters` relies on this invariant via a strict
`.scalar_one()` and 500s the generation if it is ever violated (this
happened in production when doctors created through this router predated
the invariant -- see seed/backfill_system_counters.py for the repair).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...models import (
    Doctor,
    DoctorPreferredRoom,
    GeneratedRota,
    RotaSession,
    SystemCounter,
)
from ...models.enums import RotaStatus, SystemCounterType
from ..deps import get_current_user, get_db
from ..schemas import (
    DoctorDetailOut,
    DoctorIn,
    DoctorOut,
    DoctorPatch,
    PreferredRoomIn,
)

router = APIRouter(prefix="/doctors", tags=["doctors"])


def _get_or_404(db: Session, doctor_id: int) -> Doctor:
    doctor = db.get(Doctor, doctor_id)
    if doctor is None:
        raise HTTPException(status_code=404, detail=f"Doctor {doctor_id} not found")
    return doctor


@router.get("", response_model=list[DoctorOut])
def list_doctors(
    active_only: bool = True,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> list[Doctor]:
    stmt = select(Doctor).order_by(Doctor.code)
    if active_only:
        stmt = stmt.where(Doctor.active.is_(True))
    return db.execute(stmt).scalars().all()


@router.post("", response_model=DoctorOut, status_code=201)
def create_doctor(
    payload: DoctorIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> Doctor:
    doctor = Doctor(
        code=payload.code,
        doctor_type=payload.doctor_type,
        sessions_per_week=payload.sessions_per_week,
        supervision_preference=payload.supervision_preference,
        active=True,
    )
    db.add(doctor)
    try:
        # Flush (rather than commit) first: it assigns doctor.id for the
        # counter rows below, and surfaces a duplicate-code IntegrityError
        # before any counter rows are staged.
        db.flush()
        for counter_type in (SystemCounterType.ROOM_MOVE, SystemCounterType.SUPERVISION):
            db.add(
                SystemCounter(
                    doctor_id=doctor.id, counter_type=counter_type, raw_count=0
                )
            )
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409, detail=f"Doctor code '{payload.code}' already exists"
        ) from exc
    db.refresh(doctor)
    return doctor


@router.get("/{doctor_id}", response_model=DoctorDetailOut)
def get_doctor(
    doctor_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> Doctor:
    return _get_or_404(db, doctor_id)


@router.patch("/{doctor_id}", response_model=DoctorOut)
def patch_doctor(
    doctor_id: int,
    payload: DoctorPatch,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> Doctor:
    doctor = _get_or_404(db, doctor_id)
    updates = payload.model_dump(exclude_unset=True)
    for field, value in updates.items():
        setattr(doctor, field, value)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409, detail="Doctor code already exists"
        ) from exc
    db.refresh(doctor)
    return doctor


@router.put("/{doctor_id}/preferred-rooms", response_model=DoctorDetailOut)
def replace_preferred_rooms(
    doctor_id: int,
    payload: list[PreferredRoomIn],
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> Doctor:
    doctor = _get_or_404(db, doctor_id)
    # Replace-all pattern, but as two explicit statements rather than an
    # ORM collection reassignment. Assigning doctor.preferred_rooms = [...]
    # leaves the flush free to emit the INSERTs for the new rows before the
    # DELETEs for the old ones (nothing FK-links them), and the new rows
    # reuse the same (doctor_id, preference_order) values the old ones
    # still hold - tripping uq_dpr_doctor_order on essentially every edit.
    # Deleting first and flushing before inserting removes the race.
    db.execute(delete(DoctorPreferredRoom).where(DoctorPreferredRoom.doctor_id == doctor_id))
    db.flush()
    for p in payload:
        db.add(
            DoctorPreferredRoom(
                doctor_id=doctor_id,
                preference_order=p.preference_order,
                room_id=p.room_id,
                room_type=p.room_type,
            )
        )
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="Duplicate preference_order or invalid room reference",
        ) from exc
    db.refresh(doctor)
    return doctor


@router.delete("/{doctor_id}", response_model=DoctorOut)
def soft_delete_doctor(
    doctor_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> Doctor:
    doctor = _get_or_404(db, doctor_id)
    has_committed_sessions = db.execute(
        select(RotaSession.id)
        .join(GeneratedRota, RotaSession.rota_id == GeneratedRota.id)
        .where(
            RotaSession.doctor_id == doctor_id,
            GeneratedRota.status == RotaStatus.COMMITTED,
        )
        .limit(1)
    ).scalar_one_or_none()
    if has_committed_sessions is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Doctor {doctor_id} has sessions on a committed rota; "
                "set active=false via PATCH instead"
            ),
        )
    doctor.active = False
    db.commit()
    db.refresh(doctor)
    return doctor
