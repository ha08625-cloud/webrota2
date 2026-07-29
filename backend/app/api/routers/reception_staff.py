"""Reception staff router: plain CRUD (reception rota, Task 2).

DELETE is unconditionally a soft delete -- unlike doctors, there is no
committed-rota concept here to 409 against, so the blocking logic in
routers/doctors.py has no analogue. A deactivated staff member's existing
template and day rows are left untouched; the only effect is that future
template copies (Decision 6) skip inactive staff.

GET defaults to active-only but, unlike DoctorsPage, exposes an
include_inactive flag -- the reception staff list is the only management
surface here, so it must also offer a way back to reactivate someone.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...models import ReceptionStaff
from ..deps import get_current_user, get_db
from ..schemas import ReceptionStaffIn, ReceptionStaffOut, ReceptionStaffPatch

router = APIRouter(prefix="/reception/staff", tags=["reception"])


def _get_or_404(db: Session, staff_id: int) -> ReceptionStaff:
    staff = db.get(ReceptionStaff, staff_id)
    if staff is None:
        raise HTTPException(
            status_code=404, detail=f"Reception staff {staff_id} not found"
        )
    return staff


@router.get("", response_model=list[ReceptionStaffOut])
def list_staff(
    include_inactive: bool = False,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> list[ReceptionStaff]:
    stmt = select(ReceptionStaff).order_by(ReceptionStaff.code)
    if not include_inactive:
        stmt = stmt.where(ReceptionStaff.active.is_(True))
    return db.execute(stmt).scalars().all()


@router.post("", response_model=ReceptionStaffOut, status_code=201)
def create_staff(
    payload: ReceptionStaffIn,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ReceptionStaff:
    staff = ReceptionStaff(code=payload.code, name=payload.name, active=True)
    db.add(staff)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail=f"Reception staff code '{payload.code}' already exists",
        ) from exc
    db.refresh(staff)
    return staff


@router.patch("/{staff_id}", response_model=ReceptionStaffOut)
def patch_staff(
    staff_id: int,
    payload: ReceptionStaffPatch,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> ReceptionStaff:
    staff = _get_or_404(db, staff_id)
    fields = payload.model_fields_set
    if "code" in fields and payload.code is not None:
        staff.code = payload.code
    if "name" in fields and payload.name is not None:
        staff.name = payload.name
    if "active" in fields and payload.active is not None:
        staff.active = payload.active
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409, detail="Reception staff code already exists"
        ) from exc
    db.refresh(staff)
    return staff


@router.delete("/{staff_id}", status_code=204)
def deactivate_staff(
    staff_id: int,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
) -> None:
    staff = _get_or_404(db, staff_id)
    staff.active = False
    db.commit()
