"""Practice closures router: global bank-holiday planning data.

PracticeClosure is entered independently of any generation run -- the Duty
page needs to know about a closure weeks before a RotaConfig exists, and the
generation engine (context.load_context()) reads the same table. This router
is the only write path for it.

Closures are per (date, period) slots (half-day practice closures): a
closure on one period of a date does not block the other period, and the
duplicate-slot rule (409) is keyed on (date, period), not date alone.

Deleting a closure here never touches RotaClosure: that table is a
per-rota snapshot taken at generation time, independent by design, so
removing a PracticeClosure has no effect on any rota already generated
over it -- see grid_utils.rebuild_rota_grid().
"""
from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...models import BANK_HOLIDAYS, BANK_HOLIDAYS_BY_KEY, PracticeClosure, User
from ...models.enums import Period
from ..deps import get_current_user, get_db
from ..schemas import BankHolidayOut, BankHolidaySetIn, ClosureIn, ClosureOut

router = APIRouter(prefix="/closures", tags=["closures"])


@router.get("", response_model=list[ClosureOut])
def list_closures(
    from_date: datetime.date | None = None,
    to_date: datetime.date | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[PracticeClosure]:
    stmt = select(PracticeClosure).order_by(
        PracticeClosure.date, PracticeClosure.period
    )
    if from_date is not None:
        stmt = stmt.where(PracticeClosure.date >= from_date)
    if to_date is not None:
        stmt = stmt.where(PracticeClosure.date <= to_date)
    return db.execute(stmt).scalars().all()


@router.post("", response_model=ClosureOut, status_code=201)
def create_closure(
    payload: ClosureIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> PracticeClosure:
    """Weekend dates are rejected by ClosureIn's validator (422) before this
    ever runs -- weekends are never in the grid, so a closure on one would
    be meaningless. A duplicate (date, period) 409s via the unique
    constraint; a closure on one period of a date does not block the
    other."""
    closure = PracticeClosure(date=payload.date, period=payload.period, name=payload.name)
    db.add(closure)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail=(
                f"A closure already exists for {payload.date.isoformat()} "
                f"{payload.period.value}"
            ),
        ) from exc
    db.refresh(closure)
    return closure


@router.delete("/{closure_id}", status_code=204)
def delete_closure(
    closure_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    closure = db.get(PracticeClosure, closure_id)
    if closure is None:
        raise HTTPException(status_code=404, detail=f"Closure {closure_id} not found")
    db.delete(closure)
    db.commit()


@router.get("/bank-holidays", response_model=list[BankHolidayOut])
def list_bank_holidays(
    year: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[BankHolidayOut]:
    """The fixed named list merged with whichever have a date set for
    `year`. A holiday with no PracticeClosure yet comes back with date=None
    rather than being omitted, so the UI always shows all eight rows."""
    rows = db.execute(
        select(PracticeClosure).where(
            PracticeClosure.bank_holiday_key.in_(BANK_HOLIDAYS_BY_KEY.keys()),
            PracticeClosure.date >= datetime.date(year, 1, 1),
            PracticeClosure.date <= datetime.date(year, 12, 31),
        )
    ).scalars().all()
    date_by_key = {row.bank_holiday_key: row.date for row in rows}
    return [
        BankHolidayOut(key=h.key, name=h.name, date=date_by_key.get(h.key))
        for h in BANK_HOLIDAYS
    ]


@router.put("/bank-holidays/{key}", response_model=BankHolidayOut)
def set_bank_holiday(
    key: str,
    year: int,
    payload: BankHolidaySetIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> BankHolidayOut:
    """Setting `date` replaces whichever full-day closure (AM+PM pair) was
    previously tagged with this key for `year`, if any; `date=None` clears
    it. Weekend dates are rejected by BankHolidaySetIn's validator (422)."""
    holiday = BANK_HOLIDAYS_BY_KEY.get(key)
    if holiday is None:
        raise HTTPException(status_code=404, detail=f"Unknown bank holiday key: {key}")

    existing = db.execute(
        select(PracticeClosure).where(
            PracticeClosure.bank_holiday_key == key,
            PracticeClosure.date >= datetime.date(year, 1, 1),
            PracticeClosure.date <= datetime.date(year, 12, 31),
        )
    ).scalars().all()
    for row in existing:
        db.delete(row)

    if payload.date is not None:
        for period in (Period.AM, Period.PM):
            db.add(
                PracticeClosure(
                    date=payload.date,
                    period=period,
                    name=holiday.name,
                    bank_holiday_key=key,
                )
            )

    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail=(
                f"A closure already exists for {payload.date.isoformat()}"
                if payload.date is not None
                else "Could not update this bank holiday."
            ),
        ) from exc

    return BankHolidayOut(key=key, name=holiday.name, date=payload.date)