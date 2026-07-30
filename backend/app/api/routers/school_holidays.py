"""Schools and school holidays router: global planning data, purely
informational (see models/school.py). This is the only write path for the
`schools` and `school_holidays` tables.

Nested under /schools rather than a flat /school-holidays collection: the
read side is nested anyway (schools returned with their holidays), and a
flat write path would need its own school_id existence check for no gain.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from ...models.school import School, SchoolHoliday
from ..deps import get_current_user, get_db
from ..schemas import SchoolHolidayIn, SchoolHolidayOut, SchoolIn, SchoolOut

router = APIRouter(prefix="/schools", tags=["schools"])


def _get_school(db: Session, school_id: int) -> School:
    school = db.get(School, school_id)
    if school is None:
        raise HTTPException(status_code=404, detail=f"School {school_id} not found")
    return school


def _get_holiday(db: Session, school_id: int, holiday_id: int) -> SchoolHoliday:
    holiday = db.get(SchoolHoliday, holiday_id)
    if holiday is None or holiday.school_id != school_id:
        raise HTTPException(
            status_code=404,
            detail=f"Holiday {holiday_id} not found for school {school_id}",
        )
    return holiday


@router.get("", response_model=list[SchoolOut])
def list_schools(
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> list[School]:
    stmt = (
        select(School)
        .options(selectinload(School.holidays))
        .order_by(School.name)
    )
    return db.execute(stmt).scalars().all()


@router.post("", response_model=SchoolOut, status_code=201)
def create_school(
    payload: SchoolIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> School:
    school = School(name=payload.name)
    db.add(school)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409, detail=f"A school named '{payload.name}' already exists"
        ) from exc
    db.refresh(school)
    return school


@router.patch("/{school_id}", response_model=SchoolOut)
def rename_school(
    school_id: int,
    payload: SchoolIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> School:
    school = _get_school(db, school_id)
    school.name = payload.name
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409, detail=f"A school named '{payload.name}' already exists"
        ) from exc
    db.refresh(school)
    return school


@router.delete("/{school_id}", status_code=204)
def delete_school(
    school_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> None:
    school = _get_school(db, school_id)
    db.delete(school)
    db.commit()


@router.post("/{school_id}/holidays", response_model=SchoolHolidayOut, status_code=201)
def create_holiday(
    school_id: int,
    payload: SchoolHolidayIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> SchoolHoliday:
    _get_school(db, school_id)
    holiday = SchoolHoliday(
        school_id=school_id,
        start_date=payload.start_date,
        end_date=payload.end_date,
        name=payload.name,
    )
    db.add(holiday)
    db.commit()
    db.refresh(holiday)
    return holiday


@router.patch("/{school_id}/holidays/{holiday_id}", response_model=SchoolHolidayOut)
def update_holiday(
    school_id: int,
    holiday_id: int,
    payload: SchoolHolidayIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> SchoolHoliday:
    holiday = _get_holiday(db, school_id, holiday_id)
    holiday.start_date = payload.start_date
    holiday.end_date = payload.end_date
    holiday.name = payload.name
    db.commit()
    db.refresh(holiday)
    return holiday


@router.delete("/{school_id}/holidays/{holiday_id}", status_code=204)
def delete_holiday(
    school_id: int,
    holiday_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> None:
    holiday = _get_holiday(db, school_id, holiday_id)
    db.delete(holiday)
    db.commit()
