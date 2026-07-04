"""Counters router (M3 Task 6).

Read-only views of the live counter values: the committed baseline plus any
in-progress draft's increments and swap edits. Used by the frontend counter
panel. Mutation happens only through generation and swap-roles.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...models import ClinicCounter, ClinicType, Doctor, SystemCounter
from ..deps import get_current_user, get_db
from ..schemas import ClinicCounterOut, SystemCounterOut

router = APIRouter(prefix="/counters", tags=["counters"])


@router.get("/clinic", response_model=list[ClinicCounterOut])
def list_clinic_counters(
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> list[ClinicCounterOut]:
    rows = db.execute(
        select(ClinicCounter, Doctor.code, ClinicType.name)
        .join(Doctor, ClinicCounter.doctor_id == Doctor.id)
        .join(ClinicType, ClinicCounter.clinic_type_id == ClinicType.id)
        .order_by(Doctor.code, ClinicType.name)
    ).all()
    return [
        ClinicCounterOut(
            id=c.id, doctor_id=c.doctor_id, doctor_code=code,
            clinic_type_id=c.clinic_type_id, clinic_type_name=name,
            raw_count=c.raw_count,
        )
        for c, code, name in rows
    ]


@router.get("/system", response_model=list[SystemCounterOut])
def list_system_counters(
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> list[SystemCounterOut]:
    rows = db.execute(
        select(SystemCounter, Doctor.code)
        .join(Doctor, SystemCounter.doctor_id == Doctor.id)
        .order_by(Doctor.code, SystemCounter.counter_type)
    ).all()
    return [
        SystemCounterOut(
            id=c.id, doctor_id=c.doctor_id, doctor_code=code,
            counter_type=c.counter_type, raw_count=c.raw_count,
        )
        for c, code in rows
    ]
