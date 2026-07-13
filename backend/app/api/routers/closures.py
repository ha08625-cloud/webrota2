"""Practice closures router (M5 Task 2): global bank-holiday planning data.

PracticeClosure is entered independently of any generation run -- the Duty
page needs to know about a closure weeks before a RotaConfig exists, and the
generation engine (context.load_context()) reads the same table. This router
is the only write path for it.

Deleting a closure here never touches RotaClosure: that table is a
per-rota snapshot taken at generation time (M5 Decision 4), independent by
design, so removing a PracticeClosure has no effect on any rota already
generated over it -- see grid_utils.rebuild_rota_grid().
"""
from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...models import PracticeClosure
from ..deps import get_current_user, get_db
from ..schemas import ClosureIn, ClosureOut

router = APIRouter(prefix="/closures", tags=["closures"])


@router.get("", response_model=list[ClosureOut])
def list_closures(
    from_date: datetime.date | None = None,
    to_date: datetime.date | None = None,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> list[PracticeClosure]:
    stmt = select(PracticeClosure).order_by(PracticeClosure.date)
    if from_date is not None:
        stmt = stmt.where(PracticeClosure.date >= from_date)
    if to_date is not None:
        stmt = stmt.where(PracticeClosure.date <= to_date)
    return db.execute(stmt).scalars().all()


@router.post("", response_model=ClosureOut, status_code=201)
def create_closure(
    payload: ClosureIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> PracticeClosure:
    """Weekend dates are rejected by ClosureIn's validator (422) before this
    ever runs -- weekends are never in the grid, so a closure on one would
    be meaningless. Duplicate dates 409 via the unique constraint."""
    closure = PracticeClosure(date=payload.date, name=payload.name)
    db.add(closure)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail=f"A closure already exists for {payload.date.isoformat()}",
        ) from exc
    db.refresh(closure)
    return closure


@router.delete("/{closure_id}", status_code=204)
def delete_closure(
    closure_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> None:
    closure = db.get(PracticeClosure, closure_id)
    if closure is None:
        raise HTTPException(status_code=404, detail=f"Closure {closure_id} not found")
    db.delete(closure)
    db.commit()