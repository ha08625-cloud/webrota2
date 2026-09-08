"""Counters router.

Counter views, resets and opening balances. Reads are live values (committed
baseline plus any in-progress draft's increments and edits). Raw counts are
mutated here only by reset-to-zero -- rows are updated, never deleted, so the
draft snapshot/scrap lifecycle is undisturbed; all other raw-count mutation
happens through generation and swap-roles.

Opening balances (`app/models/counter.py`) are the second mutation, and they
behave differently in two ways worth stating here:

- They are never snapshotted, because the engine never writes them, so a
  balance edit made during an open draft survives that draft being scrapped.
  The Counters page's draft warning must not claim otherwise.
- Resetting a counter to zero clears the balance as well as the count. After
  a reset everyone is level by definition, so a surviving credit would
  re-introduce the skew it was created to remove.

The two upserts are also keyed differently, and deliberately: the clinic one
takes (doctor, clinic type) in its body because the counter row may not exist
yet -- clinic rows are created lazily -- while the system one takes a counter
id in its path, which is always available because `create_doctor` seeds both
system counters for every doctor.

Neither upsert restricts the doctor type, though both GETs show Partner and
Salaried only. That filter is a pre-existing scope decision about the page;
the engine counts clinics and system events for whoever is eligible, so
refusing to record a balance for, say, a trainee would block a real case to
enforce a display rule.
"""
from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_, select, update
from sqlalchemy.orm import Session

from ...models import ClinicCounter, ClinicType, Doctor, SystemCounter, User
from ...models.enums import DoctorType
from ..deps import get_current_user, get_db
from ..schemas import (
    ClinicCounterOut,
    ClinicOpeningBalanceIn,
    SystemCounterOut,
    SystemOpeningBalanceIn,
)

_ZERO = Decimal("0.0")

router = APIRouter(prefix="/counters", tags=["counters"])

_COUNTED_TYPES = (DoctorType.PARTNER, DoctorType.SALARIED)


@router.get("/clinic", response_model=list[ClinicCounterOut])
def list_clinic_counters(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[ClinicCounterOut]:
    """Every (counted doctor, clinic type) pair, not only the pairs with a
    row.

    Clinic counter rows are created lazily -- on first allocation, or by the
    opening-balance upsert below -- so a doctor who has never been allocated
    a given clinic type has no row for it. Returning only existing rows would
    make exactly that pair unaddressable on the page, and a new joiner is the
    person the opening balance exists for, so the pairs without a row are
    returned as explicit zeros with `id: null`.

    Clinic types are the enabled ones, plus any disabled type that still has
    a counter row: a disabled type is not allocated, so listing it for
    everybody would be noise, but a count already accrued against one must
    not vanish from the page.
    """
    doctors = db.execute(
        select(Doctor.id, Doctor.code)
        .where(Doctor.doctor_type.in_(_COUNTED_TYPES))
        .order_by(Doctor.code)
    ).all()
    counted_ids = [doctor_id for doctor_id, _ in doctors]

    with_rows = (
        select(ClinicCounter.clinic_type_id)
        .where(ClinicCounter.doctor_id.in_(counted_ids))
        .scalar_subquery()
    )
    clinic_types = db.execute(
        select(ClinicType.id, ClinicType.name)
        .where(or_(ClinicType.is_enabled.is_(True), ClinicType.id.in_(with_rows)))
        .order_by(ClinicType.name)
    ).all()

    existing = {
        (c.doctor_id, c.clinic_type_id): c
        for c in db.execute(
            select(ClinicCounter).where(ClinicCounter.doctor_id.in_(counted_ids))
        ).scalars()
    }

    return [
        ClinicCounterOut(
            id=None if row is None else row.id,
            doctor_id=doctor_id,
            doctor_code=code,
            clinic_type_id=clinic_type_id,
            clinic_type_name=name,
            raw_count=0 if row is None else row.raw_count,
            opening_balance=_ZERO if row is None else row.opening_balance,
        )
        for doctor_id, code in doctors
        for clinic_type_id, name in clinic_types
        for row in (existing.get((doctor_id, clinic_type_id)),)
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
            opening_balance=c.opening_balance,
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
    # The opening balance goes with the count: after a reset everyone is level
    # by definition, so a surviving joiner credit would re-introduce the skew
    # it was created to remove.
    db.execute(update(ClinicCounter).values(raw_count=0, opening_balance=_ZERO))
    db.commit()
    return None


@router.post("/system/reset-all", status_code=204)
def reset_all_system_counters(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    # Same rationale as reset_all_clinic_counters: every row, not just the
    # ones the GET endpoint and the page display, and the opening balance is
    # cleared alongside the count.
    db.execute(update(SystemCounter).values(raw_count=0, opening_balance=_ZERO))
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
    # Cleared alongside the count -- see the module docstring.
    counter.opening_balance = _ZERO
    db.commit()

    code, name = db.execute(
        select(Doctor.code, ClinicType.name)
        .join(ClinicType, ClinicType.id == counter.clinic_type_id)
        .where(Doctor.id == counter.doctor_id)
    ).one()
    return ClinicCounterOut(
        id=counter.id, doctor_id=counter.doctor_id, doctor_code=code,
        clinic_type_id=counter.clinic_type_id, clinic_type_name=name,
        raw_count=counter.raw_count, opening_balance=counter.opening_balance,
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
    counter.opening_balance = _ZERO
    db.commit()

    code = db.execute(
        select(Doctor.code).where(Doctor.id == counter.doctor_id)
    ).scalar_one()
    return SystemCounterOut(
        id=counter.id, doctor_id=counter.doctor_id, doctor_code=code,
        counter_type=counter.counter_type, raw_count=counter.raw_count,
        opening_balance=counter.opening_balance,
    )

@router.put("/clinic/opening-balance", response_model=ClinicCounterOut)
def set_clinic_opening_balance(
    payload: ClinicOpeningBalanceIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ClinicCounterOut:
    """Set one (doctor, clinic type) opening balance, creating the counter
    row at `raw_count=0` if it does not exist yet.

    Keyed on the pair rather than on a counter id because the row is exactly
    what may be missing -- see the module docstring. Setting the balance to
    zero leaves the row in place rather than deleting it: unlike the duty
    balance's own table, this row also carries a raw count that may be
    non-zero, so "no deviation" is not the same as "nothing to store".
    """
    doctor = db.get(Doctor, payload.doctor_id)
    if doctor is None:
        raise HTTPException(
            status_code=404, detail=f"Doctor {payload.doctor_id} not found"
        )
    clinic_type = db.get(ClinicType, payload.clinic_type_id)
    if clinic_type is None:
        raise HTTPException(
            status_code=404,
            detail=f"Clinic type {payload.clinic_type_id} not found",
        )

    counter = db.execute(
        select(ClinicCounter)
        .where(ClinicCounter.doctor_id == payload.doctor_id)
        .where(ClinicCounter.clinic_type_id == payload.clinic_type_id)
    ).scalars().first()
    if counter is None:
        counter = ClinicCounter(
            doctor_id=payload.doctor_id,
            clinic_type_id=payload.clinic_type_id,
            raw_count=0,
        )
        db.add(counter)
    counter.opening_balance = payload.sessions
    db.commit()
    db.refresh(counter)

    return ClinicCounterOut(
        id=counter.id, doctor_id=counter.doctor_id, doctor_code=doctor.code,
        clinic_type_id=counter.clinic_type_id, clinic_type_name=clinic_type.name,
        raw_count=counter.raw_count, opening_balance=counter.opening_balance,
    )


@router.put("/system/{counter_id}/opening-balance", response_model=SystemCounterOut)
def set_system_opening_balance(
    counter_id: int,
    payload: SystemOpeningBalanceIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SystemCounterOut:
    """Set one system counter's opening balance. 404 for an unknown id; the
    rows are seeded per doctor, so there is nothing to create here."""
    counter = db.get(SystemCounter, counter_id)
    if counter is None:
        raise HTTPException(
            status_code=404, detail=f"System counter {counter_id} not found"
        )
    counter.opening_balance = payload.sessions
    db.commit()

    code = db.execute(
        select(Doctor.code).where(Doctor.id == counter.doctor_id)
    ).scalar_one()
    return SystemCounterOut(
        id=counter.id, doctor_id=counter.doctor_id, doctor_code=code,
        counter_type=counter.counter_type, raw_count=counter.raw_count,
        opening_balance=counter.opening_balance,
    )
