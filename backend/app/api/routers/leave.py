"""Leave router (M3 Task 6; bulk add/remove added post-M4; draft room release
added post-M4.3 - see M4.3 Task 3)."""
from __future__ import annotations

import datetime
from typing import Iterable

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...doctor_window import is_within_window, window_error_detail
from ...engine.generate import get_active_draft
from ...engine.week_map import build_date_to_genslot, build_week_dates
from ...master_template import WEEKDAY_MAX as _WEEKDAY_MAX
from ...models import Doctor, ExtraSessionEntry, LeaveEntry, RotaSession
from ...models.enums import Period
from ..deps import get_current_user, get_db
from ..schemas import (
    ExtraSessionOut,
    LeaveBulkDeleteIn,
    LeaveBulkDeleteOut,
    LeaveBulkIn,
    LeaveBulkOut,
    LeaveBulkSkippedOut,
    LeaveIn,
    LeaveOut,
)

router = APIRouter(prefix="/leave", tags=["leave"])


def _expand_periods(period: Period | str) -> list[Period]:
    if period == "BOTH":
        return [Period.AM, Period.PM]
    return [Period(period)]


def _date_range(start: datetime.date, end: datetime.date):
    days = (end - start).days
    for offset in range(days + 1):
        yield start + datetime.timedelta(days=offset)


def _release_draft_rooms(
    db: Session,
    doctor_id: int,
    pairs: Iterable[tuple[datetime.date, Period]],
) -> None:
    """Clear `room_id` on the active draft's sessions matching the given
    (date, period) pairs for this doctor.

    No-op if there is no active draft, or if a pair falls outside the
    draft's date range (including weekends, which are never in
    `date_to_slot`). Does not commit - the caller owns the transaction.
    """
    draft = get_active_draft(db)
    if draft is None:
        return

    week_dates = build_week_dates(draft.config.start_date, draft.config.num_weeks)
    date_to_slot = build_date_to_genslot(week_dates)

    for day, period in pairs:
        slot = date_to_slot.get(day)
        if slot is None:
            continue
        gen_week, gen_day = slot
        db.execute(
            update(RotaSession)
            .where(RotaSession.rota_id == draft.id)
            .where(RotaSession.doctor_id == doctor_id)
            .where(RotaSession.week == gen_week)
            .where(RotaSession.day == gen_day)
            .where(RotaSession.period == period)
            .where(RotaSession.room_id.is_not(None))
            .values(room_id=None)
        )


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
    doctor = db.get(Doctor, payload.doctor_id)
    if doctor is None:
        raise HTTPException(
            status_code=404, detail=f"Doctor {payload.doctor_id} not found"
        )
    if not is_within_window(doctor, payload.date):
        raise HTTPException(
            status_code=422, detail=window_error_detail(doctor, payload.date)
        )
    entry = LeaveEntry(
        doctor_id=payload.doctor_id, date=payload.date, period=payload.period
    )
    db.add(entry)
    _release_draft_rooms(db, payload.doctor_id, [(payload.date, payload.period)])
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

    Draft rooms are released for every weekday candidate pair, including
    duplicates - a duplicate skip means the leave already existed, and
    releasing again is a harmless no-op or a heal of stale state (leave
    added before this feature shipped). See M4.3 Task 3, design decision 4.

    Any planned extra session covered by this range is reported in
    `superseded_extra_sessions` - never deleted, never blocked (extra
    sessions plan, Design Decision 7).

    Dates outside the doctor's employment window are reported as
    "outside_doctor_dates" skips rather than 422ing the call (annual leave
    planning, Design Decision 8) - one out-of-window date at the end of a
    long range must not fail the whole request. The weekend check runs
    first, so a date that is both reports "weekend", the more specific
    fact.
    """
    doctor = db.get(Doctor, payload.doctor_id)
    if doctor is None:
        raise HTTPException(
            status_code=404, detail=f"Doctor {payload.doctor_id} not found"
        )

    periods = _expand_periods(payload.period)
    skipped: list[LeaveBulkSkippedOut] = []
    candidates: list[tuple[datetime.date, Period]] = []

    for day in _date_range(payload.start_date, payload.end_date):
        if day.weekday() > _WEEKDAY_MAX:
            reason = "weekend"
        elif not is_within_window(doctor, day):
            reason = "outside_doctor_dates"
        else:
            reason = None
        for period in periods:
            if reason is None:
                candidates.append((day, period))
            else:
                skipped.append(
                    LeaveBulkSkippedOut(date=day, period=period, reason=reason)
                )

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

    # Release rooms for every weekday candidate, duplicates included - not
    # just the ones actually inserted. Deliberately outside the
    # `if to_insert:` guard so an all-duplicates request still heals stale
    # rooms; the commit is hoisted here to cover that case too.
    _release_draft_rooms(db, payload.doctor_id, candidates)

    # Report (never delete or block on) any planned extra session this
    # range covers - leave is the more authoritative fact, but the admin
    # should see what it superseded (extra sessions plan, Design
    # Decision 7). Queried by date range over the whole candidate set,
    # duplicates included, same shape as the `existing` duplicate check
    # above, then intersected with the candidate pairs in Python: the
    # range alone is no longer equivalent now that out-of-window dates are
    # dropped from the candidate list, and no leave was written on those,
    # so nothing there was superseded.
    superseded: list[ExtraSessionEntry] = []
    if candidates:
        candidate_set = set(candidates)
        superseded_stmt = (
            select(ExtraSessionEntry)
            .where(ExtraSessionEntry.doctor_id == payload.doctor_id)
            .where(ExtraSessionEntry.date >= payload.start_date)
            .where(ExtraSessionEntry.date <= payload.end_date)
            .where(ExtraSessionEntry.period.in_(periods))
        )
        superseded = [
            e
            for e in db.execute(superseded_stmt).scalars().all()
            if (e.date, e.period) in candidate_set
        ]

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
    superseded_out = [ExtraSessionOut.model_validate(e) for e in superseded]
    return LeaveBulkOut(
        created=created, skipped=skipped, superseded_extra_sessions=superseded_out
    )


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

    Rooms are never restored on removal - matching the existing WFH
    asymmetry (see M4.3 plan, Scope).
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