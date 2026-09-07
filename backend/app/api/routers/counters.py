"""Counters router.

Counter views and resets. Reads are live values (committed baseline plus any
in-progress draft's increments and edits). The only mutation is reset-to-zero
-- rows are updated, never deleted, so the draft snapshot/scrap lifecycle is
undisturbed. All other mutation happens through generation and swap-roles.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ...models import ClinicCounter, ClinicType, Doctor, SystemCounter, User
from ...models.enums import DoctorType
from ..deps import get_current_user, get_db
from ..schemas import ClinicCounterOut, SystemCounterOut

router = APIRouter(prefix="/counters", tags=["counters"])

_COUNTED_TYPES = (DoctorType.PARTNER, DoctorType.SALARIED)


@router.get("/clinic", response_model=list[ClinicCounterOut])
def list_clinic_counters(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[ClinicCounterOut]:
    rows = db.execute(
        select(ClinicCounter, Doctor.code, ClinicType.name)
        .join(Doctor, ClinicCounter.doctor_id == Doctor.id)
        .join(ClinicType, ClinicCounter.clinic_type_id == ClinicType.id)
        .where(Doctor.doctor_type.in_(_COUNTED_TYPES))
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
    user: User = Depends(get_current_user),
) -> list[SystemCounterOut]:
    rows = db.execute(
        select(SystemCounter, Doctor.code)
        .join(Doctor, SystemCounter.doctor_id == Doctor.id)
        .where(Doctor.doctor_type.in_(_COUNTED_TYPES))
        .order_by(Doctor.code, SystemCounter.counter_type)
    ).all()
    return [
        SystemCounterOut(
            id=c.id, doctor_id=c.doctor_id, doctor_code=code,
            counter_type=c.counter_type, raw_count=c.raw_count,
        )
        for c, code in rows
    ]


@router.post("/clinic/reset-all", status_code=204)
def reset_all_clinic_counters(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    # Resets every ClinicCounter row, not just the Partner/Salaried rows the
    # GET endpoint and the Counters page display -- a partial reset would
    # leave invisible non-zero counters skewing later tie-breaks. Deliberate.
    db.execute(update(ClinicCounter).values(raw_count=0))
    db.commit()
    return None


@router.post("/system/reset-all", status_code=204)
def reset_all_system_counters(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    # Same rationale as reset_all_clinic_counters: every row, not just the
    # ones the GET endpoint and the page display.
    db.execute(update(SystemCounter).values(raw_count=0))
    db.commit()
    return None


@router.post("/clinic/{counter_id}/reset", response_model=ClinicCounterOut)
def reset_clinic_counter(
    counter_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ClinicCounterOut:
    counter = db.get(ClinicCounter, counter_id)
    if counter is None:
        raise HTTPException(
            status_code=404, detail=f"Clinic counter {counter_id} not found"
        )
    counter.raw_count = 0
    db.commit()

    code, name = db.execute(
        select(Doctor.code, ClinicType.name)
        .join(ClinicType, ClinicType.id == counter.clinic_type_id)
        .where(Doctor.id == counter.doctor_id)
    ).one()
    return ClinicCounterOut(
        id=counter.id, doctor_id=counter.doctor_id, doctor_code=code,
        clinic_type_id=counter.clinic_type_id, clinic_type_name=name,
        raw_count=counter.raw_count,
    )


@router.post("/system/{counter_id}/reset", response_model=SystemCounterOut)
def reset_system_counter(
    counter_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SystemCounterOut:
    counter = db.get(SystemCounter, counter_id)
    if counter is None:
        raise HTTPException(
            status_code=404, detail=f"System counter {counter_id} not found"
        )
    counter.raw_count = 0
    db.commit()

    code = db.execute(
        select(Doctor.code).where(Doctor.id == counter.doctor_id)
    ).scalar_one()
    return SystemCounterOut(
        id=counter.id, doctor_id=counter.doctor_id, doctor_code=code,
        counter_type=counter.counter_type, raw_count=counter.raw_count,
    )