"""Extra sessions router: plan a doctor working a normally non-working
slot.

The override that turns a planned extra session into a working staged
slot happens once, at `POST /staging` creation time - this router only
owns the CRUD record of intent, not the override itself.

Weekday-only and blocked by existing leave are both checked here rather
than in the schema, since both need request context - the leave check
needs the DB - beyond what a bare Pydantic model can see. No bulk
endpoints: unlike leave's "every weekday in the range" semantics, a
single date plus period covers the real workflow here.
"""
from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...doctor_window import is_within_window, window_error_detail
from ...leave_entitlement import LEAVE_WEEKS_BY_DOCTOR_TYPE
from ...models import Doctor, ExtraSessionEntry, LeaveEntry, User
from ...models.enums import ExtraSessionCompensation
from ..deps import get_current_user, get_db
from ..schemas import ExtraSessionIn, ExtraSessionOut, ExtraSessionUpdateIn

router = APIRouter(prefix="/extra-sessions", tags=["extra-sessions"])

_WEEKDAY_MAX = 4  # Mon=0 ... Fri=4 (Python date.weekday())


def _check_toil_entitlement(
    doctor: Doctor, compensation: ExtraSessionCompensation
) -> None:
    """422 a TOIL session for a doctor type with no leave entitlement.

    TOIL credits a session to the doctor's annual leave, and AHPs, nurses and
    locums have no annual leave for it to land in (see
    `LEAVE_WEEKS_BY_DOCTOR_TYPE`). Recording it anyway and silently ignoring
    it in the balance is the quiet disagreement that module was written to
    avoid, so it is refused at the boundary -- the same treatment an
    entitlement override on an AHP already gets.
    """
    if (
        compensation is ExtraSessionCompensation.TOIL
        and doctor.doctor_type not in LEAVE_WEEKS_BY_DOCTOR_TYPE
    ):
        raise HTTPException(
            status_code=422,
            detail=(
                f"{doctor.doctor_type.value} doctors have no leave "
                "entitlement, so a session cannot be taken in lieu"
            ),
        )


@router.get("", response_model=list[ExtraSessionOut])
def list_extra_sessions(
    doctor_id: int | None = None,
    from_date: datetime.date | None = None,
    to_date: datetime.date | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
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
    user: User = Depends(get_current_user),
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

    # Outside the doctor's employment window: 422 here, since a
    # single-entry POST has nothing to partially succeed at. Ordered after
    # the weekend check so a date that is both reports the more specific
    # fact, matching /leave/bulk.
    if not is_within_window(doctor, payload.date):
        raise HTTPException(
            status_code=422, detail=window_error_detail(doctor, payload.date)
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

    # Last of the create checks, so a request failing more than one still
    # reports the most specific fact first.
    _check_toil_entitlement(doctor, payload.compensation)

    entry = ExtraSessionEntry(
        doctor_id=payload.doctor_id,
        date=payload.date,
        period=payload.period,
        compensation=payload.compensation,
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


@router.patch("/{entry_id}", response_model=ExtraSessionOut)
def update_extra_session(
    entry_id: int,
    payload: ExtraSessionUpdateIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ExtraSessionEntry:
    """Correct an existing extra session's compensation.

    Exists because every row predating the column reads as Payment and some
    of them were TOIL, and because "this one's going to be TOIL after all" is
    an ordinary edit -- delete-and-recreate is not an acceptable substitute
    once the planner has been printed. Nothing else on the row is editable
    here; the doctor is read from the row rather than the body, so the same
    entitlement rule as the POST applies to the doctor who actually holds it.
    """
    entry = db.get(ExtraSessionEntry, entry_id)
    if entry is None:
        raise HTTPException(
            status_code=404, detail=f"Extra session {entry_id} not found"
        )
    doctor = db.get(Doctor, entry.doctor_id)
    _check_toil_entitlement(doctor, payload.compensation)

    entry.compensation = payload.compensation
    db.commit()
    db.refresh(entry)
    return entry


@router.delete("/{entry_id}", status_code=204)
def delete_extra_session(
    entry_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    entry = db.get(ExtraSessionEntry, entry_id)
    if entry is None:
        raise HTTPException(
            status_code=404, detail=f"Extra session {entry_id} not found"
        )
    db.delete(entry)
    db.commit()