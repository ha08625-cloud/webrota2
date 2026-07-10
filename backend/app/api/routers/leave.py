"""Leave router (M3 Task 6; bulk add/remove added post-M4)."""
from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...models import Doctor, LeaveEntry
from ...models.enums import Period
from ..deps import get_current_user, get_db
from ..schemas import (
    LeaveBulkDeleteIn,
    LeaveBulkDeleteOut,
    LeaveBulkIn,
    LeaveBulkOut,
    LeaveBulkSkippedOut,
    LeaveIn,
    LeaveOut,
)

router = APIRouter(prefix="/leave", tags=["leave"])

_WEEKDAY_MAX = 4  # Mon=0 ... Fri=4 (Python date.weekday())


def _expand_periods(period: Period | str) -> list[Period]:
    if period == "BOTH":
        return [Period.AM, Period.PM]
    return [Period(period)]


def _date_range(start: datetime.date, end: datetime.date):
    days = (end - start).days
    for offset in range(days + 1):
        yield start + datetime.timedelta(days=offset)


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


@router.post("/bulk", response_model=LeaveBulkOut, status_code=200)
def create_leave_bulk(
    payload: LeaveBulkIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> LeaveBulkOut:
    """Add leave across a date range in one call.

    Only weekdays (Mon-Fri) are candidates for insertion; weekend dates are
    reported in `skipped` with reason "weekend" rather than silently
    dropped, so a range that happens to land on a weekend doesn't look like
    a no-op bug. Entries that already exist are reported as "duplicate"
    skips rather than causing the whole call to fail.
    """
    if db.get(Doctor, payload.doctor_id) is None:
        raise HTTPException(
            status_code=404, detail=f"Doctor {payload.doctor_id} not found"
        )

    periods = _expand_periods(payload.period)
    skipped: list[LeaveBulkSkippedOut] = []
    candidates: list[tuple[datetime.date, Period]] = []

    for day in _date_range(payload.start_date, payload.end_date):
        if day.weekday() > _WEEKDAY_MAX:
            for period in periods:
                skipped.append(
                    LeaveBulkSkippedOut(date=day, period=period, reason="weekend")
                )
        else:
            for period in periods:
                candidates.append((day, period))

    existing: set[tuple[datetime.date, Period]] = set()
    if candidates:
        stmt = (
            select(LeaveEntry.date, LeaveEntry.period)
            .where(LeaveEntry.doctor_id == payload.doctor_id)
            .where(LeaveEntry.date >= payload.start_date)
            .where(LeaveEntry.date <= payload.end_date)
            .where(LeaveEntry.period.in_(periods))
        )
        existing = {(row.date, row.period) for row in db.execute(stmt)}

    to_insert: list[LeaveEntry] = []
    for day, period in candidates:
        if (day, period) in existing:
            skipped.append(
                LeaveBulkSkippedOut(date=day, period=period, reason="duplicate")
            )
        else:
            to_insert.append(
                LeaveEntry(doctor_id=payload.doctor_id, date=day, period=period)
            )

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
        for entry in to_insert:
            db.refresh(entry)

    skipped.sort(key=lambda s: (s.date, s.period.value))
    created = [LeaveOut.model_validate(entry) for entry in to_insert]
    return LeaveBulkOut(created=created, skipped=skipped)


@router.post("/bulk-delete", response_model=LeaveBulkDeleteOut, status_code=200)
def delete_leave_bulk(
    payload: LeaveBulkDeleteIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> LeaveBulkDeleteOut:
    """Remove all leave for a doctor within a date range.

    Unlike bulk-add, this is *not* weekday-filtered: a manually-added
    weekend entry inside the range should still be removable by "clear
    this range."
    """
    if db.get(Doctor, payload.doctor_id) is None:
        raise HTTPException(
            status_code=404, detail=f"Doctor {payload.doctor_id} not found"
        )

    periods = _expand_periods(payload.period)
    stmt = (
        delete(LeaveEntry)
        .where(LeaveEntry.doctor_id == payload.doctor_id)
        .where(LeaveEntry.date >= payload.start_date)
        .where(LeaveEntry.date <= payload.end_date)
        .where(LeaveEntry.period.in_(periods))
    )
    result = db.execute(stmt)
    db.commit()
    return LeaveBulkDeleteOut(deleted_count=result.rowcount or 0)


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