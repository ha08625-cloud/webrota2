"""Leave router (M3 Task 6)."""
from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...models import Doctor, LeaveEntry
from ..deps import get_current_user, get_db
from ..schemas import LeaveIn, LeaveOut

router = APIRouter(prefix="/leave", tags=["leave"])


@router.get("", response_model=list[LeaveOut])
def list_leave(
    doctor_id: int | None = None,
    from_date: datetime.date | None = None,
    to_date: datetime.date | None = None,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> list[LeaveEntry]:
    stmt = select(LeaveEntry).order_by(LeaveEntry.date, LeaveEntry.doctor_id)
    if doctor_id is not None:
        stmt = stmt.where(LeaveEntry.doctor_id == doctor_id)
    if from_date is not None:
        stmt = stmt.where(LeaveEntry.date >= from_date)
    if to_date is not None:
        stmt = stmt.where(LeaveEntry.date <= to_date)
    return db.execute(stmt).scalars().all()


@router.post("", response_model=LeaveOut, status_code=201)
def create_leave(
    payload: LeaveIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> LeaveEntry:
    if db.get(Doctor, payload.doctor_id) is None:
        raise HTTPException(
            status_code=404, detail=f"Doctor {payload.doctor_id} not found"
        )
    entry = LeaveEntry(
        doctor_id=payload.doctor_id, date=payload.date, period=payload.period
    )
    db.add(entry)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="Leave entry already exists for this doctor/date/period",
        ) from exc
    db.refresh(entry)
    return entry


@router.delete("/{leave_id}", status_code=204)
def delete_leave(
    leave_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> None:
    entry = db.get(LeaveEntry, leave_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Leave {leave_id} not found")
    db.delete(entry)
    db.commit()
