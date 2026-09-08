"""Duty router.

DutyAssignment is a template input to generation, not an audit trail:
session-level duty swaps on a generated rota deliberately do not write back
here.

Two closure-aware checks live here rather than in schemas_duty.py, since
both need PracticeClosure data that a stateless pydantic validator cannot
see:

- A duty (primary or secondary) on its own closed period is rejected
  (422), mirroring Phase 0's duty_on_closed_date hard error, keyed on
  (payload.date, payload.period) since closures are half-day granularity.
  The Duty page is expected to prevent this at entry, but
  the API must not rely on that - a closure can be added after a duty
  assignment already exists, and Phase 0 is the last line of defence for
  that case at generation time; this is the API-level line of defence for
  it before that.
- Secondary duty must land on the week's first *fully open* weekday --
  neither AM nor PM closed (mirrors
  engine.week_map.build_first_open_weekday). With no closures in effect
  that is always Monday, and it degrades to "no secondary duty assignable"
  for a week with no fully open weekday.
  That is no longer always the same week as one where payload.date itself
  is closed: a fully closed Monday plus half closures Tuesday-Friday gives
  no fully open weekday even though an open AM/PM slot exists on several
  of those days.

A third check sits in the same place for the same reason - it needs the
`Doctor` row, which a stateless validator cannot see: a duty on a date
outside the doctor's employment window is rejected (422), mirroring Phase
0's duty_outside_doctor_dates hard error.

All three checks return a plain string `detail` (an HTTPException, not a
pydantic validation error), consistent with this router's existing 404/409
responses - not the FastAPI validation-error list shape a model_validator
would have produced.

The duty opening balance (`app/models/duty_opening_balance.py`) is read by
GET /counts and written by PUT /opening-balance. It is the duty-side sibling
of the counter opening balances in routers/counters.py: a credit in duty
sessions, added to the counted total before it is divided by
sessions_per_week, so a doctor who joined part-way through the year is not
read as maximally under-loaded and made the grid's suggested pick for weeks.
Unlike the counter balances it is year-scoped, because the count it adjusts
restarts every 1 January - at which point every doctor is genuinely level
again and no credit should survive.
"""
from __future__ import annotations

import datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import and_, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...doctor_window import is_within_window, window_error_detail
from ...models import (
    Doctor,
    DutyAssignment,
    DutyOpeningBalance,
    PracticeClosure,
    User,
)
from ...models.enums import DutyType, Period
from ..deps import get_current_user, get_db
from ..schemas import DutyCountOut, DutyIn, DutyOpeningBalanceIn, DutyOut

_ZERO = Decimal("0.0")

router = APIRouter(prefix="/duty", tags=["duty"])


def _week_monday(date_: datetime.date) -> datetime.date:
    return date_ - datetime.timedelta(days=date_.weekday())


def _closed_slots_in_week(
    db: Session, monday: datetime.date
) -> set[tuple[datetime.date, Period]]:
    rows = db.execute(
        select(PracticeClosure.date, PracticeClosure.period).where(
            PracticeClosure.date >= monday,
            PracticeClosure.date < monday + datetime.timedelta(days=5),
        )
    ).all()
    return {(d, p) for d, p in rows}


def _first_open_weekday(
    closed: set[tuple[datetime.date, Period]], monday: datetime.date
) -> datetime.date | None:
    """Mirrors the engine's week_map.build_first_open_weekday: the first
    weekday (Mon-Fri) with neither period closed. None if every weekday
    this week has at least one period closed."""
    for offset in range(5):
        candidate = monday + datetime.timedelta(days=offset)
        if (candidate, Period.AM) not in closed and (candidate, Period.PM) not in closed:
            return candidate
    return None

@router.get("/counts", response_model=list[DutyCountOut])
def duty_counts(
    from_date: datetime.date | None = None,
    to_date: datetime.date | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[DutyCountOut]:
    """Duty counts per active doctor over the requested range, each with the
    opening balance the weighted score adds to it.

    The balance is year-scoped (`DutyOpeningBalance`), and the year is taken
    from `from_date`; with no `from_date` every balance is zero. The Duty page
    is the only caller and always asks for a whole calendar year, so the
    resolution is exact for it -- a range straddling a year boundary gets the
    balance of the year it starts in rather than a sum across years, which is
    a case that does not arise.

    Note the pre-existing asymmetry with the counter endpoints, which this
    does not change: duty counts cover every active doctor, while
    `/counters/*` covers Partner and Salaried only.
    """
    join_cond = DutyAssignment.doctor_id == Doctor.id
    if from_date is not None:
        join_cond = and_(join_cond, DutyAssignment.date >= from_date)
    if to_date is not None:
        join_cond = and_(join_cond, DutyAssignment.date <= to_date)

    rows = db.execute(
        select(
            Doctor.id,
            Doctor.code,
            func.count(DutyAssignment.id).label("raw_count"),
        )
        .outerjoin(DutyAssignment, join_cond)
        .where(Doctor.active.is_(True))
        .group_by(Doctor.id, Doctor.code)
        .order_by(Doctor.code)
    ).all()

    balances: dict[int, Decimal] = {}
    if from_date is not None:
        balances = {
            row.doctor_id: row.sessions
            for row in db.execute(
                select(DutyOpeningBalance).where(
                    DutyOpeningBalance.year == from_date.year
                )
            ).scalars()
        }

    return [
        DutyCountOut(
            doctor_id=i,
            doctor_code=c,
            raw_count=n,
            opening_balance=balances.get(i, _ZERO),
        )
        for i, c, n in rows
    ]


@router.put("/opening-balance", response_model=DutyCountOut)
def set_duty_opening_balance(
    payload: DutyOpeningBalanceIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> DutyCountOut:
    """Upsert one doctor's duty opening balance for one year.

    Zero deletes the row, so the table holds only real deviations. The
    response carries that doctor's count for the year alongside the new
    balance, so the caller can render the corrected weighted score without a
    second request.
    """
    doctor = db.get(Doctor, payload.doctor_id)
    if doctor is None:
        raise HTTPException(
            status_code=404, detail=f"Doctor {payload.doctor_id} not found"
        )

    row = db.execute(
        select(DutyOpeningBalance)
        .where(DutyOpeningBalance.doctor_id == payload.doctor_id)
        .where(DutyOpeningBalance.year == payload.year)
    ).scalars().first()

    if payload.sessions == 0:
        if row is not None:
            db.delete(row)
    elif row is None:
        db.add(
            DutyOpeningBalance(
                doctor_id=payload.doctor_id,
                year=payload.year,
                sessions=payload.sessions,
                notes=payload.notes,
            )
        )
    else:
        row.sessions = payload.sessions
        row.notes = payload.notes
    db.commit()

    jan = datetime.date(payload.year, 1, 1)
    dec = datetime.date(payload.year, 12, 31)
    raw_count = db.execute(
        select(func.count(DutyAssignment.id))
        .where(DutyAssignment.doctor_id == payload.doctor_id)
        .where(DutyAssignment.date >= jan)
        .where(DutyAssignment.date <= dec)
    ).scalar_one()

    return DutyCountOut(
        doctor_id=doctor.id,
        doctor_code=doctor.code,
        raw_count=raw_count,
        opening_balance=_ZERO if payload.sessions == 0 else payload.sessions,
    )


@router.get("", response_model=list[DutyOut])
def list_duty(
    from_date: datetime.date | None = None,
    to_date: datetime.date | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
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
    user: User = Depends(get_current_user),
) -> DutyAssignment:
    doctor = db.get(Doctor, payload.doctor_id)
    if doctor is None:
        raise HTTPException(
            status_code=404, detail=f"Doctor {payload.doctor_id} not found"
        )

    if not is_within_window(doctor, payload.date):
        raise HTTPException(
            status_code=422,
            detail=(
                f"{window_error_detail(doctor, payload.date)}; "
                f"duty cannot be assigned there."
            ),
        )

    monday = _week_monday(payload.date)
    closed = _closed_slots_in_week(db, monday)

    if (payload.date, payload.period) in closed:
        raise HTTPException(
            status_code=422,
            detail=(
                f"{payload.date.isoformat()} {payload.period.value} is closed; "
                f"duty cannot be assigned there."
            ),
        )

    if payload.duty_type == DutyType.SECONDARY:
        first_open = _first_open_weekday(closed, monday)
        # Under the fully-open rule, first_open can be None even though
        # payload.date itself is open: e.g. a fully closed Monday plus half
        # closures Tuesday-Friday leaves no weekday with both periods open,
        # even though several days have an open AM or PM slot (and would
        # have passed the closed-slot check above). This branch is
        # reachable in that case, not merely defensive.
        if first_open is None or payload.date != first_open:
            expected = (
                first_open.isoformat() if first_open is not None
                else "no day (no weekday this week is fully open)"
            )
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
    user: User = Depends(get_current_user),
) -> None:
    duty = db.get(DutyAssignment, duty_id)
    if duty is None:
        raise HTTPException(status_code=404, detail=f"Duty {duty_id} not found")
    db.delete(duty)
    db.commit()