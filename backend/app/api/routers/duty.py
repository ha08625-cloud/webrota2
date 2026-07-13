"""Duty router (M3 Task 6).

DutyAssignment is a template input to generation, not an audit trail:
session-level duty swaps on a generated rota deliberately do not write back
here (finalised M3 plan).

M5 (bank-holiday weeks): two closure-aware checks live here rather than in
schemas_duty.py, since both need PracticeClosure data that a stateless
pydantic validator cannot see:

- Any duty (primary or secondary) on a closed date is rejected (422),
  mirroring Phase 0's duty_on_closed_date hard error. The Duty page is
  expected to prevent this at entry, but the API must not rely on that -
  a closure can be added after a duty assignment already exists, and
  Phase 0 is the last line of defence for that case at generation time;
  this is the API-level line of defence for it before that.
- Secondary duty must land on the week's first open weekday. With no
  closures in effect that is always Monday - the pre-M5 rule this
  generalises - and degrades to "no secondary duty assignable" for a
  fully closed week (caught by the closed-date check above, since every
  candidate date in that week is itself closed).

Both checks return a plain string `detail` (an HTTPException, not a
pydantic validation error), consistent with this router's existing 404/409
responses - not the FastAPI validation-error list shape a model_validator
would have produced.
"""
from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...models import Doctor, DutyAssignment, PracticeClosure
from ...models.enums import DutyType
from ..deps import get_current_user, get_db
from ..schemas import DutyIn, DutyOut

router = APIRouter(prefix="/duty", tags=["duty"])


def _week_monday(date_: datetime.date) -> datetime.date:
    return date_ - datetime.timedelta(days=date_.weekday())


def _closed_dates_in_week(db: Session, monday: datetime.date) -> set[datetime.date]:
    rows = db.execute(
        select(PracticeClosure.date).where(
            PracticeClosure.date >= monday,
            PracticeClosure.date < monday + datetime.timedelta(days=5),
        )
    ).scalars().all()
    return set(rows)


def _first_open_weekday(
    closed: set[datetime.date], monday: datetime.date
) -> datetime.date | None:
    """Mirrors the engine's week_map.build_first_open_weekday. None if
    every weekday (Mon-Fri) of this week is closed."""
    for offset in range(5):
        candidate = monday + datetime.timedelta(days=offset)
        if candidate not in closed:
            return candidate
    return None


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

    monday = _week_monday(payload.date)
    closed = _closed_dates_in_week(db, monday)

    if payload.date in closed:
        raise HTTPException(
            status_code=422,
            detail=(
                f"{payload.date.isoformat()} is a closed date; duty cannot be "
                f"assigned there."
            ),
        )

    if payload.duty_type == DutyType.SECONDARY:
        first_open = _first_open_weekday(closed, monday)
        # first_open is only None if every weekday this week is closed, in
        # which case payload.date was already caught by the closed-date
        # check above - this branch is defensive, not reachable in
        # practice, but keeps the type honest without an assertion.
        if first_open is None or payload.date != first_open:
            expected = first_open.isoformat() if first_open is not None else "no day"
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Secondary duty for the week of {monday.isoformat()} must be "
                    f"assigned on {expected}."
                ),
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