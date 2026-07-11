"""ClinicType router

Writes accept the full nested object (parent + schedules +
doctor_eligibilities + room_eligibilities) in one transaction, per the M3
plan. PUT uses the replace-children pattern: all existing child rows are
deleted and the new set inserted -- simpler than diffing, and safe for
counter history because ClinicCounter is keyed on values, never on child-row
FKs (M1 design decision).

Children are cleared and flushed before the replacement set is attached
(see `_apply`) -- SQLAlchemy does not guarantee that the DELETEs for
delete-orphan children are flushed before the INSERTs for a reassigned
collection on the same table, so an edit that keeps even one schedule slot,
doctor, or room unchanged can otherwise trigger a spurious unique-constraint
IntegrityError.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...models import (
    ClinicType,
    ClinicTypeDoctorEligibility,
    ClinicTypeRoomEligibility,
    ClinicTypeSchedule,
)
from ..deps import get_current_user, get_db
from ..schemas import ClinicTypeIn, ClinicTypeOut

router = APIRouter(prefix="/clinic-types", tags=["clinic_types"])


def _get_or_404(db: Session, clinic_type_id: int) -> ClinicType:
    ct = db.get(ClinicType, clinic_type_id)
    if ct is None:
        raise HTTPException(
            status_code=404, detail=f"ClinicType {clinic_type_id} not found"
        )
    return ct


def _children_from_payload(payload: ClinicTypeIn) -> tuple[list, list, list]:
    schedules = [
        ClinicTypeSchedule(day=s.day, period=s.period) for s in payload.schedules
    ]
    doctor_eligs = [
        ClinicTypeDoctorEligibility(
            doctor_id=e.doctor_id, doctor_priority=e.doctor_priority
        )
        for e in payload.doctor_eligibilities
    ]
    room_eligs = [
        ClinicTypeRoomEligibility(room_id=e.room_id, room_type=e.room_type)
        for e in payload.room_eligibilities
    ]
    return schedules, doctor_eligs, room_eligs


def _apply(db: Session, ct: ClinicType, payload: ClinicTypeIn) -> None:
    ct.name = payload.name
    ct.clinic_priority = payload.clinic_priority
    ct.is_enabled = payload.is_enabled
    ct.room_required = payload.room_required
    ct.category = payload.category

    # Clear the existing children and flush the deletes before attaching the
    # replacement set. Assigning a brand-new list directly to the relationship
    # still works via the delete-orphan cascade, but the DELETEs and INSERTs
    # for the old and new rows are not guaranteed to be ordered DELETE-first
    # within the same flush -- if a new row shares a unique key (day/period,
    # doctor_id, or room_id/room_type) with a row being replaced, the INSERT
    # can be attempted while the old row is still present, raising a
    # spurious IntegrityError even though the end state would be valid.
    ct.schedules.clear()
    ct.doctor_eligibilities.clear()
    ct.room_eligibilities.clear()
    db.flush()

    schedules, doctor_eligs, room_eligs = _children_from_payload(payload)
    ct.schedules = schedules
    ct.doctor_eligibilities = doctor_eligs
    ct.room_eligibilities = room_eligs


def _apply_and_commit(db: Session, ct: ClinicType, payload: ClinicTypeIn) -> None:
    try:
        _apply(db, ct, payload)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail=(
                f"ClinicType '{payload.name}' violates a uniqueness constraint "
                "(duplicate name, schedule slot, doctor, or room eligibility)"
            ),
        ) from exc


@router.get("", response_model=list[ClinicTypeOut])
def list_clinic_types(
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> list[ClinicType]:
    return db.execute(
        select(ClinicType).order_by(ClinicType.clinic_priority, ClinicType.name)
    ).scalars().all()


@router.post("", response_model=ClinicTypeOut, status_code=201)
def create_clinic_type(
    payload: ClinicTypeIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ClinicType:
    ct = ClinicType()
    db.add(ct)
    _apply_and_commit(db, ct, payload)
    db.refresh(ct)
    return ct


@router.get("/{clinic_type_id}", response_model=ClinicTypeOut)
def get_clinic_type(
    clinic_type_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ClinicType:
    return _get_or_404(db, clinic_type_id)


@router.put("/{clinic_type_id}", response_model=ClinicTypeOut)
def replace_clinic_type(
    clinic_type_id: int,
    payload: ClinicTypeIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ClinicType:
    ct = _get_or_404(db, clinic_type_id)
    _apply_and_commit(db, ct, payload)
    db.refresh(ct)
    return ct


@router.delete("/{clinic_type_id}", status_code=204)
def delete_clinic_type(
    clinic_type_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> None:
    ct = _get_or_404(db, clinic_type_id)
    db.delete(ct)  # ORM cascade removes all child rows
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail=(
                f"ClinicType {clinic_type_id} is referenced by counter or rota "
                "rows and cannot be deleted"
            ),
        ) from exc