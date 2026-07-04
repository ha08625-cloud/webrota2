"""Duty router (M3 Task 6).

DutyAssignment is a template input to generation, not an audit trail:
session-level duty swaps on a generated rota deliberately do not write back
here (finalised M3 plan).
"""
from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...models import Doctor, DutyAssignment
from ..deps import get_current_user, get_db
from ..schemas import DutyIn, DutyOut

router = APIRouter(prefix="/duty", tags=["duty"])


@router.get("", response_model=list[DutyOut])
def list_duty(
    from_date: datetime.date | None = None,
    to_date: datetime.date | None = None,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> list[DutyAssignment]:
    stmt = select(DutyAssignment).order_by(DutyAssignment.date, DutyAssignment.period)
    if from_date is not None:
        stmt = stmt.where(DutyAssignment.date >= from_date)
    if to_date is not None:
        stmt = stmt.where(DutyAssignment.date <= to_date)
    return db.execute(stmt).scalars().all()


@router.post("", response_model=DutyOut, status_code=201)
def create_duty(
    payload: DutyIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> DutyAssignment:
    if db.get(Doctor, payload.doctor_id) is None:
        raise HTTPException(
            status_code=404, detail=f"Doctor {payload.doctor_id} not found"
        )
    duty = DutyAssignment(
        date=payload.date,
        period=payload.period,
        doctor_id=payload.doctor_id,
        duty_type=payload.duty_type,
    )
    db.add(duty)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="A duty assignment already exists for this date/period/type",
        ) from exc
    db.refresh(duty)
    return duty


@router.delete("/{duty_id}", status_code=204)
def delete_duty(
    duty_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> None:
    duty = db.get(DutyAssignment, duty_id)
    if duty is None:
        raise HTTPException(status_code=404, detail=f"Duty {duty_id} not found")
    db.delete(duty)
    db.commit()
