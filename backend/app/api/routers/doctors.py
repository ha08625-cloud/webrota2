"""Doctor router.

DELETE is a soft delete (active=False). It returns 409 if the doctor has
sessions on a committed rota -- deactivating is fine, but the guard prevents
the frontend treating soft-delete as a data purge for doctors with history.
If the doctor only appears on the current draft, scrapping the draft first
is the correct path.

Counter invariant: every doctor row has exactly one SystemCounter row per
SystemCounterType (room_move, supervision), created here at doctor creation
regardless of doctor_type. Trainee/AHP rows sit unused at zero -- the cost
of a handful of dead rows buys a single unconditional invariant, closing
the PATCH edge case where a doctor's type changes to Partner/Salaried after
creation. `generate._write_counters` relies on this invariant via a strict
`.scalar_one()` and 500s the generation if it is ever violated. It has
been violated before, by doctor rows created before the invariant existed
-- seed/backfill_system_counters.py is the repair for that case.

Calendar-token invariant: every doctor row also has a unique, unguessable
`calendar_token` from creation, set here explicitly. It is the identifier of
that doctor's public .ics feed, so the feed route can look it up through the
unique index with no null branch. Unlike the counter invariant this one has
no history of being violated -- migration 007 backfills a token per existing
row and makes the column NOT NULL, so no database can hold a doctor without
one. The token is deliberately absent from DoctorOut/DoctorDetailOut: it
reaches the frontend only through the dedicated calendar-feed endpoint, so it
never travels in the rota grid's caches or the audit log's request bodies.

Token management (read the feed URL, rotate the token) lives here rather
than on the public calendar router, so it sits behind the ordinary session
gate. Rotation additionally carries `require_capability("user_admin")` on
top of that -- see its docstring.
"""
from __future__ import annotations

import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ...models import (
    Doctor,
    DoctorPreferredRoom,
    GeneratedRota,
    RotaSession,
    SystemCounter,
    User,
)
from ...models.enums import RotaStatus, SystemCounterType
from ..auth_utils import new_session_token
from ..deps import get_current_user, get_db, require_capability
from ..schemas import (
    CalendarFeedOut,
    DoctorDetailOut,
    DoctorIn,
    DoctorOut,
    DoctorPatch,
    PreferredRoomIn,
)
from .calendar import feed_path

router = APIRouter(prefix="/doctors", tags=["doctors"])


def _validate_window(
    start: datetime.date | None, end: datetime.date | None
) -> None:
    """Enforce start <= end on the employment window.

    Lives here rather than in a schema validator because a PATCH may supply
    only one end of the pair -- the check needs the merged post-update
    values, which only the router has.
    """
    if start is not None and end is not None and start > end:
        raise HTTPException(
            status_code=422, detail="start_date must not be after end_date"
        )


def _get_or_404(db: Session, doctor_id: int) -> Doctor:
    doctor = db.get(Doctor, doctor_id)
    if doctor is None:
        raise HTTPException(status_code=404, detail=f"Doctor {doctor_id} not found")
    return doctor


@router.get("", response_model=list[DoctorOut])
def list_doctors(
    active_only: bool = True,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[Doctor]:
    stmt = select(Doctor).order_by(Doctor.code)
    if active_only:
        stmt = stmt.where(Doctor.active.is_(True))
    return db.execute(stmt).scalars().all()


@router.post("", response_model=DoctorOut, status_code=201)
def create_doctor(
    payload: DoctorIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Doctor:
    _validate_window(payload.start_date, payload.end_date)
    doctor = Doctor(
        code=payload.code,
        doctor_type=payload.doctor_type,
        sessions_per_week=payload.sessions_per_week,
        supervision_preference=payload.supervision_preference,
        active=True,
        start_date=payload.start_date,
        end_date=payload.end_date,
        calendar_token=new_session_token(),
    )
    db.add(doctor)
    try:
        # Flush (rather than commit) first: it assigns doctor.id for the
        # counter rows below, and surfaces a duplicate-code IntegrityError
        # before any counter rows are staged.
        db.flush()
        for counter_type in (SystemCounterType.ROOM_MOVE, SystemCounterType.SUPERVISION):
            db.add(
                SystemCounter(
                    doctor_id=doctor.id, counter_type=counter_type, raw_count=0
                )
            )
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409, detail=f"Doctor code '{payload.code}' already exists"
        ) from exc
    db.refresh(doctor)
    return doctor


@router.get("/{doctor_id}", response_model=DoctorDetailOut)
def get_doctor(
    doctor_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Doctor:
    return _get_or_404(db, doctor_id)


@router.patch("/{doctor_id}", response_model=DoctorOut)
def patch_doctor(
    doctor_id: int,
    payload: DoctorPatch,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Doctor:
    doctor = _get_or_404(db, doctor_id)
    updates = payload.model_dump(exclude_unset=True)
    # Validate the window against the *merged* values: a PATCH setting only
    # start_date still has to sit before whatever end_date the row already
    # holds.
    _validate_window(
        updates.get("start_date", doctor.start_date),
        updates.get("end_date", doctor.end_date),
    )
    for field, value in updates.items():
        setattr(doctor, field, value)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409, detail="Doctor code already exists"
        ) from exc
    db.refresh(doctor)
    return doctor


@router.put("/{doctor_id}/preferred-rooms", response_model=DoctorDetailOut)
def replace_preferred_rooms(
    doctor_id: int,
    payload: list[PreferredRoomIn],
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Doctor:
    doctor = _get_or_404(db, doctor_id)
    # Replace-all pattern, but as two explicit statements rather than an
    # ORM collection reassignment. Assigning doctor.preferred_rooms = [...]
    # leaves the flush free to emit the INSERTs for the new rows before the
    # DELETEs for the old ones (nothing FK-links them), and the new rows
    # reuse the same (doctor_id, preference_order) values the old ones
    # still hold - tripping uq_dpr_doctor_order on essentially every edit.
    # Deleting first and flushing before inserting removes the race.
    db.execute(delete(DoctorPreferredRoom).where(DoctorPreferredRoom.doctor_id == doctor_id))
    db.flush()
    for p in payload:
        db.add(
            DoctorPreferredRoom(
                doctor_id=doctor_id,
                preference_order=p.preference_order,
                room_id=p.room_id,
                room_type=p.room_type,
            )
        )
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=409,
            detail="Duplicate preference_order or invalid room reference",
        ) from exc
    db.refresh(doctor)
    return doctor


def _feed_out(doctor: Doctor) -> CalendarFeedOut:
    return CalendarFeedOut(
        doctor_id=doctor.id,
        token=doctor.calendar_token,
        feed_path=feed_path(doctor.calendar_token),
    )


@router.get("/{doctor_id}/calendar-feed", response_model=CalendarFeedOut)
def get_calendar_feed(
    doctor_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> CalendarFeedOut:
    """The doctor's feed token and path, readable at every access tier.

    Deliberately not doctor-scoped: the feed is identified by its token, not
    by who is logged in, and every rota surface in the app is already
    readable at every tier. Any logged-in user picks a doctor from the
    calendar page and copies that doctor's URL. The token defends against
    outsiders, not against colleagues.
    """
    return _feed_out(_get_or_404(db, doctor_id))


@router.post("/{doctor_id}/calendar-feed/rotate", response_model=CalendarFeedOut)
def rotate_calendar_feed(
    doctor_id: int,
    db: Session = Depends(get_db),
    admin: User = Depends(require_capability("user_admin")),
) -> CalendarFeedOut:
    """Issue a fresh token, dead-ending the old URL. Needs `user_admin`.

    This router's `clinical` gate is not enough on its own: it admits every
    rota editor, and this is the revocation path for a doctor's calendar
    link -- user-administration business rather than routine data entry,
    and silently destructive, since the doctor's calendar simply stops
    updating with no error anywhere. So `user_admin` hangs off the endpoint
    on top of the router's area gate, and the effective rule is the
    conjunction: clinical:write AND user_admin. It is one of only two such
    conjunctions in the API (see deps.py).

    `test_authorization.py` lists this route as needing more than its area:
    its sweep otherwise asserts a rota editor gets past the gate on every
    non-GET clinical route.
    """
    doctor = _get_or_404(db, doctor_id)
    doctor.calendar_token = new_session_token()
    db.commit()
    db.refresh(doctor)
    return _feed_out(doctor)


@router.delete("/{doctor_id}", response_model=DoctorOut)
def soft_delete_doctor(
    doctor_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Doctor:
    doctor = _get_or_404(db, doctor_id)
    has_committed_sessions = db.execute(
        select(RotaSession.id)
        .join(GeneratedRota, RotaSession.rota_id == GeneratedRota.id)
        .where(
            RotaSession.doctor_id == doctor_id,
            GeneratedRota.status == RotaStatus.COMMITTED,
        )
        .limit(1)
    ).scalar_one_or_none()
    if has_committed_sessions is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Doctor {doctor_id} has sessions on a committed rota; "
                "set active=false via PATCH instead"
            ),
        )
    doctor.active = False
    db.commit()
    db.refresh(doctor)
    return doctor
