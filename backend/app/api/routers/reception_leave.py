"""Reception leave router: whole-day absence for reception staff.

Shaped after the clinical /leave router but deliberately much thinner, in
step with the model (see ReceptionLeaveEntry): no period, no notes, no
employment window to gate against, no draft rooms to release, and no extra
sessions to report as superseded. What is left is a list, a single create,
a range add, a range remove, and a single delete.

Bulk add skips weekends and pre-existing dates and reports both as counts,
rather than returning LeaveBulkOut's per-date skip list. Weekends are
skipped because reception is Monday-Friday throughout -- the Day enum has
no weekend members and POST /reception/rota 422s a weekend date -- so a
Saturday row could never affect a coverage count or appear on any rota;
writing them would only leave inert rows in the entries table. Bulk delete
is *not* weekday-filtered, mirroring the clinical bulk-delete's reasoning:
"clear this range" should also clear anything a previous rule (or a manual
POST) put on a weekend.

Leave changes nothing about generation or row editing. It is read in
exactly one place -- compute_coverage_issues in reception_rota.py -- where
it filters the phones headcount, resolving the absence limitation that
router documented.
"""
from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...models import ReceptionLeaveEntry, ReceptionStaff
from ..deps import get_current_user, get_db
from ..schemas import (
    ReceptionLeaveBulkDeleteIn,
    ReceptionLeaveBulkDeleteOut,
    ReceptionLeaveBulkIn,
    ReceptionLeaveBulkOut,
    ReceptionLeaveIn,
    ReceptionLeaveOut,
)

router = APIRouter(prefix="/reception/leave", tags=["reception"])

_WEEKDAY_MAX = 4  # Mon=0 ... Fri=4 (Python date.weekday())


def _date_range(start: datetime.date, end: datetime.date):
    for offset in range((end - start).days + 1):
        yield start + datetime.timedelta(days=offset)


def _staff_or_404(db: Session, staff_id: int) -> ReceptionStaff:
    staff = db.get(ReceptionStaff, staff_id)
    if staff is None:
        raise HTTPException(
            status_code=404, detail=f"Reception staff {staff_id} not found"
        )
    return staff


@router.get("", response_model=list[ReceptionLeaveOut])
def list_reception_leave(
    staff_id: int | None = None,
    from_date: datetime.date | None = None,
    to_date: datetime.date | None = None,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> list[ReceptionLeaveEntry]:
    stmt = select(ReceptionLeaveEntry).order_by(
        ReceptionLeaveEntry.date, ReceptionLeaveEntry.staff_id
    )
    if staff_id is not None:
        stmt = stmt.where(ReceptionLeaveEntry.staff_id == staff_id)
    if from_date is not None:
        stmt = stmt.where(ReceptionLeaveEntry.date >= from_date)
    if to_date is not None:
        stmt = stmt.where(ReceptionLeaveEntry.date <= to_date)
    return db.execute(stmt).scalars().all()


@router.post("", response_model=ReceptionLeaveOut, status_code=201)
def create_reception_leave(
    payload: ReceptionLeaveIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ReceptionLeaveEntry:
    """404 on unknown staff, 409 on a duplicate (staff, date). Unlike bulk,
    a weekend date is accepted here: a single deliberate POST is taken at
    face value, and bulk-delete will still clear it."""
    _staff_or_404(db, payload.staff_id)
    entry = ReceptionLeaveEntry(staff_id=payload.staff_id, date=payload.date)
    db.add(entry)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="Leave already recorded for this staff member on this date",
        ) from exc
    db.refresh(entry)
    return entry


@router.post("/bulk", response_model=ReceptionLeaveBulkOut, status_code=200)
def create_reception_leave_bulk(
    payload: ReceptionLeaveBulkIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ReceptionLeaveBulkOut:
    """Add whole-day leave across a date range, weekdays only.

    Returns counts rather than rows: a dated list of what was written is
    already one GET away, and the caller's only real question is "did that
    do what I meant". Dates that already have an entry are counted, never
    an error -- re-submitting an overlapping range is a normal correction,
    not a mistake to reject.
    """
    _staff_or_404(db, payload.staff_id)

    candidates: list[datetime.date] = []
    skipped_weekend = 0
    for day in _date_range(payload.start_date, payload.end_date):
        if day.weekday() > _WEEKDAY_MAX:
            skipped_weekend += 1
        else:
            candidates.append(day)

    existing: set[datetime.date] = set()
    if candidates:
        existing = set(
            db.execute(
                select(ReceptionLeaveEntry.date)
                .where(ReceptionLeaveEntry.staff_id == payload.staff_id)
                .where(ReceptionLeaveEntry.date >= payload.start_date)
                .where(ReceptionLeaveEntry.date <= payload.end_date)
            ).scalars()
        )

    to_insert = [
        ReceptionLeaveEntry(staff_id=payload.staff_id, date=day)
        for day in candidates
        if day not in existing
    ]
    if to_insert:
        db.add_all(to_insert)
        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise HTTPException(
                status_code=409,
                detail=(
                    "A leave entry in this range was created concurrently; "
                    "please retry."
                ),
            ) from exc

    return ReceptionLeaveBulkOut(
        created=len(to_insert),
        skipped_existing=len(candidates) - len(to_insert),
        skipped_weekend=skipped_weekend,
    )


@router.post(
    "/bulk-delete", response_model=ReceptionLeaveBulkDeleteOut, status_code=200
)
def delete_reception_leave_bulk(
    payload: ReceptionLeaveBulkDeleteIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ReceptionLeaveBulkDeleteOut:
    """Remove every entry for a staff member within a range, weekends
    included -- see the module docstring for why this is not weekday-
    filtered while bulk-add is."""
    _staff_or_404(db, payload.staff_id)
    result = db.execute(
        delete(ReceptionLeaveEntry)
        .where(ReceptionLeaveEntry.staff_id == payload.staff_id)
        .where(ReceptionLeaveEntry.date >= payload.start_date)
        .where(ReceptionLeaveEntry.date <= payload.end_date)
    )
    db.commit()
    return ReceptionLeaveBulkDeleteOut(deleted_count=result.rowcount or 0)


@router.delete("/{leave_id}", status_code=204)
def delete_reception_leave(
    leave_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> None:
    entry = db.get(ReceptionLeaveEntry, leave_id)
    if entry is None:
        raise HTTPException(
            status_code=404, detail=f"Reception leave {leave_id} not found"
        )
    db.delete(entry)
    db.commit()
