"""Extra sessions router: plan a doctor working a normally non-working
slot (extra sessions plan, Task 1).

The override that turns a planned extra session into a working staged
slot happens once, at `POST /staging` creation time (extra sessions plan,
Task 2) - this router only owns the CRUD record of intent, not the
override itself.

Weekday-only (Design Decision 3) and blocked by existing leave (Design
Decision 6) are both checked here rather than in the schema, since both
need request context - the leave check needs the DB - beyond what a bare
Pydantic model can see. No bulk endpoints (Design Decision 10): unlike
leave's "every weekday in the range" semantics, a single date plus period
covers the real workflow here.
"""
from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...models import Doctor, ExtraSessionEntry, LeaveEntry
from ..deps import get_current_user, get_db
from ..schemas import ExtraSessionIn, ExtraSessionOut

router = APIRouter(prefix="/extra-sessions", tags=["extra-sessions"])

_WEEKDAY_MAX = 4  # Mon=0 ... Fri=4 (Python date.weekday())


@router.get("", response_model=list[ExtraSessionOut])
def list_extra_sessions(
    doctor_id: int | None = None,
    from_date: datetime.date | None = None,
    to_date: datetime.date | None = None,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> list[ExtraSessionEntry]:
    stmt = select(ExtraSessionEntry).order_by(
        ExtraSessionEntry.date, ExtraSessionEntry.doctor_id
    )
    if doctor_id is not None:
        stmt = stmt.where(ExtraSessionEntry.doctor_id == doctor_id)
    if from_date is not None:
        stmt = stmt.where(ExtraSessionEntry.date >= from_date)
    if to_date is not None:
        stmt = stmt.where(ExtraSessionEntry.date <= to_date)
    return db.execute(stmt).scalars().all()


@router.post("", response_model=ExtraSessionOut, status_code=201)
def create_extra_session(
    payload: ExtraSessionIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ExtraSessionEntry:
    doctor = db.get(Doctor, payload.doctor_id)
    if doctor is None:
        raise HTTPException(
            status_code=404, detail=f"Doctor {payload.doctor_id} not found"
        )

    if payload.date.weekday() > _WEEKDAY_MAX:
        raise HTTPException(
            status_code=422,
            detail=(
                f"{payload.date.isoformat()} is a weekend; extra sessions "
                "can only be planned on weekdays"
            ),
        )

    on_leave = db.execute(
        select(LeaveEntry).where(
            LeaveEntry.doctor_id == payload.doctor_id,
            LeaveEntry.date == payload.date,
            LeaveEntry.period == payload.period,
        )
    ).scalars().first()
    if on_leave is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Dr {doctor.code} is on leave on {payload.date.isoformat()} "
                f"{payload.period.value}; remove the leave first"
            ),
        )

    entry = ExtraSessionEntry(
        doctor_id=payload.doctor_id, date=payload.date, period=payload.period
    )
    db.add(entry)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="An extra session entry already exists for this doctor/date/period",
        ) from exc
    db.refresh(entry)
    return entry


@router.delete("/{entry_id}", status_code=204)
def delete_extra_session(
    entry_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> None:
    entry = db.get(ExtraSessionEntry, entry_id)
    if entry is None:
        raise HTTPException(
            status_code=404, detail=f"Extra session {entry_id} not found"
        )
    db.delete(entry)
    db.commit()